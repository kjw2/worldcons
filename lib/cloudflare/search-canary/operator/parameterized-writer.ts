import { createD1HttpAffectedWriter } from "@/lib/cloudflare/d1/remote/http-query";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { D1Database } from "@/lib/cloudflare/d1/types";
import {
  SEARCH_CANARY_DATABASE_ID_ENV,
  SEARCH_CANARY_DEV_UNAUTH_ENV,
  SEARCH_CANARY_WORKER_TOKEN_ENV,
  SEARCH_CANARY_WORKER_URL_ENV,
  isLoopbackCanaryHostname,
  parseCanaryWorkerD1Response,
  parseCanaryWorkerRunResponse,
  type SearchCanaryWorkerCase,
} from "../worker-contract";
import {
  SEARCH_CANARY_D1_DATABASE,
  type SearchCanaryParameterizedStatement,
  type SearchCanaryWriteTransportKind,
} from "../types";
import type { SearchCanaryWriteExecutor } from "../writer";

/**
 * M7.6 operator-only parameterized writer adapters.
 *
 * These transports replace the M7.5 literalized `wrangler d1 execute --command`
 * write path; each carries the authored `?` SQL and the bound values SEPARATELY
 * so a large `search_text` never enters SQL statement text:
 *
 * - `worker-binding`: POST the statement to the isolated canary Worker, which
 *   executes it through its real D1 binding. The Worker is deployed with the
 *   repository's own Wrangler-authenticated account, so this path is compatible
 *   with the repository's Wrangler login (unlike the connector account that
 *   returned 7403 in M7.5);
 * - `d1-http`: reuse the existing D1 HTTP query primitives
 *   (`createD1HttpAffectedWriter`) with `CLOUDFLARE_ACCOUNT_ID` +
 *   `CLOUDFLARE_API_TOKEN` and the isolated canary database id.
 * - `local-dev` (M7.6 local-only path): send the SAME parameterized statements to
 *   a loopback `wrangler dev` origin (`http://127.0.0.1:PORT`) with NO bearer
 *   token. It is selected only by an explicit `--writer=local-dev` or the
 *   explicit `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true` opt-in, and fails closed
 *   on any non-loopback or non-`http` endpoint, so the deployed bearer secret is
 *   never needed by local/ChatGPT tooling.
 *
 * All are used by the operator CLI only; this module imports `node:`-free code
 * but is deliberately NOT re-exported from the runtime-neutral canary barrel.
 */
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID" as const;
export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN" as const;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface SearchCanaryWriterSelection {
  kind: Exclude<SearchCanaryWriteTransportKind, "none">;
  execute: SearchCanaryWriteExecutor;
  detail: string;
}

export interface SearchCanaryWriterEnv {
  [key: string]: string | undefined;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Loopback-only guard for the unauthenticated `local-dev` transport. It parses
 * the endpoint and fails closed unless the hostname is exactly `127.0.0.1`,
 * `localhost` or `::1` AND the scheme is plain `http` (the local `wrangler dev`
 * origin). Public/HTTPS hosts are rejected, so the tokenless path can never be
 * pointed at a deployed endpoint.
 */
export function assertLoopbackCanaryEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("canary local-dev endpoint is not a valid URL");
  }
  if (url.protocol !== "http:") {
    throw new Error("canary local-dev endpoint must be plain http (https/public hosts are refused)");
  }
  if (!isLoopbackCanaryHostname(url.hostname)) {
    throw new Error("canary local-dev endpoint must be loopback (127.0.0.1, localhost or ::1)");
  }
  return url;
}

/**
 * True only when the operator explicitly opted into the unauthenticated
 * localhost dev mode: `--writer=local-dev`, or `--writer=auto` together with the
 * explicit `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true` env flag. It is never the
 * default for the normal `worker`/`http` modes.
 */
export function isSearchCanaryLocalDevEnabled(options: {
  requested?: string | null;
  env: SearchCanaryWriterEnv;
}): boolean {
  const requested = options.requested ?? "auto";
  if (requested === "local-dev") return true;
  return requested === "auto" && options.env[SEARCH_CANARY_DEV_UNAUTH_ENV] === "true";
}

/** The D1 HTTP parameterized writer, shared with the existing reconcile path. */
export function createHttpSearchCanaryWriter(options: {
  accountId: string;
  apiToken: string;
  databaseId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SearchCanaryWriterSelection {
  const affected = createD1HttpAffectedWriter({
    accountId: options.accountId,
    apiToken: options.apiToken,
    databaseIds: { [SEARCH_CANARY_D1_DATABASE]: options.databaseId } as Partial<Record<D1Database, string>>,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return {
    kind: "d1-http",
    detail: `d1-http writer (database ${SEARCH_CANARY_D1_DATABASE})`,
    async execute(statement: SearchCanaryParameterizedStatement): Promise<number> {
      const { changes } = await affected(SEARCH_CANARY_D1_DATABASE as D1Database, {
        sql: statement.sql,
        params: statement.params,
      } as D1ImportStatement);
      return changes;
    },
  };
}

/** The isolated canary Worker D1-binding writer. */
export function createWorkerSearchCanaryWriter(options: {
  endpoint: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SearchCanaryWriterSelection {
  const base = options.endpoint.replace(/\/+$/, "");
  if (base.length === 0) throw new Error("canary worker endpoint is empty");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: "worker-binding",
    detail: "isolated search-canary Worker D1 binding",
    async execute(statement: SearchCanaryParameterizedStatement): Promise<number> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${base}/d1/statement`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
          body: JSON.stringify({ sql: statement.sql, params: statement.params }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`canary worker d1 statement failed (status ${response.status})`);
        }
        const parsed = parseCanaryWorkerD1Response(await response.json());
        if (!parsed.ok) throw new Error(`canary worker d1 statement rejected: ${parsed.error}`);
        return parsed.changes;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The loopback-only, unauthenticated `wrangler dev` writer. It sends the same
 * parameterized statements to the local dev origin WITHOUT an `authorization`
 * header; the endpoint is validated fail-closed before any request, so this can
 * never target a deployed (https/public/non-loopback) host.
 */
export function createLocalDevSearchCanaryWriter(options: {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SearchCanaryWriterSelection {
  assertLoopbackCanaryEndpoint(options.endpoint);
  const base = options.endpoint.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: "local-dev",
    detail: "local-dev unauthenticated loopback Worker D1 binding (wrangler dev)",
    async execute(statement: SearchCanaryParameterizedStatement): Promise<number> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        assertLoopbackCanaryEndpoint(base);
        const response = await fetchImpl(`${base}/d1/statement`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: statement.sql, params: statement.params }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`canary local-dev d1 statement failed (status ${response.status})`);
        }
        const parsed = parseCanaryWorkerD1Response(await response.json());
        if (!parsed.ok) throw new Error(`canary local-dev d1 statement rejected: ${parsed.error}`);
        return parsed.changes;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Resolves the parameterized writer from explicit flags and the environment.
 * `requested` is `auto`/`worker`/`http`/`local-dev`/`none`; `auto` prefers the
 * Worker (the repository Wrangler account) and falls back to the D1 HTTP path,
 * and selects the tokenless `local-dev` transport only when the explicit
 * `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true` opt-in is set. An explicit request
 * that is not configured throws, while `auto` returns null so a dry-run can
 * still plan. Normal `worker` mode always requires the bearer token; `local-dev`
 * is never the default.
 */
export function resolveSearchCanaryWriter(options: {
  requested?: string | null;
  env: SearchCanaryWriterEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SearchCanaryWriterSelection | null {
  const requested = options.requested ?? "auto";
  const workerUrl = nonEmpty(options.env[SEARCH_CANARY_WORKER_URL_ENV]);
  const workerToken = nonEmpty(options.env[SEARCH_CANARY_WORKER_TOKEN_ENV]);
  const accountId = nonEmpty(options.env[CLOUDFLARE_ACCOUNT_ID_ENV]);
  const apiToken = nonEmpty(options.env[CLOUDFLARE_API_TOKEN_ENV]);
  const databaseId = nonEmpty(options.env[SEARCH_CANARY_DATABASE_ID_ENV]);

  const buildWorker = (): SearchCanaryWriterSelection | null =>
    workerUrl && workerToken
      ? createWorkerSearchCanaryWriter({ endpoint: workerUrl, token: workerToken, fetch: options.fetch, timeoutMs: options.timeoutMs })
      : null;
  const buildHttp = (): SearchCanaryWriterSelection | null =>
    accountId && apiToken && databaseId
      ? createHttpSearchCanaryWriter({ accountId, apiToken, databaseId, fetch: options.fetch, timeoutMs: options.timeoutMs })
      : null;
  const buildLocalDev = (): SearchCanaryWriterSelection => {
    if (!workerUrl) {
      throw new Error(`--writer=local-dev requires ${SEARCH_CANARY_WORKER_URL_ENV}`);
    }
    return createLocalDevSearchCanaryWriter({ endpoint: workerUrl, fetch: options.fetch, timeoutMs: options.timeoutMs });
  };

  if (requested === "none") return null;
  if (requested === "local-dev") return buildLocalDev();
  if (requested === "worker") {
    const writer = buildWorker();
    if (!writer) {
      throw new Error(
        `--writer=worker requires ${SEARCH_CANARY_WORKER_URL_ENV} and ${SEARCH_CANARY_WORKER_TOKEN_ENV}`,
      );
    }
    return writer;
  }
  if (requested === "http") {
    const writer = buildHttp();
    if (!writer) {
      throw new Error(
        `--writer=http requires ${CLOUDFLARE_ACCOUNT_ID_ENV}, ${CLOUDFLARE_API_TOKEN_ENV} and ${SEARCH_CANARY_DATABASE_ID_ENV}`,
      );
    }
    return writer;
  }
  if (requested !== "auto") throw new Error(`unknown --writer value: ${requested}`);
  if (isSearchCanaryLocalDevEnabled({ requested, env: options.env })) return buildLocalDev();
  return buildWorker() ?? buildHttp();
}

/**
 * Resolves the `--binding-canary` target from the environment. A configured
 * token selects the normal authenticated Worker; without a token, the
 * unauthenticated loopback mode is used ONLY when explicitly opted in via
 * `--writer=local-dev` or `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true`, and the
 * endpoint is then validated loopback fail-closed. Returns null when no endpoint
 * is configured (or a token is required but absent), so the CLI can record a
 * bounded blocker instead of calling a remote host.
 */
export function resolveSearchCanaryBindingTarget(options: {
  requested?: string | null;
  env: SearchCanaryWriterEnv;
}): { endpoint: string; token: string | null; localDev: boolean } | null {
  const endpoint = nonEmpty(options.env[SEARCH_CANARY_WORKER_URL_ENV]);
  if (!endpoint) return null;
  const token = nonEmpty(options.env[SEARCH_CANARY_WORKER_TOKEN_ENV]);
  if (token) return { endpoint, token, localDev: false };
  if (!isSearchCanaryLocalDevEnabled({ requested: options.requested, env: options.env })) return null;
  // Explicit local-dev opt-in: fail closed unless loopback http.
  assertLoopbackCanaryEndpoint(endpoint);
  return { endpoint, token: null, localDev: true };
}

export interface SearchCanaryBindingCaseResult {
  caseId: string;
  latencyMs: number;
  topIds: string[];
  retrievalMode: string | null;
  errorCode: string | null;
}

/**
 * Runs the frozen cases through the isolated canary Worker's real D1 + Vectorize
 * bindings and returns the Worker-measured binding latency per case. This is the
 * runtime timing dimension that M7.5 could not observe across the Wrangler
 * process boundary. Only ids/latencies are returned; no vector values or
 * document text cross the boundary.
 */
export async function runWorkerCanaryCases(
  options: {
    endpoint: string;
    token: string | null;
    /**
     * Explicit opt-in required for a tokenless run. When true AND the endpoint
     * is loopback `http`, no `authorization` header is sent; otherwise the
     * normal bearer path is used. A tokenless non-loopback endpoint fails closed.
     */
    allowUnauthenticatedLocalhost?: boolean;
    fetch?: typeof fetch;
    timeoutMs?: number;
  },
  cases: readonly SearchCanaryWorkerCase[],
): Promise<SearchCanaryBindingCaseResult[]> {
  const base = options.endpoint.replace(/\/+$/, "");
  if (base.length === 0) throw new Error("canary worker endpoint is empty");
  let authorization: string | null = null;
  if (typeof options.token === "string" && options.token.length > 0) {
    authorization = `Bearer ${options.token}`;
  } else {
    if (options.allowUnauthenticatedLocalhost !== true) {
      throw new Error("canary worker binding without a token requires the explicit localhost dev opt-in");
    }
    assertLoopbackCanaryEndpoint(base);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/canary/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify({ cases }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`canary worker run failed (status ${response.status})`);
    const parsed = parseCanaryWorkerRunResponse(await response.json());
    return parsed.observations.map((observation) =>
      "errorCode" in observation
        ? { caseId: observation.caseId, latencyMs: observation.latencyMs, topIds: [], retrievalMode: null, errorCode: observation.errorCode }
        : {
            caseId: observation.caseId,
            latencyMs: observation.latencyMs,
            topIds: observation.topIds,
            retrievalMode: observation.retrievalMode,
            errorCode: null,
          },
    );
  } finally {
    clearTimeout(timer);
  }
}

