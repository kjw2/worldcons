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
 * Four disjoint payload shapes are supported and strictly discriminated:
 *
 *   { sourceKey: "de-bverfg"|"us-scotus", candidateUrl, ecli?|docket?, operatorId?, mode?: "seed"|"seed-and-dispatch" }
 *   { mode: "advance", jobId: <uuid>, canaryId: <32-hex>, operatorId? }
 *   { mode: "discover-one", sourceKey: "de-bverfg"|"us-scotus", rangeDays?, operatorId?, dispatch? }
 *   { mode: "bootstrap-de-one", sourceKey: "de-bverfg", operatorId?, dispatch? }
 *
 * The `advance` shape carries NO `sourceKey`/`candidateUrl`/identity and never
 * changes source ownership; it can only continue an already-seeded canary.
 *
 * The `bootstrap-de-one` shape is the ordinary (non-canary) Germany bootstrap:
 * it carries NO candidate URL/ECLI/docket/rangeDays, so a caller can never inject
 * a candidate or widen the bounded single-source seeding. It seeds the EXACT
 * ordinary daily `enqueueIngestStageDiscovery` job the scheduled `0 21 * * *`
 * cron would (regular `stages/ingest-discovery-request/de-bverfg/...` payload,
 * no `canaryDiscovery` marker), producing a genuine ordinary Discovery job rather
 * than the explicit `stages/canary/` exception.
 */
import { CANARY_SOURCE_KEYS, type CanarySourceKey } from "./canary";
import { CANARY_DISCOVERY_MAX_RANGE_DAYS, CANARY_DISCOVERY_SOURCE_KEYS, canaryDiscoveryDefaultRangeDays, type CanaryDiscoverySourceKey } from "./canary-discovery";

/** The supported seed modes; anything else is rejected. */
export const OPERATOR_CANARY_SEED_MODES = ["seed", "seed-and-dispatch"] as const;
export type OperatorCanarySeedMode = (typeof OPERATOR_CANARY_SEED_MODES)[number];

/** The four disjoint top-level payload shapes. */
export type OperatorCanaryPayloadKind = "seed" | "advance" | "discover-one" | "bootstrap-de-one";

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

/**
 * Keys allowed on the discover-one shape only. It deliberately carries NO
 * `candidateUrl`/`ecli`/`docket`: discovery always runs against the official
 * source, so a caller can never inject a candidate masquerading as discovery.
 * `sourceKey` may be Germany or the United States (both run a genuine official
 * listing discovery); `rangeDays`, when omitted, uses the source-specific
 * bounded default.
 */
export const OPERATOR_CANARY_DISCOVER_ONE_KEYS = [
  "mode",
  "sourceKey",
  "rangeDays",
  "operatorId",
  "dispatch",
] as const;

/**
 * Keys allowed on the `bootstrap-de-one` shape only. It deliberately carries NO
 * `candidateUrl`/`ecli`/`docket`/`rangeDays`: this is the ordinary Germany
 * bootstrap, so a caller can never inject a candidate, an identity, or a wider
 * range. `sourceKey` is accepted only as the exact literal `de-bverfg`.
 */
export const OPERATOR_CANARY_BOOTSTRAP_DE_ONE_KEYS = [
  "mode",
  "sourceKey",
  "operatorId",
  "dispatch",
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

/** The validated discover-one envelope (Germany only; no injected candidate). */
export interface OperatorCanaryDiscoverOneEvent {
  payloadKind: "discover-one";
  mode: "discover-one";
  sourceKey: CanaryDiscoverySourceKey;
  rangeDays: number;
  operatorId: string;
  /** When true (default) the seeded discovery job is dispatched immediately. */
  dispatch: boolean;
}

/**
 * The validated bootstrap-de-one envelope (Germany only; the ORDINARY staged
 * bootstrap, not the canary exception). It carries no candidate/identity/range.
 */
export interface OperatorCanaryBootstrapDeOneEvent {
  payloadKind: "bootstrap-de-one";
  mode: "bootstrap-de-one";
  sourceKey: "de-bverfg";
  operatorId: string;
  /** When true (default) the seeded ordinary discovery job is dispatched immediately. */
  dispatch: boolean;
}

export type OperatorCanaryEvent =
  | OperatorCanarySeedEvent
  | OperatorCanaryAdvanceEvent
  | OperatorCanaryDiscoverOneEvent
  | OperatorCanaryBootstrapDeOneEvent;

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
 * CLI/`create` path may pass one) and parsed defensively. The shapes are
 * discriminated FIRST by `mode`; an unknown mode fails closed, and each shape then
 * rejects every key it does not own so a seed/advance/discover-one/bootstrap body
 * can never be mixed.
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
  if (typeof modeRaw === "string" && ![...OPERATOR_CANARY_SEED_MODES, "advance", "discover-one", "bootstrap-de-one"].includes(modeRaw)) {
    return { ok: false, error: "operator_canary.mode_not_allowed" };
  }
  const isAdvance = modeRaw === "advance";
  const isDiscoverOne = modeRaw === "discover-one";
  const isBootstrapDeOne = modeRaw === "bootstrap-de-one";

  const shapeError = rejectUnknownKeys(
    candidate,
    isAdvance
      ? OPERATOR_CANARY_ADVANCE_KEYS
      : isDiscoverOne
        ? OPERATOR_CANARY_DISCOVER_ONE_KEYS
        : isBootstrapDeOne
          ? OPERATOR_CANARY_BOOTSTRAP_DE_ONE_KEYS
          : OPERATOR_CANARY_SEED_KEYS,
  );
  if (shapeError) return { ok: false, error: shapeError };

  const operator = parseOperatorId(candidate.operatorId);
  if (!operator.ok) return operator;

  if (isBootstrapDeOne) {
    const sourceKeyRaw = candidate.sourceKey;
    // The ordinary Germany bootstrap is DE-only even though the discover-one
    // canary now also supports the United States.
    if (sourceKeyRaw !== "de-bverfg") {
      return { ok: false, error: "operator_canary.bootstrap_de_one_source_not_allowed" };
    }
    if (candidate.dispatch !== undefined && typeof candidate.dispatch !== "boolean") {
      return { ok: false, error: "operator_canary.bootstrap_de_one_dispatch_invalid" };
    }
    return {
      ok: true,
      value: {
        payloadKind: "bootstrap-de-one",
        mode: "bootstrap-de-one",
        sourceKey: "de-bverfg",
        operatorId: operator.value,
        dispatch: candidate.dispatch !== false,
      },
    };
  }

  if (isDiscoverOne) {
    const sourceKeyRaw = candidate.sourceKey;
    if (typeof sourceKeyRaw !== "string" || !(CANARY_DISCOVERY_SOURCE_KEYS as readonly string[]).includes(sourceKeyRaw)) {
      return { ok: false, error: "operator_canary.discover_one_source_not_allowed" };
    }
    let rangeDays: number = canaryDiscoveryDefaultRangeDays(sourceKeyRaw as CanaryDiscoverySourceKey);
    if (candidate.rangeDays !== undefined) {
      if (typeof candidate.rangeDays !== "number" || !Number.isInteger(candidate.rangeDays)
        || candidate.rangeDays < 1 || candidate.rangeDays > CANARY_DISCOVERY_MAX_RANGE_DAYS) {
        return { ok: false, error: "operator_canary.discover_one_range_days_invalid" };
      }
      rangeDays = candidate.rangeDays;
    }
    if (candidate.dispatch !== undefined && typeof candidate.dispatch !== "boolean") {
      return { ok: false, error: "operator_canary.discover_one_dispatch_invalid" };
    }
    return {
      ok: true,
      value: {
        payloadKind: "discover-one",
        mode: "discover-one",
        sourceKey: sourceKeyRaw as CanaryDiscoverySourceKey,
        rangeDays,
        operatorId: operator.value,
        dispatch: candidate.dispatch !== false,
      },
    };
  }

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
