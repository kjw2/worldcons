import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
  OPS_HEARTBEAT_READ_AUTHORITY_ENV,
  OPS_HEARTBEAT_WRITE_AUTHORITY_ENV,
  parseOpsHeartbeatReadRecord,
  parseOpsHeartbeatWriteRow,
  resolveOpsHeartbeatReadAuthorityConfig,
  resolveOpsHeartbeatWriteAuthorityConfig,
  type OpsHeartbeatReadRecord,
  type OpsHeartbeatStatus,
  type OpsHeartbeatWorkflowKey,
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
/** Optional explicit GitHub OIDC JWT, useful for tests/operator one-offs. */
export const OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV = "WORLDCONS_OPS_WRITE_OIDC_TOKEN";
/** Dedicated OIDC audience; must match the boundary's configured audience. */
export const OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV = "WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE";
export const OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE = "worldcons-ops-write";
const OPS_HEARTBEAT_BOUNDARY_TIMEOUT_MS = 5_000;

export interface OpsHeartbeatBoundaryEnvironment {
  [key: string]: string | undefined;
}

export interface OpsHeartbeatBoundaryConfig {
  authority: "supabase" | "d1-canary" | "d1";
  enabled: boolean;
  baseUrl: string | null;
  /** Optional operator/legacy shared bearer (the boundary's OPS_WRITE_TOKEN). */
  token: string | null;
  /** Optional explicit OIDC JWT; otherwise one is requested from the Actions runtime. */
  oidcToken: string | null;
  oidcAudience: string;
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
  /**
   * Supplies the Authorization header value for the boundary request. When
   * omitted, an OIDC token is preferred (explicit env, then a live request to
   * the GitHub Actions OIDC endpoint when `ACTIONS_ID_TOKEN_REQUEST_URL` is
   * present), and the optional shared bearer is used only as a fallback.
   */
  authTokenProvider?: () => Promise<string | null>;
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
  const audience = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]);
  return {
    authority,
    enabled,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null,
    token: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]),
    oidcToken: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV]),
    oidcAudience: audience ?? OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  };
}

/**
 * Requests a short-lived GitHub Actions OIDC JWT for the dedicated audience.
 *
 * The Actions runtime injects `ACTIONS_ID_TOKEN_REQUEST_URL` /
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and only then can a token be minted; the
 * value is returned to the caller and never logged. Returns `null` outside
 * GitHub Actions (or when the workflow lacks `id-token: write`), letting the
 * caller fall back to the optional bearer.
 */
export async function requestGithubActionsOidcToken(
  environment: OpsHeartbeatBoundaryEnvironment = process.env as OpsHeartbeatBoundaryEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const requestUrl = trimToNull(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  const requestToken = trimToNull(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  if (!requestUrl || !requestToken) return null;
  const audience = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV])
    ?? OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE;
  let response: Response;
  try {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    response = await fetcher(url.toString(), {
      headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(OPS_HEARTBEAT_BOUNDARY_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolves the Authorization header value for a boundary request. OIDC is the
 * preferred, secret-free path; the optional shared bearer is the fallback.
 */
export async function resolveOpsHeartbeatBoundaryAuth(
  config: OpsHeartbeatBoundaryConfig,
  options: OpsHeartbeatBoundaryOptions,
): Promise<string | null> {
  if (options.authTokenProvider) return options.authTokenProvider();
  if (config.oidcToken) return `Bearer ${config.oidcToken}`;
  const requested = await requestGithubActionsOidcToken(
    options.environment,
    options.fetcher ?? fetch,
  );
  if (requested) return `Bearer ${requested}`;
  if (config.token) return `Bearer ${config.token}`;
  return null;
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
  const authorization = await resolveOpsHeartbeatBoundaryAuth(config, options);
  if (!authorization) throw new Error("ops_heartbeat_boundary.auth_unavailable");

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
      Authorization: authorization,
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

export interface OpsHeartbeatReadBoundaryEnvironment {
  [key: string]: string | undefined;
}

export interface OpsHeartbeatReadBoundaryConfig {
  authority: "supabase" | "d1";
  enabled: boolean;
  baseUrl: string | null;
  token: string | null;
  oidcToken: string | null;
  oidcAudience: string;
}

export function resolveOpsHeartbeatReadBoundaryConfig(
  environment: OpsHeartbeatReadBoundaryEnvironment = process.env as OpsHeartbeatReadBoundaryEnvironment,
): OpsHeartbeatReadBoundaryConfig {
  const authority = resolveOpsHeartbeatReadAuthorityConfig(environment).authority;
  const baseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  const audience = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]);
  return {
    authority,
    enabled: authority === "d1",
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null,
    token: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]),
    oidcToken: trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV]),
    oidcAudience: audience ?? OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  };
}

/**
 * M11.3R Node/GitHub read client for the `d1` read authority.
 *
 * Returns `null` only when the read authority is the resting `supabase` (the
 * caller must then keep using its local Supabase read). When `d1` is selected
 * the boundary is required: a missing URL/token, a non-2xx response or a
 * malformed body all throw, so a selected D1 read authority fails closed and is
 * never silently downgraded to a stale or absent Supabase result.
 *
 * The read travels over the same publicly reachable but bearer-authenticated
 * `worldcons-ops-write` boundary; it adds no new endpoint and no new credential.
 */
export async function readOpsHeartbeatsViaBoundary(
  options: OpsHeartbeatBoundaryOptions = {},
): Promise<OpsHeartbeatReadRecord[] | null> {
  const config = resolveOpsHeartbeatReadBoundaryConfig(options.environment);
  if (!config.enabled) return null;
  if (!config.baseUrl) throw new Error("ops_heartbeat_read_boundary.not_configured");
  const authorization = await resolveOpsHeartbeatBoundaryAuth(config, options);
  if (!authorization) throw new Error("ops_heartbeat_read_boundary.auth_unavailable");

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${config.baseUrl}${OPS_HEARTBEAT_BOUNDARY_READ_PATH}`, {
    method: "GET",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(OPS_HEARTBEAT_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ops_heartbeat_read_boundary_failed_${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("ops_heartbeat_read_boundary.invalid_response");
  }
  if (!isReadResponse(payload)) throw new Error("ops_heartbeat_read_boundary.invalid_response");
  const records: OpsHeartbeatReadRecord[] = [];
  for (const row of payload.heartbeats) {
    const parsed = parseOpsHeartbeatReadRecord(row);
    if (!parsed) continue;
    records.push(parsed);
  }
  return records;
}

function isReadResponse(value: unknown): value is { heartbeats: Record<string, unknown>[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const heartbeats = (value as { heartbeats?: unknown }).heartbeats;
  return Array.isArray(heartbeats) && heartbeats.every(
    (row) => typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

export function opsHeartbeatReadAuthorityEnvName() {
  return OPS_HEARTBEAT_READ_AUTHORITY_ENV;
}

export type { OpsHeartbeatReadRecord, OpsHeartbeatWorkflowKey };
