import {
  ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH,
  ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT,
  ADMIN_OPS_EVENTS_MAX_LIST_LIMIT,
  parseAdminOpsEventReadRow,
  parseAdminOpsEventRecord,
  parseAdminOpsEventWriteRow,
  resolveAdminOpsEventsReadAuthorityConfig,
  resolveEffectiveAdminOpsEventsWriteAuthorityConfig,
  type AdminOpsEventRecord,
  type AdminOpsEventWriteRow,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
  resolveOpsHeartbeatBoundaryAuth,
  type OpsHeartbeatBoundaryOptions,
} from "@/lib/cloudflare/ops-write/boundary-client";

/**
 * Node/operator compatibility client seam for `admin_ops_events`.
 *
 * Manual/local callers run outside the Cloudflare runtime and cannot use a Worker
 * Service Binding. This client lets those callers deliver the three writes the
 * contract needs — insert, read-latest dedupe, prune — to the publicly
 * reachable but authenticated `worldcons-ops-write` boundary over HTTPS,
 * reusing the exact M11.3 base URL / bearer credential. It adds no new
 * credential, host or unauthenticated surface.
 *
 * Resting behavior is unchanged: with the default `supabase` authority every
 * call is a no-op and the caller keeps its existing Supabase client. When
 * `d1-canary`/`d1` is selected the boundary is required and any failure throws,
 * so a broken canary is never silently hidden behind a fallback write.
 */

export const ADMIN_OPS_EVENTS_BOUNDARY_TIMEOUT_MS = 5_000;

export interface AdminOpsEventsBoundaryConfig {
  authority: "supabase" | "d1-canary" | "d1";
  enabled: boolean;
  baseUrl: string | null;
}

function trimToNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveAdminOpsEventsBoundaryConfig(
  environment: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AdminOpsEventsBoundaryConfig {
  const authority = resolveEffectiveAdminOpsEventsWriteAuthorityConfig(environment).authority;
  const baseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  return { authority, enabled: true, baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null };
}

async function boundaryAuthorization(
  config: AdminOpsEventsBoundaryConfig,
  options: OpsHeartbeatBoundaryOptions,
  environment: Record<string, string | undefined>,
): Promise<string> {
  if (!config.baseUrl) throw new Error("admin_ops_events_boundary.not_configured");
  const authorization = await resolveOpsHeartbeatBoundaryAuth(
    {
      authority: config.authority === "d1" ? "d1" : "d1-canary",
      enabled: true,
      baseUrl: config.baseUrl,
      token: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]),
    },
    options,
  );
  if (!authorization) throw new Error("admin_ops_events_boundary.auth_unavailable");
  return authorization;
}

export type AdminOpsEventsBoundaryOptions = OpsHeartbeatBoundaryOptions;

/**
 * Delivers one event insert to the boundary. Returns `false` only when the
 * boundary is intentionally not enabled (resting `supabase`). An
 * enabled-but-unusable boundary throws and must be treated as a failed write,
 * never as a reason to fall back to another writer.
 */
export async function writeAdminOpsEventViaBoundary(
  row: AdminOpsEventWriteRow,
  options: AdminOpsEventsBoundaryOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? (process.env as Record<string, string | undefined>);
  const config = resolveAdminOpsEventsBoundaryConfig(environment);
  if (!config.enabled) return false;
  const authorization = await boundaryAuthorization(config, options, environment);

  const parsed = parseAdminOpsEventWriteRow(row);
  if (!parsed.ok) throw new Error(`admin_ops_events_boundary.invalid_${parsed.error}`);

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${ADMIN_OPS_EVENTS_BOUNDARY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(parsed.row),
    signal: AbortSignal.timeout(ADMIN_OPS_EVENTS_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`admin_ops_events_boundary_failed_${response.status}`);
  }
  await response.body?.cancel();
  return true;
}

export type AdminOpsEventsLatestRead =
  | { enabled: false }
  | { enabled: true; event: AdminOpsEventRecord | null };

/**
 * The dedupe read. Returns `{ enabled: false }` when the boundary is not
 * selected, so the caller keeps its local Supabase read. When enabled the
 * boundary is required: a missing URL/credential, a non-2xx response or a
 * malformed body all throw, so a selected D1 authority fails closed.
 */
export async function readLatestAdminOpsEventViaBoundary(
  options: AdminOpsEventsBoundaryOptions = {},
): Promise<AdminOpsEventsLatestRead> {
  const environment = options.environment ?? (process.env as Record<string, string | undefined>);
  const config = resolveAdminOpsEventsBoundaryConfig(environment);
  if (!config.enabled) return { enabled: false };
  const authorization = await boundaryAuthorization(config, options, environment);

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH}`, {
    method: "GET",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(ADMIN_OPS_EVENTS_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`admin_ops_events_latest_boundary_failed_${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("admin_ops_events_latest_boundary.invalid_response");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("admin_ops_events_latest_boundary.invalid_response");
  }
  const event = (payload as { event?: unknown }).event;
  if (event === null) return { enabled: true, event: null };
  const parsed = parseAdminOpsEventRecord(event);
  if (!parsed) throw new Error("admin_ops_events_latest_boundary.invalid_response");
  return { enabled: true, event: parsed };
}

/**
 * The retention prune. `cutoff` is a Node-computed ISO-8601 instant. Returns
 * `false` when the boundary is not selected; when enabled, any failure throws.
 */
export async function pruneAdminOpsEventsViaBoundary(
  cutoff: string,
  options: AdminOpsEventsBoundaryOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? (process.env as Record<string, string | undefined>);
  const config = resolveAdminOpsEventsBoundaryConfig(environment);
  if (!config.enabled) return false;
  if (typeof cutoff !== "string" || cutoff.length === 0 || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error("admin_ops_events_boundary.invalid_cutoff");
  }
  const authorization = await boundaryAuthorization(config, options, environment);

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify({ cutoff }),
    signal: AbortSignal.timeout(ADMIN_OPS_EVENTS_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`admin_ops_events_prune_boundary_failed_${response.status}`);
  }
  await response.body?.cancel();
  return true;
}

export interface AdminOpsEventsReadBoundaryConfig {
  authority: "supabase" | "d1";
  enabled: boolean;
  baseUrl: string | null;
}

export function resolveAdminOpsEventsReadBoundaryConfig(
  environment: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AdminOpsEventsReadBoundaryConfig {
  const authority = resolveAdminOpsEventsReadAuthorityConfig(environment).authority;
  const baseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  return { authority, enabled: true, baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null };
}

export function adminOpsEventsMaxListLimit() {
  return ADMIN_OPS_EVENTS_MAX_LIST_LIMIT;
}

/**
 * The admin ops list projection. Returns `null` only when the read authority is
 * the resting `supabase` (the caller must keep using its local Supabase read).
 * When `d1` is selected the boundary is required and any failure throws, so a
 * selected D1 read authority fails closed and is never silently downgraded.
 */
export async function listAdminOpsEventsViaBoundary(
  limit: number = ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT,
  options: AdminOpsEventsBoundaryOptions = {},
): Promise<AdminOpsEventRecord[] | null> {
  const environment = options.environment ?? (process.env as Record<string, string | undefined>);
  const config = resolveAdminOpsEventsReadBoundaryConfig(environment);
  if (!config.enabled) return null;
  if (!config.baseUrl) throw new Error("admin_ops_events_read_boundary.not_configured");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_OPS_EVENTS_MAX_LIST_LIMIT) {
    throw new Error("admin_ops_events_read_boundary.invalid_limit");
  }
  const authorization = await resolveOpsHeartbeatBoundaryAuth(
    {
      authority: "d1",
      enabled: true,
      baseUrl: config.baseUrl,
      token: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]),
    },
    options,
  );
  if (!authorization) throw new Error("admin_ops_events_read_boundary.auth_unavailable");

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH}?limit=${limit}`, {
    method: "GET",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(ADMIN_OPS_EVENTS_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`admin_ops_events_list_boundary_failed_${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("admin_ops_events_list_boundary.invalid_response");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("admin_ops_events_list_boundary.invalid_response");
  }
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) throw new Error("admin_ops_events_list_boundary.invalid_response");
  const records: AdminOpsEventRecord[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) throw new Error("admin_ops_events_list_boundary.invalid_response");
    const parsed = parseAdminOpsEventReadRow(entry);
    if (parsed) records.push(parsed);
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
