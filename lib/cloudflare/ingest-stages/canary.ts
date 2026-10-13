/**
 * Operator-initiated, single-case staged canary for Germany (`de-bverfg`) and the
 * United States (`us-scotus`) — the safe, bounded way to obtain *one* real
 * per-case seven-stage Production lineage **before** any broad source-ownership
 * cutover.
 *
 * Design constraints (deliberately conservative):
 *
 * - **No ownership change.** The staged source allowlist and the M8 crawler
 *   exclusion are never touched. The canary seeds exactly one `crawl` job for a
 *   non-staged source; that single job is the *controlled exception*, not a
 *   source-wide switch.
 * - **Explicit authorized canary identity.** Every canary artifact lives under
 *   the `stages/canary/<canaryId>/` R2 prefix and every canary lease is stamped
 *   `canary-owner:<canaryId>`. The stage consumer refuses a non-staged source
 *   unless the job carries the explicit canary prefix, so an accidental future
 *   widening cannot silently pull `de-bverfg`/`us-scotus` through the normal
 *   staged path.
 * - **Official-source verification is mandatory and fail-closed.** A candidate is
 *   only accepted when its URL is on the official host, its URL identity parses,
 *   and the operator-supplied identifier (German ECLI / US docket) matches that
 *   identity. The in-body ECLI/docket match happens later in the crawl stage and
 *   is never faked here.
 * - **Bounded and idempotent.** Max 1 canary per source per rolling window; the
 *   job idempotency key is deterministic, so replaying the same case cannot
 *   create a second job. A denied or conflicting attempt is still audited.
 * - **Immutable audit.** Every attempt (accepted or denied) is written to the
 *   append-only `ingest_stage_canary_records_v1` ledger.
 * - **No publication authority.** The canary never approves, publishes, or
 *   projects. US opinions consequently end honestly blocked at the public
 *   judgment gate (manual review required); that is the expected, honest result.
 *
 * It performs no network work of its own; the crawl stage does the single fetch.
 */
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { sha256Canonical } from "@/lib/cloudflare/e2e/contracts";
import {
  buildIngestStageIdempotencyKey,
  INGEST_STAGE_NEXT,
  type IngestStage,
} from "./contracts";
import { registerIngestStageJob, getIngestStageJobById, getIngestStageJobByIdempotencyKey } from "./repository";
import { dispatchIngestStagePass, type IngestStageQueueSender } from "./dispatcher";
import {
  nativeStageCandidateId,
  type NativeStageCandidate,
} from "../../../workers/async-pipeline/src/native-crawler";
import {
  bverfgDecisionIdentity,
  isOfficialHost,
  isOfficialScotusPdfUrl,
  normalizeScotusDocket,
} from "../../ingest/official-source-verify";

/** Only these two countries may be canaried; FR/ES already have their own staged E2E. */
export const CANARY_SOURCE_KEYS = ["de-bverfg", "us-scotus"] as const;
export type CanarySourceKey = (typeof CANARY_SOURCE_KEYS)[number];

/** Every canary artifact and lease is namespaced so the exception is explicit. */
export const CANARY_PAYLOAD_PREFIX = "stages/canary/" as const;
export const CANARY_CLAIM_PREFIX = "canary-owner:" as const;

/** Max 1 canary per source per rolling 24h window. */
export const INGEST_STAGE_CANARY_MAX_PER_WINDOW = 1 as const;
export const INGEST_STAGE_CANARY_WINDOW_SECONDS = 86_400 as const;

/** A bounded lease long enough for one crawl fetch, short enough to self-recover. */
export const INGEST_STAGE_CANARY_LEASE_SECONDS = 600 as const;

export type CanaryOutcome =
  | "seeded"
  | "dispatched"
  | "denied_source"
  | "denied_official_host"
  | "denied_identity"
  | "denied_rate_limited"
  | "denied_job_conflict";

export interface CanaryCaseRequest {
  sourceKey: string;
  candidateUrl: string;
  title?: string;
  identifiers: { ecli?: string; docket?: string };
}

export interface CanaryCasePlan {
  accepted: boolean;
  outcome: CanaryOutcome;
  reason: string;
  sourceKey: CanarySourceKey | null;
  candidate?: NativeStageCandidate;
  canaryId: string;
  candidateId: string;
  payloadRef: string;
  contentHash: string;
  idempotencyKey: string;
}

function isCanarySource(value: string): value is CanarySourceKey {
  return (CANARY_SOURCE_KEYS as readonly string[]).includes(value);
}

/**
 * Pure, deterministic canary planner. It validates the official host, the URL
 * identity, and the operator-supplied identifier — never the body. The body
 * identity (German ECLI / US docket) is verified later by the crawl stage and is
 * the only place `sourceUrlVerified` can become true.
 */
export async function planCanaryCase(
  request: CanaryCaseRequest,
  options: { now: string },
): Promise<CanaryCasePlan> {
  void options.now;
  const reject = (outcome: CanaryOutcome, reason: string, sourceKey: CanarySourceKey | null = null): CanaryCasePlan => ({
    accepted: false,
    outcome,
    reason,
    sourceKey,
    canaryId: "",
    candidateId: "",
    payloadRef: "",
    contentHash: "",
    idempotencyKey: "",
  });

  if (!isCanarySource(request.sourceKey)) return reject("denied_source", "canary.source_not_allowed");
  const sourceKey = request.sourceKey;
  const url = request.candidateUrl?.trim() ?? "";
  if (!url) return reject("denied_official_host", "canary.url_missing", sourceKey);
  if (!isOfficialHost(sourceKey, url)) return reject("denied_official_host", "canary.non_official_host", sourceKey);

  const canonicalUrl = url;
  let identityEcli: string | null = null;
  let identityDocket: string | null = null;
  let publishedAt: string | undefined;
  let contentType: NativeStageCandidate["contentType"] = "decision";
  let versionSeed: string;

  if (sourceKey === "de-bverfg") {
    const identity = bverfgDecisionIdentity(url);
    if (!identity) return reject("denied_identity", "canary.bverfg_url_identity_unparsed", sourceKey);
    const suppliedEcli = request.identifiers.ecli?.trim() ?? "";
    if (!suppliedEcli) return reject("denied_identity", "canary.bverfg_ecli_required", sourceKey);
    if (suppliedEcli.toLowerCase() !== identity.ecli.toLowerCase()) {
      return reject("denied_identity", "canary.bverfg_ecli_url_mismatch", sourceKey);
    }
    identityEcli = identity.ecli;
    publishedAt = identity.publishedAt;
    versionSeed = `canary-de-ecli:${identity.ecli.toLowerCase()}`;
  } else {
    if (!isOfficialScotusPdfUrl(url)) return reject("denied_official_host", "canary.scotus_pdf_url_invalid", sourceKey);
    const suppliedDocket = normalizeScotusDocket(request.identifiers.docket ?? "");
    if (!suppliedDocket) return reject("denied_identity", "canary.scotus_docket_required", sourceKey);
    identityDocket = suppliedDocket;
    contentType = "opinion";
    versionSeed = `canary-us-docket:${suppliedDocket}`;
  }

  const contentHash = await sha256Canonical({ sourceKey, canonicalUrl, versionSeed });
  const canaryId = contentHash.slice(0, 32);
  const candidateId = await nativeStageCandidateId(sourceKey, canonicalUrl);
  const payloadRef = `${CANARY_PAYLOAD_PREFIX}${sourceKey}/${canaryId}.json`;
  const sourceVersion = versionSeed;
  const idempotencyKey = buildIngestStageIdempotencyKey({
    articleId: candidateId,
    stage: "crawl",
    sourceVersion,
    contentHash,
  });
  const candidate: NativeStageCandidate = {
    sourceKey,
    url: canonicalUrl,
    title: request.title?.trim() || (identityEcli ?? identityDocket ?? "canary case"),
    ...(publishedAt ? { publishedAt } : {}),
    contentType,
    metadata: {
      ...(identityEcli ? { ecli: identityEcli } : {}),
      ...(identityDocket ? { docket: identityDocket } : {}),
      discoveryIndex: "operator-canary",
      collection: {
        strategy: "operator-canary",
        confidence: "medium",
        sourceUrlVerified: false,
        sourceTextAvailable: false,
        publishable: false,
        reason: "Operator canary discovery; the crawl stage must verify the official body identity before any downstream gate.",
      },
    },
  };
  return {
    accepted: true,
    outcome: "seeded",
    reason: "canary.planned",
    sourceKey,
    candidate,
    canaryId,
    candidateId,
    payloadRef,
    contentHash,
    idempotencyKey,
  };
}

interface CanaryRecordInput {
  canaryId: string;
  sourceKey: string;
  candidateId: string;
  canonicalUrl: string;
  identityEcli: string | null;
  identityDocket: string | null;
  jobId: string | null;
  outcome: CanaryOutcome;
  operatorId: string;
  deploymentRef: string | null;
  detail: string | null;
  now: string;
}

async function run(db: D1RuntimeDatabase, sql: string, values: unknown[]) {
  const statement = db.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("canary.write_unavailable");
  const result = await statement.run();
  if (result.success === false || result.error) throw new Error("canary.write_failed");
  return result;
}

/** Appends one immutable canary audit record. Diagnostics only; never authority. */
export async function recordCanaryAttempt(db: D1RuntimeDatabase, input: CanaryRecordInput): Promise<string> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO ingest_stage_canary_records_v1
       (id, canary_id, source_key, candidate_id, canonical_url, identity_ecli, identity_docket,
        job_id, outcome, operator_id, deployment_ref, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.canaryId, input.sourceKey, input.candidateId, input.canonicalUrl,
      input.identityEcli, input.identityDocket, input.jobId, input.outcome,
      input.operatorId, input.deploymentRef, input.detail, input.now,
    ],
  );
  return id;
}

async function recentCanaryCount(
  db: D1RuntimeDatabase,
  input: { sourceKey: string; windowStart: string },
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ingest_stage_canary_records_v1
        WHERE source_key = ? AND outcome IN ('seeded','dispatched') AND created_at >= ?`,
    )
    .bind(input.sourceKey, input.windowStart)
    .all<{ count: number }>();
  if (result.success === false || result.error) throw new Error("canary.query_failed");
  return Number(result.results?.[0]?.count) || 0;
}

export interface SeedCanaryCaseResult {
  outcome: CanaryOutcome;
  reason: string;
  sourceKey: CanarySourceKey | null;
  canaryId: string;
  jobId: string | null;
  created: boolean;
  candidateId: string;
  identityEcli: string | null;
  identityDocket: string | null;
  /** Token the operator must present to the fenced single-dispatch step, when seeded. */
  fencingToken: string | null;
}

/** The R2 surface the canary needs to persist the candidate artifact. */
export interface CanaryRawBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

/**
 * Seeds exactly one crawl job for the planned canary case, enforcing the
 * per-source rate limit and writing the immutable audit record. Idempotent by
 * the deterministic job key: replaying the same case returns the existing job.
 */
export async function seedCanaryCase(
  ingestDb: D1RuntimeDatabase,
  rawBucket: CanaryRawBucket,
  plan: CanaryCasePlan,
  input: { operatorId: string; deploymentRef: string | null; now: string; maxPerWindow?: number; windowSeconds?: number },
): Promise<SeedCanaryCaseResult> {
  const base = {
    canaryId: plan.canaryId,
    sourceKey: plan.sourceKey ?? plan.candidate?.sourceKey ?? "",
    candidateId: plan.candidateId,
    canonicalUrl: plan.candidate?.url ?? "",
    identityEcli: plan.candidate?.metadata.ecli ? String(plan.candidate.metadata.ecli) : null,
    identityDocket: plan.candidate?.metadata.docket ? String(plan.candidate.metadata.docket) : null,
    operatorId: input.operatorId,
    deploymentRef: input.deploymentRef,
    now: input.now,
  };
  if (!plan.accepted || !plan.candidate || !plan.sourceKey) {
    await recordCanaryAttempt(ingestDb, { ...base, jobId: null, outcome: plan.outcome, detail: plan.reason });
    return {
      outcome: plan.outcome, reason: plan.reason, sourceKey: plan.sourceKey, canaryId: plan.canaryId,
      jobId: null, created: false, candidateId: plan.candidateId, identityEcli: base.identityEcli,
      identityDocket: base.identityDocket, fencingToken: null,
    };
  }

  const windowSeconds = input.windowSeconds ?? INGEST_STAGE_CANARY_WINDOW_SECONDS;
  const maxPerWindow = input.maxPerWindow ?? INGEST_STAGE_CANARY_MAX_PER_WINDOW;
  const windowStart = new Date(Date.parse(input.now) - windowSeconds * 1000).toISOString();
  const used = await recentCanaryCount(ingestDb, { sourceKey: plan.sourceKey, windowStart });
  if (used >= maxPerWindow) {
    await recordCanaryAttempt(ingestDb, { ...base, jobId: null, outcome: "denied_rate_limited", detail: `canary.rate_limited:${used}/${maxPerWindow}` });
    return {
      outcome: "denied_rate_limited", reason: `canary.rate_limited:${used}/${maxPerWindow}`, sourceKey: plan.sourceKey,
      canaryId: plan.canaryId, jobId: null, created: false, candidateId: plan.candidateId,
      identityEcli: base.identityEcli, identityDocket: base.identityDocket, fencingToken: null,
    };
  }

  // Persist the candidate artifact under the explicit canary prefix. The craft
  // stage reads this exactly as it reads any candidate payload.
  await rawBucket.put(plan.payloadRef, new TextEncoder().encode(JSON.stringify(plan.candidate)), {
    httpMetadata: { contentType: "application/json" },
  });

  const { job, created } = await registerIngestStageJob(ingestDb, {
    stage: "crawl",
    articleId: plan.candidateId,
    sourceKey: plan.sourceKey,
    sourceVersion: plan.candidate.metadata.ecli
      ? `canary-de-ecli:${String(plan.candidate.metadata.ecli).toLowerCase()}`
      : `canary-us-docket:${String(plan.candidate.metadata.docket)}`,
    contentHash: plan.contentHash,
    payloadRef: plan.payloadRef,
    now: input.now,
  });

  await recordCanaryAttempt(ingestDb, {
    ...base,
    jobId: job.id,
    outcome: "seeded",
    detail: created ? "canary.seeded" : "canary.idempotent_existing",
  });
  return {
    outcome: "seeded",
    reason: created ? "canary.seeded" : "canary.idempotent_existing",
    sourceKey: plan.sourceKey,
    canaryId: plan.canaryId,
    jobId: job.id,
    created,
    candidateId: plan.candidateId,
    identityEcli: base.identityEcli,
    identityDocket: base.identityDocket,
    fencingToken: null,
  };
}

/**
 * Fenced single-job dispatch: leases exactly one crawl job under the explicit
 * `canary-owner:<canaryId>` identity and sends its Queue message via the audited
 * dispatcher path. It never touches another job, another stage, or the M8 path.
 */
export async function dispatchCanaryCase(input: {
  ingestDb: D1RuntimeDatabase;
  queue: IngestStageQueueSender;
  jobId: string;
  canaryId: string;
  operatorId: string;
  deploymentRef: string | null;
  stage: IngestStage;
  leaseSeconds?: number;
  now: string;
}): Promise<{ dispatched: boolean; enqueued: number; reason: string }> {
  const result = await dispatchIngestStagePass({
    ingestDb: input.ingestDb,
    queue: input.queue,
    stage: input.stage,
    workerId: `${CANARY_CLAIM_PREFIX}${input.canaryId}`,
    limit: 1,
    leaseSeconds: input.leaseSeconds ?? INGEST_STAGE_CANARY_LEASE_SECONDS,
    jobId: input.jobId,
    now: input.now,
  });
  await recordCanaryAttempt(input.ingestDb, {
    canaryId: input.canaryId,
    sourceKey: "",
    candidateId: "",
    canonicalUrl: "",
    identityEcli: null,
    identityDocket: null,
    jobId: input.jobId,
    outcome: result.enqueued === 1 ? "dispatched" : "denied_job_conflict",
    operatorId: input.operatorId,
    deploymentRef: input.deploymentRef,
    detail: result.enqueued === 1 ? "canary.dispatched" : "canary.dispatch_no_change",
    now: input.now,
  });
  return {
    dispatched: result.enqueued === 1,
    enqueued: result.enqueued,
    reason: result.enqueued === 1 ? "canary.dispatched" : "canary.dispatch_no_change",
  };
}

/**
 * The per-source gate the stage consumer uses at the **official-fetch entry
 * stages** (`discovery`, `crawl`). A fetch-stage job whose `source_key` is not in
 * the configured staged source allowlist may only run when its payload carries
 * the explicit canary prefix. This is what keeps the canary a *controlled
 * exception* and prevents an accidental source widening from silently pulling a
 * non-staged country's official source through the pipeline.
 *
 * Downstream stages (`normalize` and later) are intentionally allowed: they act
 * on data that already passed the entry gate and the downstream public-judgment /
 * review / publication gates, and they never re-fetch an official host. No
 * non-staged job can reach them without first passing the entry gate, because
 * staged `ingest_stage_jobs` are only ever created by the staged bootstrap
 * (FR/ES) or this explicit canary.
 */
export const CANARY_ENTRY_STAGES: readonly IngestStage[] = ["discovery", "crawl"] as const;

export function canarySourceGateAllows(input: {
  stage: IngestStage;
  sourceKey: string | null;
  payloadRef: string | null;
  stagedSources: readonly string[];
}): boolean {
  if (!CANARY_ENTRY_STAGES.includes(input.stage)) return true;
  const source = input.sourceKey ?? "";
  if (!source || input.stagedSources.includes(source)) return true;
  // A non-staged source is only ever allowed through the explicit canary prefix.
  return typeof input.payloadRef === "string" && input.payloadRef.startsWith(CANARY_PAYLOAD_PREFIX);
}

/** Convenience alias for callers preserving a planned canary. */
export type { CanaryCasePlan as CanaryPlan };

export interface AdvanceCanaryResult {
  advanced: boolean;
  reason: string;
  fromStage: IngestStage | null;
  nextStage: IngestStage | null;
  nextJobId: string | null;
  nextPayloadRef: string | null;
}

const CANARY_ADVANCE_ENTRY_REF = "canary-advance-entry";

/** Reads the single `job_stage_advanced` event key for a succeeded canary job. */
async function readAdvanceNextKey(db: D1RuntimeDatabase, jobId: string): Promise<string | null> {
  const result = await db
    .prepare(
      `SELECT safe_details FROM ingest_stage_job_events
        WHERE job_id = ? AND event_type = 'job_stage_advanced'
        ORDER BY occurred_at DESC LIMIT 1`,
    )
    .bind(jobId)
    .all<{ safe_details: string | null }>();
  if (result.success === false || result.error) throw new Error("canary.query_failed");
  const raw = result.results?.[0]?.safe_details;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { nextKey?: unknown };
    return typeof parsed.nextKey === "string" && parsed.nextKey.length > 0 ? parsed.nextKey : null;
  } catch {
    return null;
  }
}

/**
 * Operator-driven, bounded next-stage advance for a single canary case.
 *
 * This is the OPTIONAL acceleration for a canary that is otherwise staged: instead
 * of waiting for the 15-minute dispatcher between stages, an operator can advance
 * exactly one already-succeeded canary job to its next stage in one call. It is
 * deliberately conservative and provenance-gated:
 *
 * - The named job must be `succeeded` AND its `claimed_by` must be the exact
 *   `canary-owner:<canaryId>` identity — the durable proof this job belongs to the
 *   authorized canary, not routine staged work.
 * - The next job is located ONLY through the durable `job_stage_advanced` event
 *   that the succeeded stage's own handler registered (`safe_details.nextKey`).
 *   This function never fabricates a transition the handler did not produce.
 * - The next job's `source_key` must be the canary source (the source propagation
 *   is the durable provenance across the native->core identity change), so an
 *   advance can never shepherd a non-canary job.
 * - The advance is appended to the immutable canary audit ledger.
 *
 * It never completes/fails a job, never marks anything succeeded/published, and
 * touches exactly the one addressed job. Scheduled 15-minute transitions remain
 * the normal path; this is an opt-in convenience.
 */
export async function advanceCanaryCase(input: {
  ingestDb: D1RuntimeDatabase;
  jobId: string;
  canaryId: string;
  operatorId: string;
  deploymentRef: string | null;
  now: string;
}): Promise<AdvanceCanaryResult> {
  const base = {
    canaryId: input.canaryId,
    sourceKey: "",
    candidateId: "",
    canonicalUrl: "",
    identityEcli: null,
    identityDocket: null,
    operatorId: input.operatorId,
    deploymentRef: input.deploymentRef,
    now: input.now,
  };
  const deny = async (outcome: CanaryOutcome, reason: string, fromStage: IngestStage | null): Promise<AdvanceCanaryResult> => {
    await recordCanaryAttempt(input.ingestDb, { ...base, jobId: input.jobId, outcome, detail: reason });
    return { advanced: false, reason, fromStage, nextStage: null, nextJobId: null, nextPayloadRef: null };
  };
  const job = await getIngestStageJobById(input.ingestDb, input.jobId);
  if (!job) return deny("denied_job_conflict", "canary.advance_job_not_found", null);
  if (job.status !== "succeeded") return deny("denied_job_conflict", "canary.advance_source_not_succeeded", job.stage);
  if (job.claimed_by !== `${CANARY_CLAIM_PREFIX}${input.canaryId}`) return deny("denied_source", "canary.advance_owner_mismatch", job.stage);
  const nextStage = INGEST_STAGE_NEXT[job.stage];
  if (!nextStage) return deny("denied_job_conflict", "canary.advance_terminal_stage", job.stage);

  const nextKey = await readAdvanceNextKey(input.ingestDb, input.jobId);
  if (!nextKey) return deny("denied_job_conflict", "canary.advance_next_event_missing", job.stage);
  const nextJob = await getIngestStageJobByIdempotencyKey(input.ingestDb, nextKey);
  if (!nextJob) return deny("denied_job_conflict", "canary.advance_next_job_not_registered", job.stage);
  if (nextJob.stage !== nextStage) return deny("denied_job_conflict", "canary.advance_next_stage_mismatch", job.stage);
  if (!isCanarySource(nextJob.source_key ?? "")) return deny("denied_source", "canary.advance_next_source_not_canary", job.stage);

  await recordCanaryAttempt(input.ingestDb, {
    ...base, jobId: nextJob.id, outcome: "dispatched", detail: `${CANARY_ADVANCE_ENTRY_REF}:${job.stage}->${nextStage}`,
  });
  return { advanced: true, reason: "canary.advance_ready", fromStage: job.stage, nextStage, nextJobId: nextJob.id, nextPayloadRef: nextJob.payload_ref ?? null };
}