import { runVectorRankedSearchPage } from "@/lib/cloudflare/search-vector";
import type {
  VectorizeIndexBinding,
  VectorizeMatch,
  VectorizeQueryOptions,
  VectorizeQueryResult,
} from "@/lib/cloudflare/search-vector";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  isAuthorizedCanaryRequest,
  isCanaryDevUnauthorized,
  parseCanaryWorkerD1Statement,
  parseCanaryWorkerRunRequest,
  renderCanaryWorkerError,
  SEARCH_CANARY_WORKER_VERSION,
  type SearchCanaryWorkerCase,
  type SearchCanaryWorkerCaseResult,
} from "@/lib/cloudflare/search-canary/worker-contract";
import {
  buildCanaryQueryEmbedding,
  hasCanaryVectorId,
  SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE,
} from "@/lib/cloudflare/search-canary/vector-id";

/**
 * WorldCons M7.6 isolated search canary Worker.
 *
 * This Worker is NOT the production Worker (`worker/index.ts`) and is NOT
 * deployed by any production config. It holds the isolated, non-production
 * canary D1 + Vectorize bindings only, serves no production route and has no
 * custom domain. It exists so the M7.6 operator can measure real binding/runtime
 * latency for the same frozen canary cases, separately from Wrangler operator
 * wall time, and so D1 projection writes can be sent as bound parameters instead
 * of literalized SQL text.
 *
 * Security / no-leak:
 * - every route requires a shared bearer token (fail closed when the Worker has
 *   no token configured), EXCEPT the explicit local-dev path: only when
 *   `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH === "true"` (set for `wrangler dev`
 *   only, never deployed) AND the request hostname is loopback
 *   (`127.0.0.1`/`localhost`/`::1`) may auth be skipped;
 * - an error response carries a bounded machine code only (never SQL, bound
 *   values, stack traces or the token);
 * - only ids/scores/counts are returned; document text and vector values never
 *   leave the Worker.
 */
interface CanaryD1Result<T = Record<string, unknown>> {
  success?: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
  error?: string | null;
}

interface CanaryD1PreparedStatement {
  bind(...values: unknown[]): CanaryD1PreparedStatement;
  run?(): Promise<CanaryD1Result>;
  all<T = Record<string, unknown>>(): Promise<CanaryD1Result<T>>;
}

interface CanaryD1Database {
  prepare(query: string): CanaryD1PreparedStatement;
}

interface CanaryVectorizeQueryResult {
  matches: VectorizeMatch[];
  count?: number;
}

interface CanaryVectorizeIndex {
  query(values: number[], options: VectorizeQueryOptions): Promise<CanaryVectorizeQueryResult>;
  queryById?(id: string, options: VectorizeQueryOptions): Promise<CanaryVectorizeQueryResult>;
}

interface CanaryEnv {
  SEARCH_CANARY_DB?: CanaryD1Database;
  SEARCH_CANARY_INDEX?: CanaryVectorizeIndex;
  WORLDCONS_SEARCH_CANARY_TOKEN?: string;
  /**
   * Local-dev-only flag. When exactly `"true"` AND the request hostname is
   * loopback, bearer auth is skipped so ChatGPT tooling can drive the canary
   * through `wrangler dev` without ever reading the deployed bearer secret.
   * Absent in production, so the deployed Worker always requires bearer auth.
   */
  WORLDCONS_SEARCH_CANARY_DEV_UNAUTH?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string): Response {
  return json(renderCanaryWorkerError(code), status);
}

async function runD1Statement(
  binding: CanaryD1Database,
  sql: string,
  params: readonly unknown[],
): Promise<{ changes: number; rowsRead: number; results: Record<string, unknown>[] }> {
  const prepared = binding.prepare(sql).bind(...params);
  // D1 provides `.run()` for writes and `.all()` for reads. When `.run()` is
  // absent (a structural test double) fall back to `.all()`, which also executes.
  const result = typeof prepared.run === "function" ? await prepared.run() : await prepared.all();
  if (result && result.success === false) {
    throw new Error("canary_d1_statement_failed");
  }
  const meta = result?.meta ?? {};
  const rawChanges = (meta as Record<string, unknown>).changes;
  const rawRowsRead = (meta as Record<string, unknown>).rows_read;
  const changes = typeof rawChanges === "number" && Number.isFinite(rawChanges) ? rawChanges : 0;
  const rowsRead = typeof rawRowsRead === "number" && Number.isFinite(rawRowsRead) ? rawRowsRead : 0;
  return { changes, rowsRead, results: (result?.results ?? []) as Record<string, unknown>[] };
}

function vectorBindingForCase(
  index: CanaryVectorizeIndex,
  caseDef: SearchCanaryWorkerCase,
): VectorizeIndexBinding | null {
  if (caseDef.mode === "fulltext") return null;
  // Semantic/hybrid canary cases are vectorId-backed only. The caller rejects a
  // missing id fail-closed before reaching here; this guard keeps the adapter
  // from ever forwarding a query vector to the real index if bypassed.
  if (!hasCanaryVectorId(caseDef.vectorId)) {
    throw Object.assign(new Error("canary semantic/hybrid case requires a vectorId"), {
      code: SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE,
    });
  }
  const vectorId = caseDef.vectorId;
  if (typeof index.queryById !== "function") throw new Error("canary_vectorize_query_by_id_unsupported");
  return {
    async query(_vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      // The Worker-synthesized embedding is deliberately ignored: this canary is
      // resolved by artifact vectorId, so no query vector is ever sent.
      const result = await index.queryById!(vectorId, options);
      return { matches: result.matches, count: result.count };
    },
  };
}

async function handleCanaryRun(env: CanaryEnv, body: unknown): Promise<Response> {
  const cases = parseCanaryWorkerRunRequest(body);
  if (!env.SEARCH_CANARY_DB) return error(503, "canary_d1_binding_unavailable");
  const observations: SearchCanaryWorkerCaseResult[] = [];
  for (const caseDef of cases) {
    const needsVector = caseDef.mode !== "fulltext";
    if (needsVector && !hasCanaryVectorId(caseDef.vectorId)) {
      observations.push({ caseId: caseDef.id, latencyMs: 0, errorCode: SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE });
      continue;
    }
    if (needsVector && !env.SEARCH_CANARY_INDEX) {
      observations.push({ caseId: caseDef.id, latencyMs: 0, errorCode: "canary_vectorize_binding_unavailable" });
      continue;
    }
    const started = Date.now();
    try {
      const vector = needsVector ? vectorBindingForCase(env.SEARCH_CANARY_INDEX as CanaryVectorizeIndex, caseDef) : null;
      const payload = await runVectorRankedSearchPage({
        d1: env.SEARCH_CANARY_DB as unknown as D1RuntimeDatabase,
        vector,
        input: {
          query: caseDef.query,
          mode: caseDef.mode,
          limit: caseDef.limit,
          offset: caseDef.offset,
          source: caseDef.source ?? null,
          jurisdiction: caseDef.jurisdiction ?? null,
          contentType: caseDef.contentType ?? null,
          language: caseDef.language ?? null,
          tag: null,
          range: caseDef.range ?? "latest",
          count: caseDef.count ?? "none",
          // Semantic/hybrid cases get a local-only unit vector solely to satisfy
          // the orchestrator's non-empty-embedding guard; the vectorId adapter
          // ignores it. Fulltext stays on its unchanged null-embedding branch.
          embedding: needsVector ? buildCanaryQueryEmbedding() : null,
          referenceNow: new Date().toISOString(),
        },
      });
      observations.push({
        caseId: caseDef.id,
        latencyMs: Date.now() - started,
        topIds: payload.entries.map((entry) => entry.id).slice(0, 10),
        retrievalMode: payload.retrievalMode,
      });
    } catch (caught) {
      const rawCode = (caught as { code?: unknown } | null)?.code;
      const code = typeof rawCode === "string" ? rawCode : "canary_run_failed";
      observations.push({ caseId: caseDef.id, latencyMs: Date.now() - started, errorCode: code });
    }
  }
  return json({ ok: true, observations });
}

async function handleVectorizeQuery(env: CanaryEnv, body: unknown): Promise<Response> {
  if (!env.SEARCH_CANARY_INDEX) return error(503, "canary_vectorize_binding_unavailable");
  if (typeof body !== "object" || body === null) return error(400, "canary_invalid_body");
  const record = body as Record<string, unknown>;
  const topK = record.topK;
  if (typeof topK !== "number" || !Number.isInteger(topK) || topK <= 0) return error(400, "canary_invalid_topk");
  const options: VectorizeQueryOptions = {
    topK,
    returnValues: false,
    returnMetadata: record.returnMetadata === "all" || record.returnMetadata === "none" ? record.returnMetadata : "indexed",
  };
  const filter = record.filter;
  if (typeof filter === "object" && filter !== null && !Array.isArray(filter) && Object.keys(filter).length > 0) {
    options.filter = filter as VectorizeQueryOptions["filter"];
  }
  try {
    let result: CanaryVectorizeQueryResult;
    if (typeof record.vectorId === "string" && record.vectorId.length > 0) {
      if (typeof env.SEARCH_CANARY_INDEX.queryById !== "function") return error(400, "canary_query_by_id_unsupported");
      result = await env.SEARCH_CANARY_INDEX.queryById(record.vectorId, options);
    } else if (Array.isArray(record.vector) && record.vector.every((value) => typeof value === "number")) {
      result = await env.SEARCH_CANARY_INDEX.query(record.vector as number[], options);
    } else {
      return error(400, "canary_missing_vector");
    }
    return json({ ok: true, matches: result.matches.map((match) => ({ id: match.id, score: match.score })) });
  } catch {
    return error(502, "canary_vectorize_query_failed");
  }
}

const worker = {
  async fetch(request: Request, env: CanaryEnv): Promise<Response> {
    const url = new URL(request.url);
    // Local-dev bypass: requires BOTH the explicit dev flag (never deployed) and
    // a loopback hostname. Anything else stays on the mandatory bearer path.
    const devUnauthorized = isCanaryDevUnauthorized({
      devUnauth: env.WORLDCONS_SEARCH_CANARY_DEV_UNAUTH,
      hostname: url.hostname,
    });
    if (
      !devUnauthorized &&
      !isAuthorizedCanaryRequest(request.headers.get("authorization"), env.WORLDCONS_SEARCH_CANARY_TOKEN ?? null)
    ) {
      return error(401, "unauthorized");
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        version: SEARCH_CANARY_WORKER_VERSION,
        d1Binding: env.SEARCH_CANARY_DB !== undefined,
        vectorizeBinding: env.SEARCH_CANARY_INDEX !== undefined,
      });
    }
    if (request.method !== "POST") return error(405, "method_not_allowed");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error(400, "canary_invalid_json");
    }
    if (path === "/d1/statement") {
      if (!env.SEARCH_CANARY_DB) return error(503, "canary_d1_binding_unavailable");
      try {
        const statement = parseCanaryWorkerD1Statement(body);
        const result = await runD1Statement(env.SEARCH_CANARY_DB, statement.sql, statement.params);
        return json({ ok: true, changes: result.changes, rowsRead: result.rowsRead });
      } catch {
        return error(400, "canary_d1_statement_rejected");
      }
    }
    if (path === "/vectorize/query") return handleVectorizeQuery(env, body);
    if (path === "/canary/run") return handleCanaryRun(env, body);
    return error(404, "not_found");
  },
};

export default worker;
