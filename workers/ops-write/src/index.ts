import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH,
  parseOpsHeartbeatWriteRow,
  resolveOpsHeartbeatWriteAuthorityConfig,
  runOpsHeartbeatUpsertD1,
  shouldWriteOpsHeartbeatToD1,
  type OpsHeartbeatWriteRow,
} from "@/lib/cloudflare/ops-write/heartbeat";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

export interface OpsWriteServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface WorldconsOpsWriteWorkerEnv {
  OPS_WRITE_TOKEN?: string;
  WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY?: string;
  WORLDCONS_OPS?: D1RuntimeDatabase;
  WORLDCONS_SEARCH_SERVICE?: OpsWriteServiceFetcher;
  [key: string]: unknown;
}

export interface WorldconsOpsWriteDependencies {
  writeToD1?: (binding: D1RuntimeDatabase, row: OpsHeartbeatWriteRow) => Promise<unknown>;
  writeToSupabase?: (row: OpsHeartbeatWriteRow, env: WorldconsOpsWriteWorkerEnv) => Promise<void>;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time bearer check against the boundary's own secret. */
export async function opsWriteAuthorized(request: Request, env: WorldconsOpsWriteWorkerEnv) {
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const expected = env.OPS_WRITE_TOKEN?.trim();
  if (!supplied || !expected) return false;
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
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
    if (!(await opsWriteAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
    return json({ schemaVersion: 1, service: "worldcons-ops-write", status: "ready" });
  }

  if (request.method !== "POST" || url.pathname !== OPS_HEARTBEAT_BOUNDARY_PATH) {
    return json({ error: "not_found" }, 404);
  }
  if (!(await opsWriteAuthorized(request, env))) return json({ error: "unauthorized" }, 401);

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
