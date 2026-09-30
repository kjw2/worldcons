import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
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
import {
  ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH,
  ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT,
  ADMIN_OPS_EVENTS_MAX_LIST_LIMIT,
  insertAdminOpsEventToD1,
  listAdminOpsEventsFromD1,
  parseAdminOpsEventWriteRow,
  pruneAdminOpsEventsInD1,
  readLatestAdminOpsEventFromD1,
  resolveAdminOpsEventsReadAuthorityConfig,
  resolveAdminOpsEventsWriteAuthorityConfig,
  shouldReadAdminOpsEventsFromD1,
  shouldWriteAdminOpsEventToD1,
  type AdminOpsEventRecord,
  type AdminOpsEventWriteRow,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  INGEST_RUN_BOUNDARY_PATH,
  applyIngestionRunMutationToD1,
  parseIngestionRunMutation,
  resolveIngestRunWriteAuthorityConfig,
  shouldWriteIngestionRunToD1,
  type IngestionRunMutation,
} from "@/lib/cloudflare/ingest-write/ingestion-runs";
import {
  CORE_LIFECYCLE_BOUNDARY_PATH,
  CORE_PUBLICATION_BOUNDARY_PATH,
  readArticleLifecycleFromD1,
  readArticlePublicationSnapshotFromD1,
  resolveCoreWriteAuthorityConfig,
  shouldUseD1CoreWrite,
  transitionArticleLifecycleInD1,
  transitionArticlePublicationInD1,
} from "@/lib/cloudflare/core-write/authority";
import type { ArticleLifecycleTransitionInput } from "@/lib/article-lifecycle/types";
import type { ArticlePublicationTransitionInput } from "@/lib/article-publication/types";
import { applyM13AuthorityProfileToEnvironment } from "@/lib/cloudflare/m13/authority-profile";

export interface WorldconsOpsWriteWorkerEnv {
  /**
   * Bearer for the public compatibility boundary. Cloudflare-internal service
   * binding paths do not traverse this HTTP authentication surface.
   */
  OPS_WRITE_TOKEN?: string;
  WORLDCONS_M13_AUTHORITY_PROFILE?: string;
  WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY?: string;
  WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY?: string;
  WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY?: string;
  WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY?: string;
  WORLDCONS_INGEST_RUN_WRITE_AUTHORITY?: string;
  WORLDCONS_CORE_WRITE_AUTHORITY?: string;
  WORLDCONS_OPS?: D1RuntimeDatabase;
  WORLDCONS_INGEST?: D1RuntimeDatabase;
  WORLDCONS_CORE?: D1RuntimeDatabase;
  [key: string]: unknown;
}

export type OpsWriteOperation = "read" | "write";

export interface WorldconsOpsWriteDependencies {
  writeToD1?: (binding: D1RuntimeDatabase, row: OpsHeartbeatWriteRow) => Promise<unknown>;
  readFromD1?: (binding: D1RuntimeDatabase) => Promise<OpsHeartbeatReadRecord[]>;
  insertAdminOpsEventToD1?: (binding: D1RuntimeDatabase, row: AdminOpsEventWriteRow) => Promise<AdminOpsEventRecord>;
  readLatestAdminOpsEventFromD1?: (binding: D1RuntimeDatabase) => Promise<AdminOpsEventRecord | null>;
  listAdminOpsEventsFromD1?: (binding: D1RuntimeDatabase, limit: number) => Promise<AdminOpsEventRecord[]>;
  pruneAdminOpsEventsInD1?: (binding: D1RuntimeDatabase, cutoff: string) => Promise<number>;
  applyIngestionRunMutationToD1?: (binding: D1RuntimeDatabase, mutation: IngestionRunMutation) => Promise<number>;
  readArticleLifecycleFromD1?: typeof readArticleLifecycleFromD1;
  transitionArticleLifecycleInD1?: typeof transitionArticleLifecycleInD1;
  readArticlePublicationSnapshotFromD1?: typeof readArticlePublicationSnapshotFromD1;
  transitionArticlePublicationInD1?: typeof transitionArticlePublicationInD1;
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

export function logOpsWriteAuthFailure(
  operation: OpsWriteOperation,
  bearerConfigured: boolean,
): void {
  console.warn(JSON.stringify({
    event: "worldcons_ops_write_auth_failure",
    operation,
    bearerConfigured,
  }));
}

/**
 * Public HTTP trust model: constant-time bearer only. GitHub Actions/OIDC was
 * retired when all operational execution moved to Cloudflare.
 */
export async function opsWriteAuthorized(
  request: Request,
  env: WorldconsOpsWriteWorkerEnv,
  operation: OpsWriteOperation = "write",
) {
  const authorizedByBearer = await opsWriteBearerAuthorized(request, env);
  if (authorizedByBearer) return true;
  logOpsWriteAuthFailure(operation, Boolean(env.OPS_WRITE_TOKEN?.trim()));
  return false;
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
    if (!(await opsWriteAuthorized(request, env, "write"))) {
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
    if (!(await opsWriteAuthorized(request, env, "read"))) {
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

  if (request.method === "POST" && url.pathname === INGEST_RUN_BOUNDARY_PATH) {
    if (!(await opsWriteAuthorized(request, env, "write"))) {
      return json({ error: "unauthorized" }, 401);
    }
    let mutation: IngestionRunMutation;
    try {
      const parsed = parseIngestionRunMutation(await request.json());
      if (!parsed.ok) return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST", reason: parsed.error } }, 400);
      mutation = parsed.mutation;
    } catch {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
    }
    const config = resolveIngestRunWriteAuthorityConfig(env as Record<string, string | undefined>);
    if (!shouldWriteIngestionRunToD1(mutation, config)) {
      return json({ schemaVersion: 1, error: { code: "AUTHORITY_NOT_SELECTED", retryable: false } }, 409);
    }
    try {
      const binding = env.WORLDCONS_INGEST;
      if (!binding) throw new Error("ingestion_run_boundary.d1_binding_unavailable");
      const affected = dependencies.applyIngestionRunMutationToD1
        ? await dependencies.applyIngestionRunMutationToD1(binding, mutation)
        : await applyIngestionRunMutationToD1(binding, mutation);
      return json({ schemaVersion: 1, ok: true, authority: config.authority, target: "d1", affected });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ingest_run_write_error",
        authority: config.authority,
        action: mutation.action,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  if (
    request.method === "POST"
    && (url.pathname === CORE_LIFECYCLE_BOUNDARY_PATH || url.pathname === CORE_PUBLICATION_BOUNDARY_PATH)
  ) {
    if (!(await opsWriteAuthorized(request, env, "write"))) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
    }
    const config = resolveCoreWriteAuthorityConfig(env as Record<string, string | undefined>);
    const canary = body.canary === true;
    if (!shouldUseD1CoreWrite(config, canary)) {
      return json({ schemaVersion: 1, error: { code: "AUTHORITY_NOT_SELECTED", retryable: false } }, 409);
    }
    const binding = env.WORLDCONS_CORE;
    if (!binding) return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    try {
      if (url.pathname === CORE_LIFECYCLE_BOUNDARY_PATH) {
        if (body.operation === "get" && typeof body.articleId === "string") {
          const result = dependencies.readArticleLifecycleFromD1
            ? await dependencies.readArticleLifecycleFromD1(binding, body.articleId)
            : await readArticleLifecycleFromD1(binding, body.articleId);
          return json(result, result.ok ? 200 : result.error.code === "not_found" ? 404 : 409);
        }
        if (body.operation === "transition" && body.input && typeof body.input === "object") {
          const result = dependencies.transitionArticleLifecycleInD1
            ? await dependencies.transitionArticleLifecycleInD1(binding, body.input as ArticleLifecycleTransitionInput)
            : await transitionArticleLifecycleInD1(binding, body.input as ArticleLifecycleTransitionInput);
          return json(result, result.ok ? 200 : result.error.code === "unavailable" ? 503 : 409);
        }
      } else {
        if (body.operation === "get" && typeof body.articleId === "string") {
          const result = dependencies.readArticlePublicationSnapshotFromD1
            ? await dependencies.readArticlePublicationSnapshotFromD1(binding, body.articleId)
            : await readArticlePublicationSnapshotFromD1(binding, body.articleId);
          return json(result, result.ok ? 200 : result.error.code === "not_found" ? 404 : 409);
        }
        if (body.operation === "transition" && body.input && typeof body.input === "object") {
          const result = dependencies.transitionArticlePublicationInD1
            ? await dependencies.transitionArticlePublicationInD1(binding, body.input as ArticlePublicationTransitionInput)
            : await transitionArticlePublicationInD1(binding, body.input as ArticlePublicationTransitionInput);
          return json(result, result.ok ? 200 : result.error.code === "unavailable" ? 503 : 409);
        }
      }
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_core_write_error",
        authority: config.authority,
        path: url.pathname,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  // M11.4 admin_ops_events boundary. The `d1` profile routes every event to
  // `worldcons_ops`; a selected D1 failure always fails closed.
  const adminOpsWriteConfig = resolveAdminOpsEventsWriteAuthorityConfig(env as Record<string, string | undefined>);

  if (request.method === "POST" && url.pathname === ADMIN_OPS_EVENTS_BOUNDARY_PATH) {
    if (!(await opsWriteAuthorized(request, env, "write"))) {
      return json({ error: "unauthorized" }, 401);
    }
    let eventRow: AdminOpsEventWriteRow;
    try {
      const parsed = parseAdminOpsEventWriteRow(await request.json());
      if (!parsed.ok) return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST", reason: parsed.error } }, 400);
      eventRow = parsed.row;
    } catch {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
    }
    const targetD1 = shouldWriteAdminOpsEventToD1(eventRow, adminOpsWriteConfig);
    if (!targetD1) {
      return json({ schemaVersion: 1, error: { code: "AUTHORITY_NOT_SELECTED", retryable: false } }, 409);
    }
    try {
      const binding = env.WORLDCONS_OPS;
      if (!binding) throw new Error("admin_ops_events_boundary.d1_binding_unavailable");
      if (dependencies.insertAdminOpsEventToD1) {
        await dependencies.insertAdminOpsEventToD1(binding, eventRow);
      } else {
        await insertAdminOpsEventToD1(binding, eventRow, crypto.randomUUID());
      }
      return json({ schemaVersion: 1, ok: true, authority: adminOpsWriteConfig.authority, target: "d1" });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ops_write_admin_ops_event_error",
        authority: adminOpsWriteConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  // The dedupe read and retention prune follow the write authority and are D1-only.
  if (request.method === "GET" && url.pathname === ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH) {
    if (!(await opsWriteAuthorized(request, env, "write"))) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      const binding = env.WORLDCONS_OPS;
      if (!binding) throw new Error("admin_ops_events_boundary.d1_binding_unavailable");
      const event = dependencies.readLatestAdminOpsEventFromD1
        ? await dependencies.readLatestAdminOpsEventFromD1(binding)
        : await readLatestAdminOpsEventFromD1(binding);
      return json({ schemaVersion: 1, authority: adminOpsWriteConfig.authority, event });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ops_write_admin_ops_event_latest_error",
        authority: adminOpsWriteConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  // M11.4R admin_ops_events list projection. This reader resolves independently
  // from the write authority, exactly as M11.3R separated the heartbeat read
  // authority. The resting `supabase` has no read to serve and returns a
  // fail-closed 503 instead of relaying Supabase, so a caller that selected the
  // D1 read authority can never be silently served a Supabase list.
  if (request.method === "GET" && url.pathname === ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH) {
    if (!(await opsWriteAuthorized(request, env, "read"))) {
      return json({ error: "unauthorized" }, 401);
    }
    const readConfig = resolveAdminOpsEventsReadAuthorityConfig(env as Record<string, string | undefined>);
    if (!shouldReadAdminOpsEventsFromD1(readConfig)) {
      return json({ schemaVersion: 1, error: { code: "READ_AUTHORITY_UNAVAILABLE", retryable: true } }, 503);
    }
    const parsedLimit = Number(url.searchParams.get("limit") ?? String(ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT));
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > ADMIN_OPS_EVENTS_MAX_LIST_LIMIT) {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST", reason: "invalid_limit" } }, 400);
    }
    try {
      let events: AdminOpsEventRecord[];
      if (dependencies.listAdminOpsEventsFromD1) {
        events = await dependencies.listAdminOpsEventsFromD1(env.WORLDCONS_OPS as D1RuntimeDatabase, parsedLimit);
      } else {
        const binding = env.WORLDCONS_OPS;
        if (!binding) throw new Error("admin_ops_events_boundary.d1_binding_unavailable");
        events = await listAdminOpsEventsFromD1(binding, parsedLimit);
      }
      return json({ schemaVersion: 1, authority: readConfig.authority, events });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ops_write_admin_ops_event_list_error",
        authority: readConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  if (request.method === "POST" && url.pathname === ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH) {
    if (!(await opsWriteAuthorized(request, env, "write"))) {
      return json({ error: "unauthorized" }, 401);
    }
    let cutoff: unknown;
    try {
      cutoff = (await request.json() as { cutoff?: unknown }).cutoff;
    } catch {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST" } }, 400);
    }
    if (typeof cutoff !== "string" || cutoff.length === 0 || cutoff.length > 64 || !Number.isFinite(Date.parse(cutoff))) {
      return json({ schemaVersion: 1, error: { code: "INVALID_REQUEST", reason: "invalid_cutoff" } }, 400);
    }
    try {
      const binding = env.WORLDCONS_OPS;
      if (!binding) throw new Error("admin_ops_events_boundary.d1_binding_unavailable");
      if (dependencies.pruneAdminOpsEventsInD1) await dependencies.pruneAdminOpsEventsInD1(binding, cutoff);
      else await pruneAdminOpsEventsInD1(binding, cutoff);
      return json({ schemaVersion: 1, ok: true, authority: adminOpsWriteConfig.authority, target: "d1" });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_ops_write_admin_ops_event_prune_error",
        authority: adminOpsWriteConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
      return json({ schemaVersion: 1, error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, 503);
    }
  }

  if (request.method !== "POST" || url.pathname !== OPS_HEARTBEAT_BOUNDARY_PATH) {
    return json({ error: "not_found" }, 404);
  }
  if (!(await opsWriteAuthorized(request, env, "write"))) {
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

  // The permanent M13 profile selects D1 for every heartbeat; other targets fail closed.
  const config = resolveOpsHeartbeatWriteAuthorityConfig(env as Record<string, string | undefined>);
  const targetD1 = shouldWriteOpsHeartbeatToD1(row, config);
  if (!targetD1) {
    return json({ schemaVersion: 1, error: { code: "AUTHORITY_NOT_SELECTED", retryable: false } }, 409);
  }
  try {
    if (dependencies.writeToD1) {
      await dependencies.writeToD1(env.WORLDCONS_OPS as D1RuntimeDatabase, row);
    } else {
      const binding = env.WORLDCONS_OPS;
      if (!binding) throw new Error("ops_heartbeat_boundary.d1_binding_unavailable");
      await runOpsHeartbeatUpsertD1(binding, row);
    }
    return json({
      schemaVersion: 1,
      ok: true,
      authority: config.authority,
      target: "d1",
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
    // M13 permanent D1 authority profile. The boundary applies the single
    // bounded switch over its own `env` so every ops-write domain it owns
    // (heartbeats, admin ops events, ingestion runs, core publication) moves
    // together. The resting profile leaves `env` untouched; an invalid profile
    // throws here (fail closed) rather than silently serving the resting default.
    const authorityEnv = applyM13AuthorityProfileToEnvironment(
      env as Record<string, string | undefined>,
    ) as WorldconsOpsWriteWorkerEnv;
    return handleOpsHeartbeatBoundary(request, authorityEnv);
  },
};

export default opsWriteWorker;
