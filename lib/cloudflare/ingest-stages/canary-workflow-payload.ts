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
 */
import { CANARY_SOURCE_KEYS, type CanarySourceKey } from "./canary";

/** The two supported operation modes; anything else is rejected. */
export const OPERATOR_CANARY_MODES = ["seed", "seed-and-dispatch"] as const;
export type OperatorCanaryMode = (typeof OPERATOR_CANARY_MODES)[number];

/** Only these top-level keys may appear in the event payload. */
export const OPERATOR_CANARY_ALLOWED_KEYS = [
  "sourceKey",
  "candidateUrl",
  "ecli",
  "docket",
  "operatorId",
  "mode",
] as const;

export const OPERATOR_CANARY_DEFAULT_OPERATOR_ID = "cloudflare-workflow-operator" as const;
const MAX_URL_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_OPERATOR_ID_LENGTH = 200;

/** The validated, bounded workflow event. */
export interface OperatorCanaryEvent {
  sourceKey: CanarySourceKey;
  candidateUrl: string;
  ecli?: string;
  docket?: string;
  operatorId: string;
  mode: OperatorCanaryMode;
}

export type OperatorCanaryParseResult =
  | { ok: true; value: OperatorCanaryEvent }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strictly validates a workflow payload. A JSON string is accepted (the Wrangler
 * CLI/`create` path may pass one) and parsed defensively. Any malformed shape,
 * unknown key, unknown mode, out-of-range source, or missing per-source identity
 * fails closed with a stable error code.
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

  const allowed = new Set<string>(OPERATOR_CANARY_ALLOWED_KEYS);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) return { ok: false, error: `operator_canary.unknown_key:${key}` };
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

  const operatorIdRaw = candidate.operatorId;
  if (operatorIdRaw !== undefined && (typeof operatorIdRaw !== "string" || operatorIdRaw.length > MAX_OPERATOR_ID_LENGTH)) {
    return { ok: false, error: "operator_canary.operator_id_invalid" };
  }
  const operatorId = typeof operatorIdRaw === "string" && operatorIdRaw.trim().length > 0
    ? operatorIdRaw.trim()
    : OPERATOR_CANARY_DEFAULT_OPERATOR_ID;

  const modeRaw = candidate.mode;
  let mode: OperatorCanaryMode = "seed-and-dispatch";
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== "string" || !(OPERATOR_CANARY_MODES as readonly string[]).includes(modeRaw)) {
      return { ok: false, error: "operator_canary.mode_not_allowed" };
    }
    mode = modeRaw as OperatorCanaryMode;
  }

  return {
    ok: true,
    value: {
      sourceKey: sourceKey as CanarySourceKey,
      candidateUrl: candidateUrl.trim(),
      ...(typeof ecli === "string" ? { ecli: ecli.trim() } : {}),
      ...(typeof docket === "string" ? { docket: docket.trim() } : {}),
      operatorId,
      mode,
    },
  };
}
