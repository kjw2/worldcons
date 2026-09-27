import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_WRITE_AUTHORITY_ENV,
  parseOpsHeartbeatWriteRow,
  resolveOpsHeartbeatWriteAuthorityConfig,
  type OpsHeartbeatStatus,
} from "@/lib/cloudflare/ops-write/heartbeat";

/**
 * M11.3 Node/GitHub compatibility client seam.
 *
 * The Node/GitHub heartbeat writer runs outside the Cloudflare runtime and
 * cannot use a Worker Service Binding. This client lets those callers deliver a
 * heartbeat to the publicly reachable but bearer-authenticated
 * `worldcons-ops-write` boundary over HTTPS, without ever holding a Supabase
 * credential. The boundary's only entry points (`POST /v1/ops/heartbeat` and
 * `/health`) require the bearer token, so the public workers.dev endpoint
 * exposes no unauthenticated write or diagnostic surface.
 *
 * Resting behavior is unchanged: with the default `supabase` authority (or a
 * missing target URL) the caller returns `false` and keeps using its existing
 * Supabase RPC path. When the authority is explicitly `d1-canary` or `d1` the
 * boundary is required and any failure throws, so a broken canary is never
 * silently hidden behind a fallback write.
 */

export const OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV = "WORLDCONS_OPS_WRITE_BASE_URL";
export const OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV = "WORLDCONS_OPS_WRITE_TOKEN";
const OPS_HEARTBEAT_BOUNDARY_TIMEOUT_MS = 5_000;

export interface OpsHeartbeatBoundaryEnvironment {
  [key: string]: string | undefined;
}

export interface OpsHeartbeatBoundaryConfig {
  authority: "supabase" | "d1-canary" | "d1";
  enabled: boolean;
  baseUrl: string | null;
  token: string | null;
}

export interface OpsHeartbeatBoundaryInput {
  workflowKey: string;
  status: OpsHeartbeatStatus;
  runId: string | null;
  detail: Record<string, unknown>;
  observedAt: string;
}

export interface OpsHeartbeatBoundaryOptions {
  fetcher?: typeof fetch;
  environment?: OpsHeartbeatBoundaryEnvironment;
}

function trimToNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveOpsHeartbeatBoundaryConfig(
  environment: OpsHeartbeatBoundaryEnvironment = process.env as OpsHeartbeatBoundaryEnvironment,
): OpsHeartbeatBoundaryConfig {
  const authority = resolveOpsHeartbeatWriteAuthorityConfig(environment).authority;
  const enabled = authority !== "supabase";
  const baseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  return {
    authority,
    enabled,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null,
    token: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]),
  };
}

/**
 * Delivers one heartbeat to the Cloudflare boundary.
 *
 * Returns `false` only when the boundary is intentionally not enabled (resting
 * `supabase` authority or no configured URL). An enabled-but-unusable boundary
 * throws and must be treated as a failed heartbeat, never as a reason to fall
 * back to another writer.
 */
export async function writeOpsHeartbeatViaBoundary(
  input: OpsHeartbeatBoundaryInput,
  options: OpsHeartbeatBoundaryOptions = {},
): Promise<boolean> {
  const config = resolveOpsHeartbeatBoundaryConfig(options.environment);
  if (!config.enabled) return false;
  if (!config.baseUrl) throw new Error("ops_heartbeat_boundary.not_configured");
  if (!config.token) throw new Error("ops_heartbeat_boundary.token_unavailable");

  const parsed = parseOpsHeartbeatWriteRow({
    workflow_key: input.workflowKey,
    status: input.status,
    run_id: input.runId,
    detail: input.detail,
    observed_at: input.observedAt,
  });
  if (!parsed.ok) throw new Error(`ops_heartbeat_boundary.invalid_${parsed.error}`);

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${OPS_HEARTBEAT_BOUNDARY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(parsed.row),
    signal: AbortSignal.timeout(OPS_HEARTBEAT_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ops_heartbeat_boundary_failed_${response.status}`);
  }
  await response.body?.cancel();
  return true;
}

export function opsHeartbeatWriteAuthorityEnvName() {
  return OPS_HEARTBEAT_WRITE_AUTHORITY_ENV;
}
