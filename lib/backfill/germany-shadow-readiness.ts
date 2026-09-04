import {
  CASE_CATALOG_GERMANY_HISTORY_FLAG,
  germanyBverfgYearScope,
} from "@/lib/backfill/germany-scope";
import {
  postgresBverfgShadowReadinessRepository,
  type BverfgShadowPolicyEvidence,
  type BverfgShadowReadinessRepository,
} from "@/lib/backfill/germany-shadow-readiness-repository";

const OFFICIAL_SCOPE_URL = "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html";
const ROBOTS_URL = "https://www.bundesverfassungsgericht.de/robots.txt";
const REQUIRED_REPLAY_FIELDS = [
  "sourceKey",
  "url",
  "canonicalUrl",
  "title",
  "publishedAt",
  "contentType",
  "text",
  "metadata",
] as const;

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function validTimestamp(value: string) {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function policyBlocking(policy: BverfgShadowPolicyEvidence, now: number) {
  const blocking: string[] = [];
  if (policy.sourceKey !== "de-bverfg") blocking.push("policy_source_mismatch");
  if (policy.officialScopeUrl !== OFFICIAL_SCOPE_URL) blocking.push("official_scope_url_mismatch");
  if (!policy.discoveryMethods.includes("external_index_dejure_paged_listing")) {
    blocking.push("dejure_discovery_method_missing");
  }
  if (!policy.authorityHosts.includes("www.bundesverfassungsgericht.de")) {
    blocking.push("official_authority_host_missing");
  }
  if (!policy.redirectHosts.includes("www.bverfg.de")) blocking.push("official_redirect_host_missing");
  if (!policy.externalIndexHosts.includes("dejure.org")) blocking.push("dejure_discovery_host_missing");
  if (policy.robotsUrl !== ROBOTS_URL) blocking.push("robots_url_mismatch");
  if (policy.licenseBasis !== "official-public-record") blocking.push("license_basis_unreviewed");
  if (policy.defaultTextAccessPolicy !== "metadata_only") blocking.push("first_canary_not_metadata_only");
  if (policy.allowRawSnapshot) blocking.push("raw_snapshot_must_be_disabled");
  if (policy.normalizeReplayPolicy !== "bounded_evidence") blocking.push("replay_policy_mismatch");
  if (REQUIRED_REPLAY_FIELDS.some((field) => !policy.boundedReplayFields.includes(field))) {
    blocking.push("bounded_replay_fields_incomplete");
  }
  if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) blocking.push("retention_days_invalid");
  if (policy.minRequestDelayMs < 30_000) blocking.push("request_delay_below_robots_requirement");
  if (policy.maxConcurrency !== 1) blocking.push("max_concurrency_must_be_one");
  if (!policy.reviewedBy || /owner_decision_required|pending|todo/i.test(policy.reviewedBy)) {
    blocking.push("named_owner_reviewer_missing");
  }
  if (!validTimestamp(policy.reviewedAt) || Date.parse(policy.reviewedAt) > now) blocking.push("reviewed_at_invalid");
  if (!validTimestamp(policy.reviewDueAt) || Date.parse(policy.reviewDueAt) <= now) {
    blocking.push("source_policy_review_overdue");
  }
  return blocking;
}

export async function verifyBverfgPrivateShadowReadiness(input: {
  year: number;
  policyVersion: string;
  environment?: Record<string, string | undefined>;
}, dependencies: {
  repository?: BverfgShadowReadinessRepository;
  now?: () => Date;
  currentYear?: number;
} = {}) {
  const now = (dependencies.now ?? (() => new Date()))();
  const scope = germanyBverfgYearScope(input.year, dependencies.currentYear ?? now.getUTCFullYear());
  const policyVersion = input.policyVersion.trim();
  if (!policyVersion || policyVersion.length > 120) throw new Error("bverfg_shadow_readiness.invalid_policy_version");
  const repository = dependencies.repository ?? postgresBverfgShadowReadinessRepository;
  const [policy, snapshots] = await Promise.all([
    repository.getPolicy(policyVersion),
    repository.listAnnualSnapshots(scope.scopeFrom, scope.scopeTo),
  ]);
  const blocking: string[] = [];
  if (!explicitTrue((input.environment ?? process.env)[CASE_CATALOG_GERMANY_HISTORY_FLAG])) {
    blocking.push("germany_history_flag_disabled");
  }
  if (!policy) blocking.push("immutable_source_policy_missing");
  else blocking.push(...policyBlocking(policy, now.getTime()));

  const matching = snapshots.filter((snapshot) => snapshot.sourcePolicyVersion === policyVersion);
  const matchingOpen = matching.filter((snapshot) => snapshot.status === "open");
  const conflictingOpen = snapshots.filter((snapshot) => (
    snapshot.status === "open" && snapshot.sourcePolicyVersion !== policyVersion
  ));
  if (matchingOpen.length > 1) blocking.push("multiple_matching_open_snapshots");
  if (conflictingOpen.length > 0) blocking.push("conflicting_open_snapshot");
  const completed = matching.find((snapshot) => (
    snapshot.status === "closed"
    && /^[0-9a-f]{64}$/.test(snapshot.manifestHash ?? "")
    && /^[0-9a-f]{64}$/.test(snapshot.enumerationManifestHash ?? "")
  ));
  const malformedClosed = matching.some((snapshot) => (
    snapshot.status === "closed"
    && (!/^[0-9a-f]{64}$/.test(snapshot.manifestHash ?? "")
      || !/^[0-9a-f]{64}$/.test(snapshot.enumerationManifestHash ?? ""))
  ));
  if (malformedClosed) blocking.push("closed_snapshot_evidence_invalid");

  const status = blocking.length > 0 ? "blocked" as const
    : matchingOpen.length > 0 ? "ready" as const
    : completed ? "complete" as const
    : "ready" as const;
  const resumeSnapshotId = matchingOpen[0]?.id ?? null;
  return {
    event: "bverfg_private_shadow_readiness_checked" as const,
    status,
    blocking: [...new Set(blocking)],
    sourceKey: "de-bverfg" as const,
    year: scope.year,
    scopeFrom: scope.scopeFrom,
    scopeTo: scope.scopeTo,
    policyVersion,
    ownerApprovalRecorded: Boolean(policy) && policyBlocking(policy as BverfgShadowPolicyEvidence, now.getTime()).length === 0,
    resumeSnapshotId,
    completedSnapshotId: completed?.id ?? null,
    nextAction: status === "blocked" ? "resolve_blocking_items"
      : status === "complete" ? "inspect_private_shadow_reconciliation"
      : resumeSnapshotId ? "resume_existing_private_shadow" : "open_private_shadow_snapshot",
    readOnly: true as const,
    productionWriteAuthorizedByThisCheck: false as const,
    publicCatalogEnabledByThisCheck: false as const,
    sourcePolicyApprovedByThisCheck: false as const,
    geminiCalls: 0 as const,
  };
}

export interface BverfgPrivateShadowWritePlan {
  snapshotId: string | null;
  openNewSnapshot: boolean;
  resumedExistingSnapshot: boolean;
  sealedInventory: boolean;
}

export function planBverfgPrivateShadowWrite(input: {
  readiness: Awaited<ReturnType<typeof verifyBverfgPrivateShadowReadiness>>;
  requestedSnapshotId?: string | null;
  allowOpenSnapshot: boolean;
  allowSealedSnapshot?: boolean;
}): BverfgPrivateShadowWritePlan {
  const { readiness } = input;
  const requestedSnapshotId = input.requestedSnapshotId ?? null;
  if (readiness.status === "blocked") {
    throw new Error(`bverfg_shadow_operation.blocked:${readiness.blocking.join(",")}`);
  }
  if (!readiness.ownerApprovalRecorded) {
    throw new Error("bverfg_shadow_operation.owner_approval_missing");
  }
  if (readiness.status === "complete") {
    if (!input.allowSealedSnapshot) {
      throw new Error("bverfg_shadow_operation.inventory_already_sealed");
    }
    if (!readiness.completedSnapshotId) {
      throw new Error("bverfg_shadow_operation.sealed_snapshot_missing");
    }
    if (requestedSnapshotId && requestedSnapshotId !== readiness.completedSnapshotId) {
      throw new Error("bverfg_shadow_operation.snapshot_mismatch");
    }
    return {
      snapshotId: readiness.completedSnapshotId,
      openNewSnapshot: false,
      resumedExistingSnapshot: false,
      sealedInventory: true,
    };
  }

  if (requestedSnapshotId) {
    if (!readiness.resumeSnapshotId) {
      throw new Error("bverfg_shadow_operation.requested_snapshot_not_open");
    }
    if (readiness.resumeSnapshotId !== requestedSnapshotId) {
      throw new Error("bverfg_shadow_operation.snapshot_mismatch");
    }
    return {
      snapshotId: requestedSnapshotId,
      openNewSnapshot: false,
      resumedExistingSnapshot: true,
      sealedInventory: false,
    };
  }

  if (readiness.resumeSnapshotId) {
    return {
      snapshotId: readiness.resumeSnapshotId,
      openNewSnapshot: false,
      resumedExistingSnapshot: true,
      sealedInventory: false,
    };
  }
  if (!input.allowOpenSnapshot) {
    throw new Error("bverfg_shadow_operation.open_snapshot_missing");
  }
  return {
    snapshotId: null,
    openNewSnapshot: true,
    resumedExistingSnapshot: false,
    sealedInventory: false,
  };
}
