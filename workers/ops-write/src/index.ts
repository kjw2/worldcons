import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
  OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH,
  parseOpsHeartbeatWriteRow,
  readOpsHeartbeatsFromD1,
  resolveOpsHeartbeatReadAuthorityConfig,
  resolveOpsHeartbeatWriteAuthorityConfig,
  runOpsHeartbeatUpsertD1,
  shouldReadOpsHeartbeatFromD1,
  shouldWriteOpsHeartbeatToD1,
  type OpsHeartbeatReadRecord,
  type OpsHeartbeatWriteRow,
} from "@/lib/cloudflare/ops-write/heartbeat";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  resolveGithubOidcTrustConfig,
  verifyGithubOidcToken,
  type GithubOidcTrustConfig,
  type OpsWriteOperation,
} from "@/lib/cloudflare/ops-write/github-oidc";

export interface OpsWriteServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface WorldconsOpsWriteWorkerEnv {
  /**
   * Optional operator/legacy bearer. M11.3-OIDC makes this optional: GitHub
   * Actions authenticate with a per-job OIDC token instead, so the boundary can
   * be created and used without any shared repository secret. When set, the
   * bearer still works for operator canary calls and non-GitHub callers.
   */
  OPS_WRITE_TOKEN?: string;
  WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY?: string;
  WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY?: string;
  WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE?: string;
  WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS?: string;
  WORLDCONS_OPS?: D1RuntimeDatabase;
  WORLDCONS_SEARCH_SERVICE?: OpsWriteServiceFetcher;
  [key: string]: unknown;
}

export interface OpsWriteAuthOptions {
  /** Test seam for the OIDC trust config. */
  oidc?: Partial<GithubOidcTrustConfig>;
}

export interface WorldconsOpsWriteDependencies {
  writeToD1?: (binding: D1RuntimeDatabase, row: OpsHeartbeatWriteRow) => Promise<unknown>;
  writeToSupabase?: (row: OpsHeartbeatWriteRow, env: WorldconsOpsWriteWorkerEnv) => Promise<void>;
  readFromD1?: (binding: D1RuntimeDatabase) => Promise<OpsHeartbeatReadRecord[]>;
  auth?: OpsWriteAuthOptions;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time bearer check against the boundary's own optional secret. */
async function opsWriteBearerAuthorized(request: Request, env: WorldconsOpsWriteWorkerEnv) {
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const expected = env.OPS_WRITE_TOKEN?.trim();
  if (!supplied || !expected) return false;
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

/**
 * M11.3-OIDC dual trust model.
 *
 * A request is authorized when EITHER:
 *   1. it presents a GitHub Actions OIDC JWT whose signature, issuer,
 *      audience, repository, workflow, ref and time claims all verify against
 *      the strict trust policy (the primary path; no shared secret required), or
 *   2. it presents the optional constant-time `OPS_WRITE_TOKEN` bearer (the
 *      legacy/operator path).
 *
 * The bearer is checked second so OIDC remains the preferred, least-privilege
 * path. If `OPS_WRITE_TOKEN` is unset, bearer auth is simply unavailable and
 * OIDC still works, so the first Worker deploy no longer requires the shared
 * secret. Neither path is optional in the sense of being bypassable: a request
 * that satisfies neither is rejected.
 */
export async function opsWriteAuthorized(
  request: Request,
  env: WorldconsOpsWriteWorkerEnv,
  operation: OpsWriteOperation = "write",
  options: OpsWriteAuthOptions = {},
) {
  const oidc = await verifyGithubOidcToken(
    (() => {
      const header = request.headers.get("authorization");
      return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    })(),
    operation,
    resolveGithubOidcTrustConfig(env as Record<string, string | undefined>, options.oidc),
  );
  if (oidc.ok) return true;
  return opsWriteBearerAuthorized(request, env);
}

async function relayHeartbeatToSupabase(
  row: OpsHeartbeatWriteRow,
  env: WorldconsOpsWriteWorkerEnv,
) {
  const binding = env.WORLDCONS_SEARCH_SERVICE;
  if (!binding) throw new Error("ops_heartbeat_boundary.supabase_bridge_unavailable");
  const response = await binding.fetch(new Request(
    `https://worldcons-search.internal${OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    },
  ));
  await response.body?.cancel();
  if (!response.ok) throw new Error("ops_heartbeat_boundary.supabase_bridge_failed");
}

export async function handleOpsHeartbeatBoundary(
  request: Request,
  env: WorldconsOpsWriteWorkerEnv,
  dependencies: WorldconsOpsWriteDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    // Health is a readiness probe, not an operational action; it accepts either
    // trust path but never exposes data. Use the write operation set because a
    // health check from a trusted heartbeat workflow is as narrow as its write.
    if (!(await opsWriteAuthorized(request, env, "write", dependencies.auth))) {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ schemaVersion: 1, service: "worldcons-ops-write", status: "ready" });
  }

  // M11.3R: bearer-authenticated read of the current heartbeat projection. The
  // read authority is resolved independently from the write authority. Unlike a
  // write, a read has no safe local fallback: when the boundary is not selected
  // for D1 reads it returns a fail-closed 503 instead of relaying Supabase, so a
  // caller that selected the D1 read authority can never be silently served a
  // Supabase row. There is no unauthenticated diagnostic surface.
  if (request.method === "GET" && url.pathname === OPS_HEARTBEAT_BOUNDARY_READ_PATH) {
    if (!(await opsWriteAuthorized(request, env, "read", dependencies.auth))) {
      return json({ error: "unauthorized" }, 401);
    }
    const readConfig = resolveOpsHeartbeatReadAuthorityConfig(env as Record<string, string | undefined>);
    if (!shouldReadOpsHeartbeatFromD1(readConfig)) {
      return json({ schemaVersion: 1, error: { code: "READ_AUTHORITY_UNAVAILABLE", retryable: true } }, 503);
    }
    try {
      let records: OpsHeartbeatReadRecord[];
      if (dependencies.readFromD1) {
        records = await dependencies.readFromD1(env.WORLDCONS_OPS as D1RuntimeDatabase);
      } else {
        const binding = env.WORLDCONS_OPS;
        if (!binding) throw new Error("ops_heartbeat_boundary.d1_binding_unavailable");
        records = await readOpsHeartbeatsFromD1(binding);
      }
      return json({ schemaVersion: 1, authority: readConfig.authority, heartbeats: records });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ops_write_heartbeat_read_error",
        authority: readConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  if (request.method !== "POST" || url.pathname !== OPS_HEARTBEAT_BOUNDARY_PATH) {
    return json({ error: "not_found" }, 404);
  }
  if (!(await opsWriteAuthorized(request, env, "write", dependencies.auth))) {
    return json({ error: "unauthorized" }, 401);
  }

  let row: OpsHeartbeatWriteRow;
  try {
    const parsed = parseOpsHeartbeatWriteRow(await request.json());
    if (!parsed.ok) return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST", reason: parsed.error } }, 400);
    row = parsed.row;
  } catch {
    return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
  }

  // Authority is resolved independently by the boundary. `d1-canary` only
  // selects the explicit canary run id; everything else relays to the internal
  // Supabase compatibility bridge on `worldcons-search` (reached over a Service
  // Binding, never the public internet). `d1` routes every heartbeat to D1. A D1
  // failure is returned as 503 and never silently downgraded to Supabase.
  const config = resolveOpsHeartbeatWriteAuthorityConfig(env as Record<string, string | undefined>);
  const targetD1 = shouldWriteOpsHeartbeatToD1(row, config);
  try {
    if (targetD1) {
      if (dependencies.writeToD1) {
        await dependencies.writeToD1(env.WORLDCONS_OPS as D1RuntimeDatabase, row);
      } else {
        const binding = env.WORLDCONS_OPS;
        if (!binding) throw new Error("ops_heartbeat_boundary.d1_binding_unavailable");
        await runOpsHeartbeatUpsertD1(binding, row);
      }
    } else if (dependencies.writeToSupabase) {
      await dependencies.writeToSupabase(row, env);
    } else {
      await relayHeartbeatToSupabase(row, env);
    }
    return json({
      schemaVersion: 1,
      ok: true,
      authority: config.authority,
      target: targetD1 ? "d1" : "supabase",
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "worldcons_ops_write_heartbeat_error",
      authority: config.authority,
      error: error instanceof Error ? error.message : "UnknownError",
    }));
    return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
  }
}

const opsWriteWorker = {
  async fetch(request: Request, env: WorldconsOpsWriteWorkerEnv) {
    return handleOpsHeartbeatBoundary(request, env);
  },
};

export default opsWriteWorker;
