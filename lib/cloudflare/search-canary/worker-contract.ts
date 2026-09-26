import type { RankedSearchCount, RankedSearchMode, RankedSearchRange } from "@/lib/cloudflare/search-ranked";
import type { SearchCanaryWriteParam } from "./types";

/**
 * M7.6 isolated canary Worker request/response contract (runtime-neutral).
 *
 * The operator and the isolated `workers/search-canary` Worker share this
 * contract. It is deliberately strict and fail-closed: a request body that is
 * not exactly the documented shape is rejected, and an error response carries a
 * bounded machine code only, never a stack trace, SQL, bound values or the
 * bearer token. The Worker holds the canary D1 + Vectorize bindings; the
 * operator never receives a vector value or document text back.
 */
export const SEARCH_CANARY_WORKER_VERSION = 1 as const;
export const SEARCH_CANARY_WORKER_AUTH_SCHEME = "Bearer" as const;
/** The Worker secret env var holding the shared canary bearer token. */
export const SEARCH_CANARY_WORKER_TOKEN_ENV = "WORLDCONS_SEARCH_CANARY_TOKEN" as const;
/** The operator env var holding the isolated canary Worker base URL. */
export const SEARCH_CANARY_WORKER_URL_ENV = "WORLDCONS_SEARCH_CANARY_WORKER_URL" as const;
/** The operator env var holding the isolated canary D1 database id (HTTP path). */
export const SEARCH_CANARY_DATABASE_ID_ENV = "WORLDCONS_SEARCH_CANARY_DATABASE_ID" as const;
/**
 * Local-dev-only env var that, together with a loopback request hostname,
 * permits the isolated canary Worker to skip bearer auth. It is set ONLY for
 * `wrangler dev` (via `workers/search-canary/.dev.vars`) and is never present in
 * the deployed Worker, so production remains bearer-auth fail-closed. The value
 * must be exactly `true`; any other value (including `1`) does not enable it.
 */
export const SEARCH_CANARY_DEV_UNAUTH_ENV = "WORLDCONS_SEARCH_CANARY_DEV_UNAUTH" as const;

/**
 * The only loopback hostnames eligible for the local-dev unauthenticated path.
 * IPv6 literals arrive from `URL.hostname` bracketed (`[::1]`), so the brackets
 * are stripped before comparison.
 */
const SEARCH_CANARY_LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** True only for the exact loopback hosts `127.0.0.1`, `localhost` and `::1`. */
export function isLoopbackCanaryHostname(hostname: string | null | undefined): boolean {
  if (typeof hostname !== "string") return false;
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  return SEARCH_CANARY_LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * The single decision for the local-dev unauthenticated bypass. It is true only
 * when `devUnauth` is exactly `"true"` AND the request hostname is loopback.
 * Spread requests (non-loopback, including any real deployed hostname) and any
 * Worker without the env var fall through to bearer auth.
 */
export function isCanaryDevUnauthorized(options: {
  devUnauth: string | null | undefined;
  hostname: string | null | undefined;
}): boolean {
  return options.devUnauth === "true" && isLoopbackCanaryHostname(options.hostname);
}

/** One bind-parameterized D1 statement sent to the Worker's D1 binding. */
export interface SearchCanaryWorkerD1Statement {
  sql: string;
  params: SearchCanaryWriteParam[];
}

export interface SearchCanaryWorkerD1Result {
  ok: true;
  changes: number;
  rowsRead: number;
}

export interface SearchCanaryWorkerError {
  ok: false;
  error: string;
}

export type SearchCanaryWorkerD1Response = SearchCanaryWorkerD1Result | SearchCanaryWorkerError;

/** One case the operator asks the Worker to execute through the real bindings. */
export interface SearchCanaryWorkerCase {
  id: string;
  mode: RankedSearchMode;
  query: string;
  source?: string | null;
  jurisdiction?: string | null;
  contentType?: string | null;
  language?: string | null;
  range?: RankedSearchRange;
  limit: number;
  offset: number;
  count?: RankedSearchCount;
  vectorId?: string | null;
}

export interface SearchCanaryWorkerCaseObservation {
  caseId: string;
  latencyMs: number;
  topIds: string[];
  retrievalMode: string;
}

export interface SearchCanaryWorkerCaseError {
  caseId: string;
  latencyMs: number;
  errorCode: string;
}

export type SearchCanaryWorkerCaseResult =
  | SearchCanaryWorkerCaseObservation
  | SearchCanaryWorkerCaseError;

export interface SearchCanaryWorkerRunResponse {
  ok: true;
  observations: SearchCanaryWorkerCaseResult[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

/** A bounded, secret-free error body. Unknown codes collapse to a generic code. */
export function renderCanaryWorkerError(code: string): SearchCanaryWorkerError {
  return { ok: false, error: SAFE_CODE.test(code) ? code : "canary_worker_error" };
}

/**
 * Constant-ish bearer-token check. Fails closed when the Worker has no token
 * configured (`expectedToken` missing/short) or the request presents none. The
 * token itself is never logged, echoed or included in any response.
 */
export function isAuthorizedCanaryRequest(
  authorizationHeader: string | null | undefined,
  expectedToken: string | null | undefined,
): boolean {
  if (typeof expectedToken !== "string" || expectedToken.length < 16) return false;
  if (typeof authorizationHeader !== "string") return false;
  const trimmed = authorizationHeader.trim();
  const prefix = `${SEARCH_CANARY_WORKER_AUTH_SCHEME} `;
  if (!trimmed.startsWith(prefix)) return false;
  const presented = trimmed.slice(prefix.length).trim();
  if (presented.length !== expectedToken.length) return false;
  let diff = 0;
  for (let index = 0; index < presented.length; index += 1) {
    diff |= presented.charCodeAt(index) ^ expectedToken.charCodeAt(index);
  }
  return diff === 0;
}

export function isSearchCanaryWriteParam(value: unknown): value is SearchCanaryWriteParam {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function parseCanaryWorkerD1Statement(value: unknown): SearchCanaryWorkerD1Statement {
  if (!isPlainObject(value)) throw new Error("canary worker d1 statement body must be an object");
  const sql = value.sql;
  if (typeof sql !== "string" || sql.trim().length === 0) throw new Error("canary worker d1 statement sql is required");
  const rawParams = value.params;
  if (!Array.isArray(rawParams)) throw new Error("canary worker d1 statement params must be an array");
  const params = rawParams.map((param) => {
    if (!isSearchCanaryWriteParam(param)) throw new Error("canary worker d1 statement param is unsupported");
    return param;
  });
  return { sql, params };
}

export function parseCanaryWorkerD1Response(value: unknown): SearchCanaryWorkerD1Response {
  if (!isPlainObject(value)) throw new Error("canary worker d1 response must be an object");
  if (value.ok === true) {
    const changes = value.changes;
    const rowsRead = value.rowsRead;
    if (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0) {
      throw new Error("canary worker d1 response changes is invalid");
    }
    if (typeof rowsRead !== "number" || !Number.isInteger(rowsRead) || rowsRead < 0) {
      throw new Error("canary worker d1 response rowsRead is invalid");
    }
    return { ok: true, changes, rowsRead };
  }
  if (value.ok === false && typeof value.error === "string") return { ok: false, error: value.error };
  throw new Error("canary worker d1 response is malformed");
}

const MODES: readonly RankedSearchMode[] = ["fulltext", "semantic", "hybrid"];

function parseCase(value: unknown): SearchCanaryWorkerCase {
  if (!isPlainObject(value)) throw new Error("canary worker case must be an object");
  const id = value.id;
  const mode = value.mode;
  const query = value.query;
  const limit = value.limit;
  const offset = value.offset;
  if (typeof id !== "string" || id.length === 0) throw new Error("canary worker case id is required");
  if (typeof mode !== "string" || !MODES.includes(mode as RankedSearchMode)) {
    throw new Error("canary worker case mode is invalid");
  }
  if (typeof query !== "string") throw new Error("canary worker case query is required");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error("canary worker case limit is invalid");
  }
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("canary worker case offset is invalid");
  }
  const optionalString = (field: unknown): string | null | undefined => {
    if (field === undefined) return undefined;
    if (field === null) return null;
    if (typeof field === "string") return field;
    throw new Error("canary worker case optional string field is invalid");
  };
  return {
    id,
    mode: mode as RankedSearchMode,
    query,
    limit,
    offset,
    source: optionalString(value.source),
    jurisdiction: optionalString(value.jurisdiction),
    contentType: optionalString(value.contentType),
    language: optionalString(value.language),
    range: typeof value.range === "string" ? (value.range as RankedSearchRange) : undefined,
    count: typeof value.count === "string" ? (value.count as RankedSearchCount) : undefined,
    vectorId: optionalString(value.vectorId),
  };
}

export function parseCanaryWorkerRunRequest(value: unknown): SearchCanaryWorkerCase[] {
  if (!isPlainObject(value)) throw new Error("canary worker run body must be an object");
  const cases = value.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("canary worker run body requires a non-empty cases array");
  return cases.map(parseCase);
}

export function parseCanaryWorkerCaseResult(value: unknown): SearchCanaryWorkerCaseResult {
  if (!isPlainObject(value)) throw new Error("canary worker case result must be an object");
  const caseId = value.caseId;
  const latencyMs = value.latencyMs;
  if (typeof caseId !== "string" || caseId.length === 0) throw new Error("canary worker case result caseId is required");
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error("canary worker case result latencyMs is invalid");
  }
  if (typeof value.errorCode === "string") return { caseId, latencyMs, errorCode: value.errorCode };
  const topIds = value.topIds;
  const retrievalMode = value.retrievalMode;
  if (!Array.isArray(topIds) || !topIds.every((id) => typeof id === "string")) {
    throw new Error("canary worker case result topIds is invalid");
  }
  if (typeof retrievalMode !== "string") throw new Error("canary worker case result retrievalMode is invalid");
  return { caseId, latencyMs, topIds, retrievalMode };
}

export function parseCanaryWorkerRunResponse(value: unknown): SearchCanaryWorkerRunResponse {
  if (!isPlainObject(value)) throw new Error("canary worker run response must be an object");
  if (value.ok !== true || !Array.isArray(value.observations)) {
    throw new Error("canary worker run response is malformed");
  }
  return { ok: true, observations: value.observations.map(parseCanaryWorkerCaseResult) };
}
