import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";

/**
 * M7.8-B typed rank-policy DECISION record (runtime-neutral).
 *
 * This module defines the signed, human/product decision that must exist BEFORE
 * any v5 holdout evidence is produced. It is deliberately free of `node:*`
 * imports and performs no remote read or write.
 *
 * The record binds a chosen policy to the v5 holdout manifest hash and to the
 * sealed v4 evidence. The parser/validator FAIL CLOSED unless:
 *
 * - the decision is FINALIZED (policy is not `undecided`, and `decidedAt`,
 *   `decidedByRole` and `decisionHash` are all present and consistent);
 * - the record's `holdoutManifestHash` matches the expected v5 holdout hash;
 * - the computed canonical `decisionHash` verifies;
 * - the raw record contains NO sealed v4 metric literal/value or reference
 *   field (no observed v4 aggregate number, no case id, no oracle/observed id);
 * - numeric mode carries explicit thresholds AND a rationale, while every
 *   non-numeric mode rejects thresholds.
 *
 * No policy is chosen by this module on the user's behalf: the checked-in
 * template is `undecided`, and only a human/product decision may finalize it.
 */

/** The supported decision policies. */
export const RANK_POLICY_DECISIONS = [
  "candidate-coverage-equivalence",
  "numeric-thresholds",
  "informational-only",
  "undecided",
] as const;

export type RankPolicyDecisionPolicy = (typeof RANK_POLICY_DECISIONS)[number];

/** The decision record version. */
export const RANK_POLICY_DECISION_VERSION = 1 as const;

/** Non-numeric policies that must NOT carry thresholds. */
export const NON_NUMERIC_DECISION_POLICIES = [
  "candidate-coverage-equivalence",
  "informational-only",
] as const;

/** The four product-neutral invariants the equivalence policy evaluates. */
export const RANK_POLICY_INVARIANTS = ["E1", "E2", "E3", "E4"] as const;
export type RankPolicyInvariant = (typeof RANK_POLICY_INVARIANTS)[number];

/**
 * Numeric thresholds, only meaningful for `numeric-thresholds`. The type mirrors
 * the M7.7-B `RankPolicyThresholds`; when present, at least one value must be
 * supplied explicitly by the signer.
 */
export interface RankDecisionThresholds {
  minOverlapAtKMacro?: number;
  minPrefixMatchMacro?: number;
  minExactOrderMacro?: number;
  minSameSetMacro?: number;
}

/**
 * The signed decision record. `decisionHash` is the canonical digest over the
 * record body EXCLUDING `decisionHash` itself (see `rankDecisionHash`).
 */
export interface RankPolicyDecisionRecord {
  version: typeof RANK_POLICY_DECISION_VERSION;
  policy: RankPolicyDecisionPolicy;
  decisionId: string;
  /** UTC timestamp of the human/product decision; empty for an undecided template. */
  decidedAt: string;
  /** The signer's role (for example `product-owner`); empty for a template. */
  decidedByRole: string;
  /** The v5 holdout manifest hash this decision is bound to. */
  holdoutManifestHash: string;
  /** Always true: the v4 evidence is sealed and must never be re-opened. */
  v4EvidenceSealed: true;
  /** The product-neutral invariants the decision requires (E1-E4). */
  invariants: RankPolicyInvariant[];
  /** Optional numeric thresholds; valid only for numeric mode. */
  thresholds?: RankDecisionThresholds | null;
  /** The human-readable rationale; required for numeric mode. */
  rationale: string;
  /** Canonical digest of the record (excluding this field). */
  decisionHash: string;
}

export interface RankDecisionValidationOptions {
  /** The expected v5 holdout manifest hash the record must be bound to. */
  expectedHoldoutManifestHash?: string;
  /** When true (the default) the record must be finalized (`undecided` rejected). */
  requireFinalized?: boolean;
}

export interface RankDecisionValidation {
  valid: boolean;
  finalized: boolean;
  policy: RankPolicyDecisionPolicy;
  decisionHash: string;
  /** Explicit machine-readable failure reasons (empty when valid). */
  errors: string[];
}

/** True when a value is a plain record (not an array/null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function hasAnyThreshold(thresholds: RankDecisionThresholds | null | undefined): boolean {
  if (!thresholds) return false;
  return (
    thresholds.minOverlapAtKMacro !== undefined ||
    thresholds.minPrefixMatchMacro !== undefined ||
    thresholds.minExactOrderMacro !== undefined ||
    thresholds.minSameSetMacro !== undefined
  );
}

/**
 * SEALED v4 metric/reference guards.
 *
 * The decision must bind to the v4 corpus by its sealed hash only; it must never
 * copy a v4 observed metric, a v4 case/observed/oracle id or a v4 reference
 * field into the record. These key/field guards are checked recursively over the
 * RAW record so a nested leak is impossible.
 */
export const SEALED_V4_FORBIDDEN_KEYS = [
  // v4 aggregate/case metric field names.
  "aggregate",
  "metrics",
  "overlapAtK",
  "overlapAtKCount",
  "overlapAtKMacro",
  "prefixMatch",
  "prefixMatchCount",
  "prefixMatchMacro",
  "prefixMatchRate",
  "exactOrder",
  "exactOrderCount",
  "exactOrderMacro",
  "sameSet",
  "sameSetCount",
  "sameSetMacro",
  "strictPassRate",
  // v4 outcome/reference field names.
  "caseId",
  "observedId",
  "oracleTopId",
  "oracleCompared",
  "expectedId",
  "expectedIds",
  "outcomes",
  "categories",
  "corpusHash",
  "corpusCases",
  "sourceScope",
  "blockers",
  "stableHash",
] as const;

/**
 * SEALED v4 aggregate metric LITERALS observed in the archived v4 evidence. A
 * decision that embeds one of these numbers verbatim has leaked a sealed
 * outcome and must fail closed. They are stored as exact decimal strings and
 * compared against stringified numbers/strings anywhere in the raw record.
 */
export const SEALED_V4_METRIC_LITERALS = [
  "0.3083333333",
  "0.5333333333",
  "0.5000000000",
  "0.5833333333",
  "0.3083333333",
  "0.5833333333",
  "ed18add749fe4a23",
] as const;

/**
 * The only key whose value legitimately carries the sealed v4 corpus hash:
 * `holdoutManifestHash` is the v5 hash, and a separate explicit
 * `sealedV4CorpusHash` binding is intentionally NOT part of the record. The v4
 * hash literal is therefore a leak wherever it appears and is rejected.
 */

function findForbiddenKey(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenKey(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if ((SEALED_V4_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      errors.push(`sealed-v4-reference: forbidden key ${path}.${key} must not appear in a decision record`);
    }
    findForbiddenKey(entry, `${path}.${key}`, errors);
  }
}

function findForbiddenLiteral(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenLiteral(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) findForbiddenLiteral(entry, `${path}.${key}`, errors);
    return;
  }
  if (typeof value === "string" || typeof value === "number") {
    const asString = typeof value === "number" ? String(value) : value;
    const hit = (SEALED_V4_METRIC_LITERALS as readonly string[]).find((literal) => asString.includes(literal));
    if (hit !== undefined) {
      errors.push(`sealed-v4-metric: ${path} carries a sealed v4 metric literal`);
    }
  }
}

/**
 * The canonical decision hash: the `shadowDigest` over the domain-scoped
 * canonical JSON of the record EXCLUDING `decisionHash`. It is order-independent
 * and stable across processes.
 */
export function rankDecisionHash(record: Omit<RankPolicyDecisionRecord, "decisionHash"> | RankPolicyDecisionRecord): string {
  const { decisionHash: _ignored, ...body } = record as RankPolicyDecisionRecord;
  void _ignored;
  return shadowDigest(`search-rank-policy-decision/v${RANK_POLICY_DECISION_VERSION}\n${canonicalJson(body)}`);
}

/**
 * Parses an unknown JSON value into a decision record, failing closed on any
 * structural violation. The returned record is NOT yet validated against a
 * policy/hash; call `validateRankPolicyDecision` for that.
 */
export function parseRankPolicyDecision(raw: unknown): RankPolicyDecisionRecord {
  if (!isRecord(raw)) throw new Error("decision_invalid: the decision record must be a JSON object");
  if (raw.version !== RANK_POLICY_DECISION_VERSION) {
    throw new Error(`decision_invalid: unsupported decision version ${String(raw.version)}`);
  }
  if (typeof raw.policy !== "string" || !(RANK_POLICY_DECISIONS as readonly string[]).includes(raw.policy)) {
    throw new Error(`decision_invalid: unknown policy ${String(raw.policy)}`);
  }
  const invariants = Array.isArray(raw.invariants) ? raw.invariants : null;
  if (invariants === null || !invariants.every((entry) => (RANK_POLICY_INVARIANTS as readonly string[]).includes(entry))) {
    throw new Error("decision_invalid: invariants must be a subset of E1-E4");
  }
  const thresholds = raw.thresholds === undefined || raw.thresholds === null ? null : raw.thresholds;
  if (thresholds !== null && !isRecord(thresholds)) {
    throw new Error("decision_invalid: thresholds must be an object or null");
  }
  const record: RankPolicyDecisionRecord = {
    version: RANK_POLICY_DECISION_VERSION,
    policy: raw.policy as RankPolicyDecisionPolicy,
    decisionId: typeof raw.decisionId === "string" ? raw.decisionId : "",
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : "",
    decidedByRole: typeof raw.decidedByRole === "string" ? raw.decidedByRole : "",
    holdoutManifestHash: typeof raw.holdoutManifestHash === "string" ? raw.holdoutManifestHash : "",
    v4EvidenceSealed: true,
    invariants: [...invariants] as RankPolicyInvariant[],
    thresholds: thresholds as RankDecisionThresholds | null,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    decisionHash: typeof raw.decisionHash === "string" ? raw.decisionHash : "",
  };
  return record;
}

/**
 * Validates a decision record, failing closed with explicit reasons. The raw
 * record is passed alongside the parsed record so the sealed-v4 guards can scan
 * the exact bytes the operator supplied (never the normalized copy).
 */
export function validateRankPolicyDecision(
  raw: unknown,
  parsed: RankPolicyDecisionRecord = parseRankPolicyDecision(raw),
  options: RankDecisionValidationOptions = {},
): RankDecisionValidation {
  const requireFinalized = options.requireFinalized ?? true;
  const errors: string[] = [];

  // Sealed-v4 guards scan the RAW record recursively.
  findForbiddenKey(raw, "decision", errors);
  findForbiddenLiteral(raw, "decision", errors);

  const finalized = parsed.policy !== "undecided";
  if (requireFinalized && !finalized) {
    errors.push("decision_undecided: a finalized policy is required before any holdout is evaluated");
  }
  if (finalized) {
    if (!isNonEmptyString(parsed.decisionId)) errors.push("decision_invalid: decisionId is required");
    if (!isIsoTimestamp(parsed.decidedAt)) errors.push("decision_invalid: a valid decidedAt timestamp is required");
    if (!isNonEmptyString(parsed.decidedByRole)) errors.push("decision_invalid: decidedByRole is required");
  }
  if (!isNonEmptyString(parsed.holdoutManifestHash)) {
    errors.push("decision_invalid: holdoutManifestHash is required");
  } else if (
    options.expectedHoldoutManifestHash !== undefined &&
    parsed.holdoutManifestHash !== options.expectedHoldoutManifestHash
  ) {
    errors.push(
      `decision_hash_mismatch: holdoutManifestHash ${parsed.holdoutManifestHash} does not match the expected v5 holdout hash ${options.expectedHoldoutManifestHash}`,
    );
  }
  if (parsed.invariants.length === 0) {
    errors.push("decision_invalid: at least one invariant (E1-E4) is required");
  }

  const numeric = parsed.policy === "numeric-thresholds";
  if (numeric) {
    if (!hasAnyThreshold(parsed.thresholds)) {
      errors.push("decision_numeric_thresholds_missing: numeric mode requires at least one explicit threshold");
    } else {
      const thresholds = parsed.thresholds as RankDecisionThresholds;
      for (const [name, value] of Object.entries(thresholds)) {
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          errors.push(`decision_numeric_thresholds_invalid: ${name} must be a number between 0 and 1`);
        }
      }
    }
    if (!isNonEmptyString(parsed.rationale)) {
      errors.push("decision_rationale_missing: numeric mode requires an explicit rationale");
    }
  } else if (hasAnyThreshold(parsed.thresholds)) {
    errors.push("decision_thresholds_forbidden: thresholds are only valid for numeric-thresholds mode");
  }

  // The decision hash must verify against its own body.
  if (!isNonEmptyString(parsed.decisionHash)) {
    errors.push("decision_invalid: decisionHash is required");
  } else {
    const computed = rankDecisionHash(parsed);
    if (computed !== parsed.decisionHash) {
      errors.push(`decision_hash_mismatch: decisionHash ${parsed.decisionHash} does not verify (expected ${computed})`);
    }
  }

  return {
    valid: errors.length === 0,
    finalized,
    policy: parsed.policy,
    decisionHash: parsed.decisionHash,
    errors,
  };
}

/** Fails closed unless the decision is valid (throws with the explicit reasons). */
export function assertRankPolicyDecision(
  raw: unknown,
  options: RankDecisionValidationOptions = {},
): RankPolicyDecisionRecord {
  const parsed = parseRankPolicyDecision(raw);
  const validation = validateRankPolicyDecision(raw, parsed, options);
  if (!validation.valid) {
    throw new Error(`decision_fail_closed: ${validation.errors.join("; ")}`);
  }
  return parsed;
}
