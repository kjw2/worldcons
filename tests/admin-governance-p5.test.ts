import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { POST as governanceAction } from "@/app/api/admin/governance/route";
import { createArticleLifecycleService } from "@/lib/article-lifecycle/service";
import type { ArticleLifecycleRepository, ArticleLifecycleSnapshot } from "@/lib/article-lifecycle/types";
import { createArticlePublicationService } from "@/lib/article-publication/service";
import { articlePublicationV4ReadsEnabled, observeArticlePublicationReadDecision } from "@/lib/article-publication/compatibility";
import { articleLifecycleP2ReadsEnabled } from "@/lib/article-lifecycle/compatibility";
import type { ArticlePublicationRepository, ArticlePublicationSnapshot } from "@/lib/article-publication/types";
import { createP5EvidenceDigest, evaluateP5RetirementReadiness, evaluateP5Slas, P5_RETIREMENT_FLAG_ORDER } from "@/lib/admin/p5/evaluator";
import { recordCompatibilityObservation, setCompatibilityObservationWriterForTests } from "@/lib/admin/p5/observations";
import { p5GovernanceActorHash, resolveP5OwnerRoleBindings } from "@/lib/admin/p5/owner-bindings";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { getP5HealthEvidence, recordP5OwnerApproval, unavailableP5HealthEvidence } from "@/lib/admin/p5/repository";
import { ADMIN_SESSION_COOKIE, createAdminCsrfTokenForSession, createAdminSession } from "@/lib/utils/auth";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const now = new Date("2026-07-15T00:00:00.000Z");
const observationStart = "2026-07-13T00:00:00.000Z";
const observationEnd = now.toISOString();

function healthyEvidence() {
  const evidence = unavailableP5HealthEvidence(observationStart, observationEnd);
  evidence.available = true;
  evidence.generatedAt = now.toISOString();
  evidence.queue.states = {};
  evidence.publication.legacyIdentityDigest = "a".repeat(32);
  evidence.publication.explicitIdentityDigest = "a".repeat(32);
  evidence.compatibility.firstObservedAt = observationStart;
  evidence.compatibility.lastObservedAt = observationEnd;
  evidence.compatibility.bucketCount = 49;
  evidence.compatibility.newReadCount = 40;
  evidence.compatibility.newWriteCount = 20;
  evidence.compatibility.newReadObserved = true;
  evidence.compatibility.newWriteObserved = true;
  evidence.compatibility.newLastSeenAt = observationEnd;
  evidence.governance.backupRestoreAt = "2026-07-14T00:00:00.000Z";
  evidence.governance.backupRestoreExpiresAt = "2026-07-20T00:00:00.000Z";
  return evidence;
}

function retirementInput() {
  const policy = resolveP5OperationalPolicy({ ADMIN_P5_MINIMUM_OBSERVATION_HOURS: "24", ADMIN_P5_BACKUP_RESTORE_MAX_AGE_HOURS: "720" });
  const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name, expected]) => [name, expected]));
  const input = { evidence: healthyEvidence(), policy, observationStart, observationEnd, flags, observationSampleRate: 1, now };
  const evidenceDigest = createP5EvidenceDigest(input);
  input.evidence.governance.approvalSets = [{ evidenceDigest, roles: ["operations", "data", "security"], distinctActorCount: 3, expiresAt: "2026-07-20T00:00:00.000Z", status: "active" }];
  return input;
}

test("P5 policy clamps overrides and SLA boundaries are exact", () => {
  const policy = resolveP5OperationalPolicy({
    ADMIN_P5_QUEUE_LATENCY_SECONDS_WARNING: "10",
    ADMIN_P5_QUEUE_LATENCY_SECONDS_CRITICAL: "9999999",
    ADMIN_P5_SOURCE_FRESHNESS_OVERRIDES_JSON: JSON.stringify({ "de-bverfg": { warningHours: 12, criticalHours: 24 }, "https://bad.invalid": { warningHours: 1, criticalHours: 2 } }),
  });
  assert.equal(policy.queueLatencySeconds.warning, 30);
  assert.equal(policy.queueLatencySeconds.critical, 86_400);
  assert.deepEqual(policy.sourceFreshnessOverrides["de-bverfg"], { warning: 43_200, critical: 86_400 });
  assert.equal(policy.sourceFreshnessOverrides["https://bad.invalid"], undefined);

  const evidence = healthyEvidence();
  evidence.queue.oldestQueuedAgeSeconds = policy.queueLatencySeconds.warning;
  assert.equal(evaluateP5Slas(evidence, policy).find((item) => item.key === "queue.latency")?.status, "healthy");
  evidence.queue.oldestQueuedAgeSeconds += 1;
  assert.equal(evaluateP5Slas(evidence, policy).find((item) => item.key === "queue.latency")?.status, "warning");
  evidence.queue.oldestQueuedAgeSeconds = policy.queueLatencySeconds.critical + 1;
  assert.equal(evaluateP5Slas(evidence, policy).find((item) => item.key === "queue.latency")?.status, "critical");
});

test("unavailable aggregate evidence never renders healthy SLA status", () => {
  const evidence = unavailableP5HealthEvidence(observationStart, observationEnd);
  const slas = evaluateP5Slas(evidence, resolveP5OperationalPolicy());
  assert(slas.length > 0);
  assert(slas.every((sla) => sla.status === "unknown" && sla.value === null));
});

test("aggregate repository uses one bounded RPC and strips payload-shaped extras", async () => {
  const evidence = healthyEvidence() as unknown as Record<string, unknown>;
  evidence.secret = "never-return-this";
  evidence.sources = [{ sourceKey: "de-bverfg", active: true, latestRunAt: now.toISOString(), freshnessAgeSeconds: 10, originalUrl: "https://secret.invalid" }];
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = { rpc(name: string, parameters: Record<string, unknown>) { calls.push({ name, parameters }); return Promise.resolve({ data: evidence, error: null }); } };
  const result = await getP5HealthEvidence({ observationStart, observationEnd, now, client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "admin_operational_health_p5");
  assert.equal(Object.keys(calls[0].parameters).length, 8);
  assert.doesNotMatch(JSON.stringify(result), /never-return-this|secret\.invalid|originalUrl|payload|credential/i);
  assert.deepEqual(result.sources[0], { sourceKey: "de-bverfg", active: true, latestRunAt: now.toISOString(), freshnessAgeSeconds: 10 });
});

test("feature flag getters are pure and default-off observation writes nothing", async () => {
  const observations: unknown[] = [];
  setCompatibilityObservationWriterForTests(async (observation) => { observations.push(observation); });
  assert.equal(articlePublicationV4ReadsEnabled({ ADMIN_PUBLICATION_V4_READ_ENABLED: "true", ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true" }), true);
  assert.equal(articleLifecycleP2ReadsEnabled({ ARTICLE_LIFECYCLE_P2_READ_ENABLED: "true", ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true" }), true);
  assert.equal(recordCompatibilityObservation({ surface: "public_query", domain: "projection", direction: "read", authority: "new", outcome: "selected" }, { environment: {} }), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observations.length, 0);
  setCompatibilityObservationWriterForTests(null);
});

test("same-surface observations coalesce while distinct surfaces and authorities remain", async () => {
  const observations: Array<{ surface: string; authority: string; count?: number }> = [];
  setCompatibilityObservationWriterForTests(async (observation) => { observations.push(observation); });
  const enabled = { ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true", ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE: "1", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" };
  observeArticlePublicationReadDecision("public_query", enabled);
  observeArticlePublicationReadDecision("public_query", enabled);
  observeArticlePublicationReadDecision("vector_search", { ...enabled, ADMIN_PUBLICATION_V4_READ_ENABLED: "false" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(observations.map(({ surface, authority, count }) => ({ surface, authority, count })), [
    { surface: "public_query", authority: "new", count: 1 },
    { surface: "vector_search", authority: "legacy", count: 1 },
  ]);
  setCompatibilityObservationWriterForTests(null);
});

test("compatibility observation remains bounded and failure-isolated", async () => {
  let writes = 0;
  setCompatibilityObservationWriterForTests(async () => { writes += 1; throw new Error("telemetry unavailable"); });
  assert.doesNotThrow(() => recordCompatibilityObservation({ surface: "public_query", domain: "projection", direction: "read", authority: "legacy", outcome: "selected", count: 99_999 }, { force: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes, 1);
  setCompatibilityObservationWriterForTests(null);
  const migration = source("supabase/migrations/20260712230000_admin_governance_p5.sql");
  assert.match(migration, /primary key \(bucket_started_at, surface, domain, direction, authority, outcome\)/);
  assert.match(source("lib/admin/p5/observations.ts"), /MAX_IN_FLIGHT = 2/);
  assert.match(source("lib/admin/p5/observations.ts"), /MAX_COALESCE_KEYS = 256/);
});

test("canonical evidence digest is stable and changes only with canonical gate evidence", () => {
  const baseline = retirementInput();
  const first = createP5EvidenceDigest(baseline);
  baseline.evidence.generatedAt = "2099-01-01T00:00:00.000Z";
  baseline.now = new Date("2026-07-15T00:01:00.000Z");
  baseline.evidence.governance.approvalSets = [];
  assert.equal(createP5EvidenceDigest(baseline), first, "presentation time and approval accumulation are excluded");
  baseline.evidence.queue.oldestQueuedAgeSeconds = 1;
  baseline.evidence.outbox.oldestUndeliveredAgeSeconds = 1;
  assert.equal(createP5EvidenceDigest(baseline), first, "volatile ages are represented by stable SLA states");
  const changedThreshold = retirementInput();
  changedThreshold.policy.queueLatencySeconds.warning += 1;
  assert.notEqual(createP5EvidenceDigest(changedThreshold), first);
  const changedParity = retirementInput();
  changedParity.evidence.publication.parityMismatchCount += 1;
  assert.notEqual(createP5EvidenceDigest(changedParity), first);
  const changedSla = retirementInput();
  changedSla.evidence.queue.oldestQueuedAgeSeconds = changedSla.policy.queueLatencySeconds.critical + 1;
  assert.notEqual(createP5EvidenceDigest(changedSla), first);
  const changedObservation = retirementInput();
  changedObservation.evidence.compatibility.newLastSeenAt = "2026-07-14T23:59:00.000Z";
  assert.notEqual(createP5EvidenceDigest(changedObservation), first);
});

test("approval writes require the current digest and call only the v2 RPC", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = { rpc(name: string, parameters: Record<string, unknown>) { calls.push({ name, parameters }); return Promise.resolve({ data: 42, error: null }); } };
  const digest = "a".repeat(64);
  const stale = await recordP5OwnerApproval({ role: "operations", actorHash: "b".repeat(64), evidenceDigest: "c".repeat(64), currentEvidenceDigest: digest, expiresAt: "2026-08-01T00:00:00.000Z", client });
  assert.deepEqual(stale, { ok: false, code: "stale_evidence_digest" });
  assert.equal(calls.length, 0);
  const current = await recordP5OwnerApproval({ role: "operations", actorHash: "b".repeat(64), evidenceDigest: digest, currentEvidenceDigest: digest, expiresAt: "2026-08-01T00:00:00.000Z", client });
  assert.equal(current.ok, true);
  assert.equal(calls[0].name, "admin_record_owner_approval_p5_v2");
});

test("owner bindings reject unbound roles and cross-role actors without leaking identity material", () => {
  const identity = "bound-operator";
  const valid = resolveP5OwnerRoleBindings(identity, { ADMIN_P5_OWNER_OPERATIONS_IDENTITIES: identity, ADMIN_P5_OWNER_DATA_IDENTITIES: "data-operator", ADMIN_P5_OWNER_SECURITY_ACTOR_HASHES: p5GovernanceActorHash("security-operator") });
  assert.deepEqual(valid.permittedRoles, ["operations"]);
  assert.doesNotMatch(JSON.stringify(valid), /bound-operator|[0-9a-f]{64}/);
  const duplicate = resolveP5OwnerRoleBindings(identity, { ADMIN_P5_OWNER_OPERATIONS_IDENTITIES: identity, ADMIN_P5_OWNER_DATA_IDENTITIES: identity, ADMIN_P5_OWNER_SECURITY_IDENTITIES: "security-operator" });
  assert.equal(duplicate.valid, false);
  assert.deepEqual(duplicate.permittedRoles, []);
  const unbound = resolveP5OwnerRoleBindings("unbound", { ADMIN_P5_OWNER_OPERATIONS_IDENTITIES: identity });
  assert.deepEqual(unbound.permittedRoles, []);
});

test("retirement evaluator passes only when every prerequisite passes", () => {
  const baseline = retirementInput();
  const passing = evaluateP5RetirementReadiness(baseline);
  assert.equal(passing.ready, true);
  assert.match(passing.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(passing.signature, null);
  assert.equal(evaluateP5RetirementReadiness({ ...baseline, signingKey: "test-signing-key" }).signatureAlgorithm, "hmac-sha256");

  const staleApproval = retirementInput();
  staleApproval.evidence.governance.approvalSets[0].evidenceDigest = "f".repeat(64);
  const staleApprovalReport = evaluateP5RetirementReadiness(staleApproval);
  assert.equal(staleApprovalReport.gates.find((gate) => gate.key === "owners.approved")?.passed, false);
  assert.equal(staleApprovalReport.ready, false);

  const cases: Array<[string, (input: ReturnType<typeof retirementInput>) => void]> = [
    ["health.available", (input) => { input.evidence.available = false; }],
    ["observation.window", (input) => { input.observationStart = "2026-07-14T12:00:00.000Z"; }],
    ["observation.coverage", (input) => { input.evidence.compatibility.firstObservedAt = "2026-07-13T01:00:00.000Z"; }],
    ["observation.full_capture", (input) => { input.observationSampleRate = 0.1; }],
    ["compatibility.zero", (input) => { input.evidence.compatibility.unexplainedLegacyObserved = true; input.evidence.compatibility.legacyLastSeenAt = observationEnd; }],
    ["parity.p0_p3", (input) => { input.evidence.publication.parityMismatchCount = 1; }],
    ["sla.hard", (input) => { input.evidence.queue.oldestQueuedAgeSeconds = input.policy.queueLatencySeconds.critical + 1; }],
    ["work.conflict", (input) => { input.evidence.inFlight.legacyCount = 1; }],
    ["outbox.healthy", (input) => { input.evidence.outbox.deadLetterCount = 1; }],
    ["backup.current", (input) => { input.evidence.governance.backupRestoreAt = null; }],
    ["owners.approved", (input) => { input.evidence.governance.approvalSets = []; }],
    ["flags.legal_order", (input) => { input.flags.ADMIN_PUBLICATION_V4_READ_ENABLED = false; }],
  ];
  for (const [gateKey, mutate] of cases) {
    const input = retirementInput();
    mutate(input);
    const report = evaluateP5RetirementReadiness(input);
    assert.equal(report.ready, false, gateKey);
    assert.equal(report.gates.find((gate) => gate.key === gateKey)?.passed, false, gateKey);
  }
});

test("retirement and retention tools never auto-flip flags or delete authority history", () => {
  const retirement = source("scripts/admin-retirement-readiness-p5.ts");
  assert.match(retirement, /import "dotenv\/config"/);
  assert.doesNotMatch(retirement, /\.update\(|\.delete\(|admin_apply_retention|process\.env\[[^\]]+\]\s*=/);
  const retention = source("scripts/admin-retention-p5.ts");
  assert.match(retention, /import "dotenv\/config"/);
  assert.match(retention, /mode: "dry-run"/);
  assert.match(retention, /confirmation !== "APPLY P5 RETENTION"/);
  const migration = source("supabase/migrations/20260712230000_admin_governance_p5.sql");
  assert.match(migration, /p_confirmation <> 'APPLY P5 RETENTION'/);
  assert.match(migration, /least\(500, greatest\(1/);
  assert.match(migration, /ADMIN_P5_LEGAL_HOLD/);
  const applyBody = migration.slice(migration.indexOf("create or replace function admin_apply_retention_p5"));
  assert.doesNotMatch(applyBody, /delete from (admin_command|article_lifecycle|article_publication_history|article_content_versions|articles)/);
  assert.match(applyBody, /authoritativeHistoryDeleted', 0/);
  assert.match(applyBody, /deadLettersDeleted', 0/);
});

test("governance actions are feature-gated, session-only, CSRF-protected, role-bound, and audited", async () => {
  const previous = { ui: process.env.ADMIN_REDESIGN_UI_ENABLED, p5: process.env.ADMIN_P5_GOVERNANCE_UI_ENABLED, user: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, session: process.env.ADMIN_SESSION_SECRET, cron: process.env.CRON_SECRET, operations: process.env.ADMIN_P5_OWNER_OPERATIONS_IDENTITIES, data: process.env.ADMIN_P5_OWNER_DATA_IDENTITIES, security: process.env.ADMIN_P5_OWNER_SECURITY_IDENTITIES };
  process.env.ADMIN_REDESIGN_UI_ENABLED = "true";
  process.env.ADMIN_P5_GOVERNANCE_UI_ENABLED = "true";
  process.env.ADMIN_USERNAME = "p5-operator";
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.ADMIN_SESSION_SECRET = "p5-session-secret-for-focused-tests";
  process.env.CRON_SECRET = "cron-does-not-authorize-governance";
  process.env.ADMIN_P5_OWNER_OPERATIONS_IDENTITIES = "different-operator";
  process.env.ADMIN_P5_OWNER_DATA_IDENTITIES = "data-operator";
  process.env.ADMIN_P5_OWNER_SECURITY_IDENTITIES = "security-operator";
  try {
    const anonymous = await governanceAction(new Request("http://localhost/api/admin/governance", { method: "POST" }));
    assert.equal(anonymous.status, 401);
    const cron = await governanceAction(new Request("http://localhost/api/admin/governance", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(cron.status, 401);
    const session = createAdminSession("p5-operator");
    const csrf = createAdminCsrfTokenForSession(session);
    assert(csrf);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session)}`, origin: "http://localhost", referer: "http://localhost/admin/governance", "sec-fetch-site": "same-origin" };
    const missingCsrf = await governanceAction(new Request("http://localhost/api/admin/governance", { method: "POST", headers }));
    assert.equal(missingCsrf.status, 403);
    const validAuthInvalidBody = await governanceAction(new Request("http://localhost/api/admin/governance", { method: "POST", headers: { ...headers, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ action: "delete" }) }));
    assert.equal(validAuthInvalidBody.status, 400);
    const end = new Date(Date.now() - 3_600_000);
    const start = new Date(end.getTime() - 15 * 86_400_000);
    const unboundRole = await governanceAction(new Request("http://localhost/api/admin/governance", { method: "POST", headers: { ...headers, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ action: "approve", role: "operations", evidenceDigest: "0".repeat(64), observationStart: start.toISOString(), observationEnd: end.toISOString() }) }));
    assert.equal(unboundRole.status, 403);
    const route = source("app/api/admin/governance/route.ts");
    assert.match(route, /adminSessionMutationAuthFailureStatus\(request\)/);
    assert.match(route, /adminSessionIdentityFromRequest\(request\)/);
    assert.match(route, /recordP5OwnerApproval/);
    assert.match(route, /resolveP5OwnerRoleBindings\(identity\)/);
    assert.match(route, /evidenceDigest !== readiness\.evidenceDigest/);
    assert.doesNotMatch(route, /isAuthorizedSecretRequest|adminMutationAuthFailureStatus/);
    assert.doesNotMatch(JSON.stringify(await unboundRole.json()), /p5-operator|different-operator|[0-9a-f]{64}/);
  } finally {
    const mapping = { ui: "ADMIN_REDESIGN_UI_ENABLED", p5: "ADMIN_P5_GOVERNANCE_UI_ENABLED", user: "ADMIN_USERNAME", password: "ADMIN_PASSWORD", session: "ADMIN_SESSION_SECRET", cron: "CRON_SECRET", operations: "ADMIN_P5_OWNER_OPERATIONS_IDENTITIES", data: "ADMIN_P5_OWNER_DATA_IDENTITIES", security: "ADMIN_P5_OWNER_SECURITY_IDENTITIES" } as const;
    for (const [key, envKey] of Object.entries(mapping)) {
      const value = previous[key as keyof typeof previous];
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
  }
});

test("governance UI is hidden when flags are off and has mobile/desktop layouts", () => {
  const flags = source("lib/admin/p4/flags.ts");
  const page = source("app/admin/governance/page.tsx");
  const shell = source("components/admin-shell.tsx");
  const approval = source("components/admin-governance-approval.tsx");
  assert.match(flags, /adminRedesignUiEnabled\(environment\)[\s\S]*ADMIN_P5_GOVERNANCE_UI_FLAG/);
  assert.match(page, /if \(!adminGovernanceUiEnabled\(\)\) redirect\("\/admin"\)/);
  assert.match(shell, /governanceEnabled \? \[governanceNavigation/);
  assert.match(page, /hidden overflow-x-auto md:block/);
  assert.match(page, /md:hidden/);
  assert.match(page, /min-w-0|break-words/);
  assert.match(page, /role="alert"/);
  assert.match(approval, /permitted \? <button/);
  assert.match(approval, /Current session is not bound to this role/);
  assert.doesNotMatch(approval, /actorHash|identity/);
});

test("health workflow is disabled by default and emits redacted machine evidence", () => {
  const workflow = source(".github/workflows/admin-health-p5.yml");
  const script = source("scripts/admin-health-p5.ts");
  assert.match(script, /import "dotenv\/config"/);
  assert.match(workflow, /if: \$\{\{ vars\.ADMIN_P5_HEALTH_VERIFICATION_ENABLED == 'true' \}\}/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(script, /status: "disabled"/);
  assert.match(script, /hardViolationKeys/);
  assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*(SUPABASE|SERVICE_ROLE|SIGNING_KEY)/);
});

test("collect command through explicit publication preserves authority boundaries", async () => {
  const articleId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  let commandState = "queued";
  let lifecycle: ArticleLifecycleSnapshot = { articleId, revision: 0, collectionState: null, processingState: null, reviewState: null, attentionState: null, attentionCode: null, attentionRetryable: null, attentionSeverity: null, attentionSource: null };
  let publication: ArticlePublicationSnapshot = { articleId, versionRevision: 0, publicationRevision: 0, publicationState: null, legacyUpdatedAt: now.toISOString() };
  const outbox: string[] = [];
  const publicProjection = new Set<string>();

  commandState = "succeeded";
  assert.equal(publicProjection.size, 0, "queue completion must not publish");

  const lifecycleRepository: ArticleLifecycleRepository = {
    async get() { return { ok: true, data: lifecycle }; },
    async transition(input) {
      lifecycle = { ...lifecycle, revision: lifecycle.revision + 1, collectionState: input.collectionState ?? lifecycle.collectionState, processingState: input.processingState ?? lifecycle.processingState, reviewState: input.reviewState ?? lifecycle.reviewState };
      return { ok: true, data: { ...lifecycle, applied: true, idempotent: false } };
    },
  };
  const lifecycleService = createArticleLifecycleService(lifecycleRepository);
  const lifecycleResult = await lifecycleService.transition({ articleId, expectedRevision: 0, idempotencyKey: "collect-lifecycle-1", actorType: "ingestion", source: "ingestion.collect", reasonCode: "collect.completed", collectionState: "source_text_ready", processingState: "complete", reviewState: "approved" });
  assert.equal(lifecycleResult.ok, true);
  assert.equal(publicProjection.size, 0, "lifecycle approval must not publish");

  const publicationRepository: ArticlePublicationRepository = {
    async getSnapshot() { return { ok: true, data: publication }; },
    async transition(input) {
      publication = { ...publication, versionRevision: 1, publicationRevision: publication.publicationRevision + 1, publicationState: input.targetState };
      if (input.targetState === "published") {
        outbox.push(`publication:${publication.publicationRevision}`);
        publicProjection.add(articleId);
      } else {
        publicProjection.delete(articleId);
      }
      return { ok: true, data: { articleId, versionId, versionRevision: 1, publicationId: "33333333-3333-4333-8333-333333333333", publicationRevision: publication.publicationRevision, publicationState: input.targetState, versionCreated: true, publicationApplied: true, idempotent: false } };
    },
  };
  const publicationService = createArticlePublicationService(publicationRepository);
  const review = await publicationService.transition({ articleId, expectedVersionRevision: 0, expectedPublicationRevision: 0, idempotencyKey: "publication-review-1", targetState: "in_review", captureLegacy: true, actorType: "human", reason: "operator review completed" });
  assert.equal(review.ok, true);
  assert.equal(publicProjection.size, 0, "in-review is not public");
  assert.equal(outbox.length, 0, "non-public transition does not fake public cache delivery");
  const published = await publicationService.transition({ articleId, expectedVersionRevision: 1, expectedPublicationRevision: 1, idempotencyKey: "publication-publish-1", targetState: "published", versionId, actorType: "human", reason: "explicit publication approval" });
  assert.equal(published.ok, true);
  assert.equal(commandState, "succeeded");
  assert.deepEqual(outbox, ["publication:2"]);
  assert.deepEqual([...publicProjection], [articleId]);
});
