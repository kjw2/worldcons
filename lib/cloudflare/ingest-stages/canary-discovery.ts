/**
 * Operator single-case **discover-one** canary planner/contract for Germany.
 *
 * This is the missing *seventh* stage for the operator canary. The existing
 * canary (`./canary.ts`) is crawl-first: it seeds a `crawl` job for an
 * operator-supplied official URL and therefore can never produce a literal
 * seven-stage Discovery->Search lineage. This module adds a bounded,
 * fail-closed path that starts at a **genuine `discovery` stage job** which
 * fetches the real official BVerfG homepage SSR anchors (never a user-supplied
 * candidate masquerading as discovery) and yields **exactly one** corresponding
 * canary `crawl` job with same-case provenance.
 *
 * Hard safety properties (all fail-closed):
 *
 * - **Germany only.** `de-bverfg` is the only accepted source; every other key
 *   (including `us-scotus`, FR, ES) is rejected.
 * - **No candidate injection.** The request carries NO candidate URL / ECLI /
 *   docket. Discovery always runs `discoverNativeStageCandidates("de-bverfg", ...)`
 *   against the official court homepage, so the discovered URL is derived from
 *   the official source, not from the caller.
 * - **Bounded.** `limit` must be exactly 1; `rangeDays` is bounded; unknown
 *   top-level keys and unknown `canaryDiscovery` keys are rejected.
 * - **Explicit canary identity.** The discovery job's artifact lives under the
 *   explicit `stages/canary/` prefix (so the preserved per-source gate allows
 *   this non-staged source through only as a controlled exception) and every
 *   lease is stamped `canary-owner:<canaryId>`.
 * - **Durable provenance.** The single child `crawl` job is registered through
 *   the existing audited `completeStageAndRegisterNext` path, which writes the
 *   immutable `job_stage_advanced` edge (`safe_details.nextKey` -> child
 *   idempotency key). The lineage audit walks that edge; the discovery row is a
 *   real job, never fabricated.
 *
 * It performs no network or database work itself and imports no Cloudflare
 * runtime types, so the exact envelope is unit-testable in Node.
 */
import { sha256Canonical } from "@/lib/cloudflare/e2e/contracts";
import { CANARY_PAYLOAD_PREFIX } from "./canary";

/** Only Germany may run the discover-one canary. US stays crawl-first only. */
export const CANARY_DISCOVERY_SOURCE_KEYS = ["de-bverfg"] as const;
export type CanaryDiscoverySourceKey = (typeof CANARY_DISCOVERY_SOURCE_KEYS)[number];

/** The discover-one discriminator key inside a stored discovery-request artifact. */
export const CANARY_DISCOVERY_MARKER = "canaryDiscovery" as const;

/** discover-one is strictly single-case. */
export const CANARY_DISCOVERY_LIMIT = 1 as const;
export const CANARY_DISCOVERY_DEFAULT_RANGE_DAYS = 60 as const;
export const CANARY_DISCOVERY_MAX_RANGE_DAYS = 730 as const;
/**
 * The finite bound on the number of official homepage decision links the canary
 * may observe before it fails closed. A page that advertises more than this many
 * decision links is not treated as a trustworthy single-case discovery source.
 */
export const CANARY_DISCOVERY_MAX_LINKS = 10 as const;

/** Top-level keys allowed on the stored discovery-request artifact. */
export const CANARY_DISCOVERY_REQUEST_KEYS = ["sourceKey", "limit", "rangeDays", CANARY_DISCOVERY_MARKER] as const;
/** Keys allowed on the nested `canaryDiscovery` object. */
export const CANARY_DISCOVERY_MARKER_KEYS = ["canaryId", "operatorId"] as const;

const CANARY_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_OPERATOR_ID_LENGTH = 200;

export interface CanaryDiscoveryMarker {
  canaryId: string;
  operatorId: string;
}

export interface CanaryDiscoveryRequest {
  sourceKey: CanaryDiscoverySourceKey;
  limit: typeof CANARY_DISCOVERY_LIMIT;
  rangeDays: number;
  canaryDiscovery: CanaryDiscoveryMarker;
}

export type CanaryDiscoveryParseResult =
  | { ok: true; value: CanaryDiscoveryRequest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(candidate: Record<string, unknown>, allowed: readonly string[], prefix: string): string | null {
  const permitted = new Set<string>(allowed);
  for (const key of Object.keys(candidate)) {
    if (!permitted.has(key)) return `${prefix}.unknown_key:${key}`;
  }
  return null;
}

function isCanaryDiscoverySource(value: unknown): value is CanaryDiscoverySourceKey {
  return typeof value === "string" && (CANARY_DISCOVERY_SOURCE_KEYS as readonly string[]).includes(value);
}

/**
 * Strictly validates a stored discover-one discovery-request artifact. A JSON
 * string is accepted (the artifact is read back as text) and parsed
 * defensively. Unknown keys, a non-DE source, a non-1 limit, an out-of-range
 * range, or a malformed canary marker all fail closed.
 */
export function parseCanaryDiscoveryRequest(value: unknown): CanaryDiscoveryParseResult {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return { ok: false, error: "canary_discovery.payload_not_json" };
    }
  }
  if (!isRecord(candidate)) return { ok: false, error: "canary_discovery.payload_not_object" };
  const topError = rejectUnknownKeys(candidate, CANARY_DISCOVERY_REQUEST_KEYS, "canary_discovery");
  if (topError) return { ok: false, error: topError };

  if (!isCanaryDiscoverySource(candidate.sourceKey)) return { ok: false, error: "canary_discovery.source_not_allowed" };
  const sourceKey = candidate.sourceKey;

  if (candidate.limit !== CANARY_DISCOVERY_LIMIT) return { ok: false, error: "canary_discovery.limit_must_be_one" };
  if (typeof candidate.rangeDays !== "number" || !Number.isInteger(candidate.rangeDays)
    || candidate.rangeDays < 1 || candidate.rangeDays > CANARY_DISCOVERY_MAX_RANGE_DAYS) {
    return { ok: false, error: "canary_discovery.range_days_invalid" };
  }

  const markerRaw = candidate[CANARY_DISCOVERY_MARKER];
  if (!isRecord(markerRaw)) return { ok: false, error: "canary_discovery.marker_missing" };
  const markerError = rejectUnknownKeys(markerRaw, CANARY_DISCOVERY_MARKER_KEYS, "canary_discovery.marker");
  if (markerError) return { ok: false, error: markerError };

  const canaryId = typeof markerRaw.canaryId === "string" ? markerRaw.canaryId.trim().toLowerCase() : "";
  if (!CANARY_ID_PATTERN.test(canaryId)) return { ok: false, error: "canary_discovery.canary_id_invalid" };

  const operatorId = typeof markerRaw.operatorId === "string" ? markerRaw.operatorId.trim() : "";
  if (operatorId.length === 0 || operatorId.length > MAX_OPERATOR_ID_LENGTH) {
    return { ok: false, error: "canary_discovery.operator_id_invalid" };
  }

  return {
    ok: true,
    value: { sourceKey, limit: CANARY_DISCOVERY_LIMIT, rangeDays: candidate.rangeDays, canaryDiscovery: { canaryId, operatorId } },
  };
}

/**
 * True when a parsed artifact is a discover-one request. The handler uses this
 * to branch before the ordinary fan-out discovery path; an ordinary discovery
 * payload has no `canaryDiscovery` marker.
 */
export function isCanaryDiscoveryRequest(value: unknown): boolean {
  const parsed = parseCanaryDiscoveryRequest(value);
  return parsed.ok;
}

/**
 * Deterministic canary id for discover-one. It derives from the workflow
 * instance identity (stable across a Workflow replay, unique per trigger), so
 * a workflow retry cannot create a second case. The returned 32-hex token is the
 * operator token the existing `advance` Workflow mode presents to continue the
 * chain.
 */
export async function canaryDiscoveryId(sourceKey: CanaryDiscoverySourceKey, instanceSeed: string): Promise<string> {
  const hash = await sha256Canonical({ kind: "canary-discovery", sourceKey, instanceSeed });
  return hash.slice(0, 32);
}

/** The R2 key for the discover-one request artifact (must stay under the canary prefix). */
export function canaryDiscoveryRequestRef(sourceKey: CanaryDiscoverySourceKey, canaryId: string): string {
  return `${CANARY_PAYLOAD_PREFIX}${sourceKey}/${canaryId}.json`;
}

/**
 * The R2 key for the single discovered candidate artifact handed to the child
 * crawl job. It stays under the explicit canary prefix so the preserved
 * per-source gate allows this non-staged source through as a controlled
 * exception only.
 */
export function canaryDiscoveryCandidateRef(sourceKey: CanaryDiscoverySourceKey, contentHash: string): string {
  return `${CANARY_PAYLOAD_PREFIX}${sourceKey}/discovery-${contentHash}.json`;
}

export interface CanaryDiscoverySelection<T> {
  candidate: T | null;
  observed: number;
  reason: string | null;
}

/**
 * Pure, fail-closed selection of exactly one discovered candidate from the
 * bounded observed set. The official homepage legitimately advertises several
 * recent decisions, so the canary deterministically claims **exactly the first
 * (newest)** observed official candidate — it never registers more than one
 * child crawl job. Discovery fails closed with:
 *
 * - `candidate_not_found` when the official homepage yielded zero decisions;
 * - `too_many_links` when the observed set exceeds the finite bound
 *   (`CANARY_DISCOVERY_MAX_LINKS`), i.e. a page that is not a trustworthy
 *   single-case discovery source.
 */
export function selectCanaryDiscoveryCandidate<T>(candidates: readonly T[]): CanaryDiscoverySelection<T> {
  if (candidates.length === 0) return { candidate: null, observed: 0, reason: "canary_discovery.candidate_not_found" };
  if (candidates.length > CANARY_DISCOVERY_MAX_LINKS) {
    return { candidate: null, observed: candidates.length, reason: "canary_discovery.too_many_links" };
  }
  return { candidate: candidates[0], observed: candidates.length, reason: null };
}
