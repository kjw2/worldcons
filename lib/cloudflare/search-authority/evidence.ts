import crypto from "node:crypto";

/**
 * M7.8-A content-free evidence contract (operator-only).
 *
 * The rollout evidence is counts, ids, hashes, booleans and states only. It must
 * NEVER carry a vector, article text, a summary, a URL or a query. This module
 * defines the artifact paths, the evidence shape, a recursive content-free guard
 * and the markdown renderer. `buildSemanticAuthorityEvidence` asserts the guard
 * before returning, so a report that leaks forbidden content cannot be written.
 */

export const SEMANTIC_AUTHORITY_EVIDENCE_VERSION = 1 as const;

export const SEMANTIC_AUTHORITY_EVIDENCE_PATH =
  "artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.json" as const;
export const SEMANTIC_AUTHORITY_EVIDENCE_MARKDOWN_PATH =
  "artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.md" as const;

/** Normalized keys that may never appear in evidence. */
export const FORBIDDEN_EVIDENCE_KEYS = [
  "embedding",
  "vector",
  "rawtext",
  "cleanedtext",
  "summary",
  "summaryjson",
  "originalurl",
  "canonicalurl",
  "searchvector",
  "query",
  "queryembedding",
  "text",
  "body",
  "content",
  "originaltitle",
  "koreantitle",
] as const;

/** Maximum accepted string length in evidence (long strings are document text). */
export const EVIDENCE_MAX_STRING_LENGTH = 1024;

/** Numeric arrays of at least this length are treated as leaked vectors. */
export const EVIDENCE_VECTOR_LENGTH_THRESHOLD = 8;

export const SEMANTIC_AUTHORITY_EVIDENCE_BOUNDARIES = [
  "code/local verification only: no remote migration was applied by this evidence",
  "apply, when used, executes only the exact pinned forward-migration bytes through supabase db query --linked",
  "record-history only reconciles the remote migration ledger with supabase migration repair --linked --status applied AFTER a validated exact-SQL apply; it is never the schema-apply mechanism and is never run in preflight",
  "finalize-existing is read-only: it verifies an already-applied schema+ledger state, never executes migration SQL and never runs migration repair; its only writes are the local evidence files",
  "content-free: no vector, article text, summary, URL or query is present",
  "Supabase remains the sole production search/read authority; SearchRepository, GO-SEARCH, DNS and traffic are unchanged",
  "the staged rollback candidate lives outside supabase/migrations and is never applied or moved; a failed history repair never rolls the schema back automatically",
] as const;

export const EVIDENCE_GUARD_ERROR_CODES = [
  "forbidden_key",
  "forbidden_url",
  "forbidden_text",
  "forbidden_vector",
] as const;

export type EvidenceGuardErrorCode = (typeof EVIDENCE_GUARD_ERROR_CODES)[number];

export class EvidenceGuardError extends Error {
  readonly code: EvidenceGuardErrorCode;

  constructor(code: EvidenceGuardErrorCode, message: string) {
    super(message);
    this.name = "EvidenceGuardError";
    this.code = code;
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** True when a string is an absolute URL. */
export function isEvidenceUrl(value: string): boolean {
  return /https?:\/\/|^\/\//iu.test(value);
}

/** True when a numeric array is long enough to be a leaked embedding. */
export function isEvidenceVector(value: readonly unknown[]): boolean {
  if (value.length < EVIDENCE_VECTOR_LENGTH_THRESHOLD) return false;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * Recursively asserts that a value contains no vector, URL or long text and that
 * no object key is forbidden. Throws `EvidenceGuardError` rather than echoing the
 * offending value, so the guard itself cannot leak content into a log.
 */
export function assertContentFreeEvidence(value: unknown, pointer = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (isEvidenceUrl(value)) {
      throw new EvidenceGuardError("forbidden_url", `a URL is present at ${pointer}`);
    }
    if (value.length > EVIDENCE_MAX_STRING_LENGTH) {
      throw new EvidenceGuardError("forbidden_text", `an over-long text value is present at ${pointer}`);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (isEvidenceVector(value)) {
      throw new EvidenceGuardError("forbidden_vector", `a vector-like numeric array is present at ${pointer}`);
    }
    value.forEach((entry, index) => assertContentFreeEvidence(entry, `${pointer}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_EVIDENCE_KEYS as readonly string[]).includes(normalizeKey(key))) {
        throw new EvidenceGuardError("forbidden_key", `a forbidden evidence key is present at ${pointer}`);
      }
      assertContentFreeEvidence(entry, `${pointer}.${key}`);
    }
  }
}

export interface SemanticAuthorityEvidenceMigration {
  version: string;
  path: string;
  sha256: string;
  sqlBytes: number;
}

export interface SemanticAuthorityEvidenceIdentity {
  projectRef: string;
  projectName: string;
}

export interface SemanticAuthorityEvidenceInventory {
  targetVersion: string;
  pendingVersions: string[];
  targetAbsent: boolean;
  pendingSetExact: boolean;
  crossCheckReliable: boolean;
}

export interface SemanticAuthorityEvidencePreflight {
  mode: "preflight";
  ok: boolean;
  checks: string[];
  blockers: string[];
}

export interface SemanticAuthorityEvidenceBaseline {
  allowLiveBaseline: boolean;
  currentPublishedRows: number;
  projectionRows: number;
  projectionEmbeddingNullCount: number;
  artifactBackedCurrentPublishedRows: number;
  legacyVersionEmbeddingOnlyCount: number;
  totalMismatchCount: number;
}

export interface SemanticAuthorityEvidenceProjectionIdentity {
  count: number;
  digest: string;
}

export interface SemanticAuthorityEvidencePostApply {
  applied: boolean;
  columnsUnchanged: boolean;
  projectionEmbeddingNullCount: number;
  /**
   * null on the recovered-existing/finalize path, where no pre-apply identity
   * exists; a pre/post equality is never fabricated.
   */
  rowCountUnchanged: boolean | null;
  /** null on the recovered-existing/finalize path (see `rowCountUnchanged`). */
  idDigestUnchanged: boolean | null;
  smokeOracleDrift: number;
  ok: boolean;
  blockers: string[];
}

export interface SemanticAuthorityEvidenceSmokeSummary {
  cases: number;
  compared: number;
  oracleDrift: number;
  pass: boolean;
}

/**
 * Content-free migration-history reconciliation state. `historyRecorded` is true
 * only when `supabase migration repair --linked --status applied` exited 0;
 * `historyVerified` is true only when the re-read `schema_migrations` ledger shows
 * `targetVersion` applied (and any reliable CLI cross-check agrees). `applied` and
 * `pendingVersions` are the post-decision direct-ledger state. Preflight evidence
 * has no history block at all, proving it never mutates the ledger.
 */
export interface SemanticAuthorityEvidenceHistory {
  historyRecorded: boolean;
  historyVerified: boolean;
  targetVersion: string;
  applied: boolean;
  pendingVersions: string[];
}

export interface SemanticAuthorityEvidence {
  version: typeof SEMANTIC_AUTHORITY_EVIDENCE_VERSION;
  generatedAt: string;
  scope: "semantic-authority-rollout";
  mode: "dry-run" | "preflight" | "apply" | "smoke" | "finalize-existing";
  status: "authored_not_applied" | "preflight_ready" | "applied" | "blocked";
  /**
   * True when this report describes an already-applied remote state recovered by
   * the read-only finalize-existing path rather than a fresh exact-SQL apply.
   */
  recoveredExistingState: boolean;
  /**
   * False when no pre-apply projection identity was captured (recovery path).
   * When false, `preIdentity` is null and no pre/post digest equality is claimed.
   */
  preIdentityAvailable: boolean;
  migration: SemanticAuthorityEvidenceMigration;
  identity: SemanticAuthorityEvidenceIdentity;
  inventory: SemanticAuthorityEvidenceInventory;
  preflight: SemanticAuthorityEvidencePreflight;
  baseline: SemanticAuthorityEvidenceBaseline;
  preIdentity: SemanticAuthorityEvidenceProjectionIdentity | null;
  postIdentity: SemanticAuthorityEvidenceProjectionIdentity | null;
  postApply: SemanticAuthorityEvidencePostApply | null;
  smoke: SemanticAuthorityEvidenceSmokeSummary | null;
  /** Present only for apply/finalize-existing evidence; null for preflight/dry-run. */
  history: SemanticAuthorityEvidenceHistory | null;
  boundaries: string[];
}

export interface BuildSemanticAuthorityEvidenceInput {
  generatedAt: string;
  mode: SemanticAuthorityEvidence["mode"];
  status: SemanticAuthorityEvidence["status"];
  recoveredExistingState?: boolean;
  preIdentityAvailable?: boolean;
  migration: SemanticAuthorityEvidenceMigration;
  identity: SemanticAuthorityEvidenceIdentity;
  inventory: SemanticAuthorityEvidenceInventory;
  preflight: SemanticAuthorityEvidencePreflight;
  baseline: SemanticAuthorityEvidenceBaseline;
  preIdentity: SemanticAuthorityEvidenceProjectionIdentity | null;
  postIdentity?: SemanticAuthorityEvidenceProjectionIdentity | null;
  postApply?: SemanticAuthorityEvidencePostApply | null;
  smoke?: SemanticAuthorityEvidenceSmokeSummary | null;
  history?: SemanticAuthorityEvidenceHistory | null;
}

/** Assembles a content-free evidence report, failing closed on any leak. */
export function buildSemanticAuthorityEvidence(
  input: BuildSemanticAuthorityEvidenceInput,
): SemanticAuthorityEvidence {
  const recoveredExistingState = input.recoveredExistingState === true;
  const report: SemanticAuthorityEvidence = {
    version: SEMANTIC_AUTHORITY_EVIDENCE_VERSION,
    generatedAt: input.generatedAt,
    scope: "semantic-authority-rollout",
    mode: input.mode,
    status: input.status,
    recoveredExistingState,
    preIdentityAvailable: recoveredExistingState ? false : input.preIdentityAvailable !== false,
    migration: { ...input.migration },
    identity: { ...input.identity },
    inventory: { ...input.inventory, pendingVersions: [...input.inventory.pendingVersions] },
    preflight: { ...input.preflight, checks: [...input.preflight.checks], blockers: [...input.preflight.blockers] },
    baseline: { ...input.baseline },
    preIdentity: input.preIdentity ? { ...input.preIdentity } : null,
    postIdentity: input.postIdentity ? { ...input.postIdentity } : null,
    postApply: input.postApply
      ? {
          ...input.postApply,
          rowCountUnchanged: input.postApply.rowCountUnchanged ?? null,
          idDigestUnchanged: input.postApply.idDigestUnchanged ?? null,
          blockers: [...input.postApply.blockers],
        }
      : null,
    smoke: input.smoke ? { ...input.smoke } : null,
    history: input.history
      ? { ...input.history, pendingVersions: [...input.history.pendingVersions] }
      : null,
    boundaries: [...SEMANTIC_AUTHORITY_EVIDENCE_BOUNDARIES],
  };
  assertContentFreeEvidence(report);
  return report;
}

/** A stable digest over the content-free report body (excluding `generatedAt`). */
export function semanticAuthorityEvidenceHash(report: SemanticAuthorityEvidence): string {
  const body = JSON.stringify({ ...report, generatedAt: "" });
  return crypto.createHash("sha256").update(body).digest("hex");
}

/** Renders the content-free markdown evidence artifact. */
export function renderSemanticAuthorityEvidenceMarkdown(report: SemanticAuthorityEvidence): string {
  const lines: string[] = [];
  lines.push("# WorldCons M7.8-A semantic-authority rollout evidence");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- status: **${report.status}**`);
  lines.push(`- recoveredExistingState: ${report.recoveredExistingState}`);
  lines.push(`- preIdentityAvailable: ${report.preIdentityAvailable}`);
  lines.push(`- migration: ${report.migration.version} (${report.migration.path})`);
  lines.push(`- migration.sha256: ${report.migration.sha256}`);
  lines.push(`- migration.sqlBytes: ${report.migration.sqlBytes}`);
  lines.push(`- identity: ${report.identity.projectName} (${report.identity.projectRef})`);
  lines.push(
    `- inventory: targetAbsent=${report.inventory.targetAbsent}, pendingSetExact=${report.inventory.pendingSetExact}, pending=${report.inventory.pendingVersions.join(",")}`,
  );
  lines.push(`- preflight.ok: ${report.preflight.ok}`);
  lines.push(
    `- baseline: currentPublished=${report.baseline.currentPublishedRows}, projection=${report.baseline.projectionRows}, embeddingNull=${report.baseline.projectionEmbeddingNullCount}, artifactBacked=${report.baseline.artifactBackedCurrentPublishedRows}, legacyOnly=${report.baseline.legacyVersionEmbeddingOnlyCount}, mismatches=${report.baseline.totalMismatchCount}`,
  );
  if (report.preIdentity) {
    lines.push(`- preIdentity: count=${report.preIdentity.count}, digest=${report.preIdentity.digest}`);
  } else {
    lines.push(`- preIdentity: unavailable (recoveredExistingState=${report.recoveredExistingState})`);
  }
  if (report.postIdentity) {
    lines.push(`- postIdentity: count=${report.postIdentity.count}, digest=${report.postIdentity.digest}`);
  }
  if (report.postApply) {
    const rowCountUnchanged = report.postApply.rowCountUnchanged === null ? "n/a" : String(report.postApply.rowCountUnchanged);
    const idDigestUnchanged = report.postApply.idDigestUnchanged === null ? "n/a" : String(report.postApply.idDigestUnchanged);
    lines.push(
      `- postApply: applied=${report.postApply.applied}, columnsUnchanged=${report.postApply.columnsUnchanged}, embeddingNull=${report.postApply.projectionEmbeddingNullCount}, rowCountUnchanged=${rowCountUnchanged}, idDigestUnchanged=${idDigestUnchanged}, smokeOracleDrift=${report.postApply.smokeOracleDrift}, ok=${report.postApply.ok}`,
    );
  }
  if (report.smoke) {
    lines.push(
      `- smoke: cases=${report.smoke.cases}, compared=${report.smoke.compared}, oracleDrift=${report.smoke.oracleDrift}, pass=${report.smoke.pass}`,
    );
  }
  if (report.history) {
    lines.push(
      `- history: recorded=${report.history.historyRecorded}, verified=${report.history.historyVerified}, target=${report.history.targetVersion}, applied=${report.history.applied}, pending=${report.history.pendingVersions.join(",")}`,
    );
  }
  lines.push("");
  lines.push("## Preflight blockers");
  lines.push("");
  if (report.preflight.blockers.length === 0) lines.push("(none)");
  else for (const blocker of report.preflight.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Boundaries");
  lines.push("");
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);
  lines.push("");
  return lines.join("\n");
}
