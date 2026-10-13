/**
 * Runtime-neutral, strict payload contract for the operator single-case canary
 * Cloudflare Workflow (`WorldconsOperatorCanaryWorkflow`).
 *
 * This module is intentionally free of `cloudflare:workers`, D1, R2, Queues and
 * any Node builtin so the exact envelope validation is unit-testable and shared
 * by the Workflow and by `scripts/check.ts`. The Workflow must NEVER trust an
 * operator-supplied payload: every field is bounded, `sourceKey` is restricted to
 * the two canary countries, unknown keys/modes are rejected, and no unbounded
 * list/limit field can be smuggled in.
 *
 * Two disjoint payload shapes are supported and strictly discriminated:
 *
 *   { sourceKey: "de-bverfg"|"us-scotus", candidateUrl, ecli?|docket?, operatorId?, mode?: "seed"|"seed-and-dispatch" }
 *   { mode: "advance", jobId: <uuid>, canaryId: <32-hex>, operatorId? }
 *
 * The `advance` shape carries NO `sourceKey`/`candidateUrl`/identity and never
 * changes source ownership; it can only continue an already-seeded canary.
 */
import { CANARY_SOURCE_KEYS, type CanarySourceKey } from "./canary";

/** The supported seed modes; anything else is rejected. */
export const OPERATOR_CANARY_SEED_MODES = ["seed", "seed-and-dispatch"] as const;
export type OperatorCanarySeedMode = (typeof OPERATOR_CANARY_SEED_MODES)[number];

/** The two disjoint top-level payload shapes. */
export type OperatorCanaryPayloadKind = "seed" | "advance";

/** Keys allowed on the seed shape only. */
export const OPERATOR_CANARY_SEED_KEYS = [
  "sourceKey",
  "candidateUrl",
  "ecli",
  "docket",
  "operatorId",
  "mode",
] as const;

/** Keys allowed on the advance shape only. */
export const OPERATOR_CANARY_ADVANCE_KEYS = [
  "mode",
  "jobId",
  "canaryId",
  "operatorId",
] as const;

export const OPERATOR_CANARY_DEFAULT_OPERATOR_ID = "cloudflare-workflow-operator" as const;
const MAX_URL_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_OPERATOR_ID_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANARY_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** The validated seed envelope. */
export interface OperatorCanarySeedEvent {
  payloadKind: "seed";
  sourceKey: CanarySourceKey;
  candidateUrl: string;
  ecli?: string;
  docket?: string;
  operatorId: string;
  mode: OperatorCanarySeedMode;
}

/** The validated advance envelope. */
export interface OperatorCanaryAdvanceEvent {
  payloadKind: "advance";
  mode: "advance";
  jobId: string;
  canaryId: string;
  operatorId: string;
}

export type OperatorCanaryEvent = OperatorCanarySeedEvent | OperatorCanaryAdvanceEvent;

export type OperatorCanaryParseResult =
  | { ok: true; value: OperatorCanaryEvent }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(candidate: Record<string, unknown>, allowed: readonly string[]): string | null {
  const permitted = new Set<string>(allowed);
  for (const key of Object.keys(candidate)) {
    if (!permitted.has(key)) return `operator_canary.unknown_key:${key}`;
  }
  return null;
}

function parseOperatorId(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value !== undefined && (typeof value !== "string" || value.length > MAX_OPERATOR_ID_LENGTH)) {
    return { ok: false, error: "operator_canary.operator_id_invalid" };
  }
  const operatorId = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : OPERATOR_CANARY_DEFAULT_OPERATOR_ID;
  return { ok: true, value: operatorId };
}

/**
 * Strictly validates a workflow payload. A JSON string is accepted (the Wrangler
 * CLI/`create` path may pass one) and parsed defensively. The two shapes are
 * discriminated FIRST by `mode`; an unknown mode fails closed, and each shape then
 * rejects every key it does not own so a seed/advance body can never be mixed.
 */
export function parseOperatorCanaryEvent(payload: unknown): OperatorCanaryParseResult {
  let candidate = payload;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return { ok: false, error: "operator_canary.payload_not_json" };
    }
  }
  if (!isRecord(candidate)) return { ok: false, error: "operator_canary.payload_not_object" };

  // Discriminate on `mode`. Any present-and-recognised mode names exactly one
  // shape; an absent or unrecognised mode is handled by the seed branch (absent =>
  // default seed mode; unrecognised => rejected there).
  const modeRaw = candidate.mode;
  if (typeof modeRaw === "string" && ![...OPERATOR_CANARY_SEED_MODES, "advance"].includes(modeRaw)) {
    return { ok: false, error: "operator_canary.mode_not_allowed" };
  }
  const isAdvance = modeRaw === "advance";

  const shapeError = rejectUnknownKeys(candidate, isAdvance ? OPERATOR_CANARY_ADVANCE_KEYS : OPERATOR_CANARY_SEED_KEYS);
  if (shapeError) return { ok: false, error: shapeError };

  const operator = parseOperatorId(candidate.operatorId);
  if (!operator.ok) return operator;

  if (isAdvance) {
    const jobIdRaw = candidate.jobId;
    if (typeof jobIdRaw !== "string" || !UUID_PATTERN.test(jobIdRaw.trim())) {
      return { ok: false, error: "operator_canary.advance_job_id_invalid" };
    }
    const canaryIdRaw = candidate.canaryId;
    if (typeof canaryIdRaw !== "string" || !CANARY_ID_PATTERN.test(canaryIdRaw.trim())) {
      return { ok: false, error: "operator_canary.advance_canary_id_invalid" };
    }
    return {
      ok: true,
      value: {
        payloadKind: "advance",
        mode: "advance",
        jobId: jobIdRaw.trim(),
        canaryId: canaryIdRaw.trim().toLowerCase(),
        operatorId: operator.value,
      },
    };
  }

  const sourceKey = candidate.sourceKey;
  if (typeof sourceKey !== "string" || !(CANARY_SOURCE_KEYS as readonly string[]).includes(sourceKey)) {
    return { ok: false, error: "operator_canary.source_not_allowed" };
  }

  const candidateUrl = candidate.candidateUrl;
  if (typeof candidateUrl !== "string" || candidateUrl.trim().length === 0) {
    return { ok: false, error: "operator_canary.candidate_url_required" };
  }
  if (candidateUrl.length > MAX_URL_LENGTH) return { ok: false, error: "operator_canary.candidate_url_too_long" };

  const ecli = candidate.ecli;
  if (ecli !== undefined && (typeof ecli !== "string" || ecli.length > MAX_IDENTIFIER_LENGTH)) {
    return { ok: false, error: "operator_canary.ecli_invalid" };
  }
  const docket = candidate.docket;
  if (docket !== undefined && (typeof docket !== "string" || docket.length > MAX_IDENTIFIER_LENGTH)) {
    return { ok: false, error: "operator_canary.docket_invalid" };
  }

  // Per-source identity is mandatory at the envelope layer so a bad request fails
  // before any D1/R2/network work (planCanaryCase re-checks the identity match).
  if (sourceKey === "de-bverfg" && (typeof ecli !== "string" || ecli.trim().length === 0)) {
    return { ok: false, error: "operator_canary.ecli_required_for_de" };
  }
  if (sourceKey === "us-scotus" && (typeof docket !== "string" || docket.trim().length === 0)) {
    return { ok: false, error: "operator_canary.docket_required_for_us" };
  }

  let mode: OperatorCanarySeedMode = "seed-and-dispatch";
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== "string" || !(OPERATOR_CANARY_SEED_MODES as readonly string[]).includes(modeRaw)) {
      return { ok: false, error: "operator_canary.mode_not_allowed" };
    }
    mode = modeRaw as OperatorCanarySeedMode;
  }

  return {
    ok: true,
    value: {
      payloadKind: "seed",
      sourceKey: sourceKey as CanarySourceKey,
      candidateUrl: candidateUrl.trim(),
      ...(typeof ecli === "string" ? { ecli: ecli.trim() } : {}),
      ...(typeof docket === "string" ? { docket: docket.trim() } : {}),
      operatorId: operator.value,
      mode,
    },
  };
}
