import {
  INGEST_RUN_BOUNDARY_PATH,
  resolveIngestRunCanaryMarker,
  resolveIngestRunWriteAuthorityConfig,
  shouldWriteIngestionRunToD1,
  type IngestionRunMutation,
  type IngestRunWriteAuthorityEnvironment,
} from "@/lib/cloudflare/ingest-write/ingestion-runs";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
  requestGithubActionsOidcToken,
} from "@/lib/cloudflare/ops-write/boundary-client";

const INGEST_RUN_BOUNDARY_TIMEOUT_MS = 5_000;

export interface IngestionRunBoundaryOptions {
  fetcher?: typeof fetch;
  environment?: IngestRunWriteAuthorityEnvironment;
  authTokenProvider?: () => Promise<string | null>;
}

type WithoutCanary<T> = T extends unknown ? Omit<T, "canary"> : never;
export type IngestionRunBoundaryInput = WithoutCanary<IngestionRunMutation>;

function trimToNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function authorization(
  environment: IngestRunWriteAuthorityEnvironment,
  fetcher: typeof fetch,
  provider?: () => Promise<string | null>,
) {
  if (provider) return provider();
  const explicitOidc = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV]);
  if (explicitOidc) return `Bearer ${explicitOidc}`;
  const oidc = await requestGithubActionsOidcToken(environment, fetcher);
  if (oidc) return `Bearer ${oidc}`;
  const token = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]);
  return token ? `Bearer ${token}` : null;
}

export async function writeIngestionRunViaBoundary(
  input: IngestionRunBoundaryInput,
  options: IngestionRunBoundaryOptions = {},
): Promise<{ affected: number } | null> {
  const environment = options.environment ?? process.env as IngestRunWriteAuthorityEnvironment;
  const config = resolveIngestRunWriteAuthorityConfig(environment);
  const mutation = { ...input, canary: resolveIngestRunCanaryMarker(environment) } as IngestionRunMutation;
  if (!shouldWriteIngestionRunToD1(mutation, config)) return null;

  const rawBaseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  if (!rawBaseUrl) throw new Error("ingestion_run_boundary.not_configured");
  const baseUrl = rawBaseUrl.replace(/\/+$/u, "");
  const fetcher = options.fetcher ?? fetch;
  const auth = await authorization(environment, fetcher, options.authTokenProvider);
  if (!auth) throw new Error("ingestion_run_boundary.auth_unavailable");

  const response = await fetcher(`${baseUrl}${INGEST_RUN_BOUNDARY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body: JSON.stringify(mutation),
    signal: AbortSignal.timeout(INGEST_RUN_BOUNDARY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ingestion_run_boundary_failed_${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  if (
    typeof payload !== "object"
    || payload === null
    || (payload as { ok?: unknown }).ok !== true
    || !Number.isSafeInteger((payload as { affected?: unknown }).affected)
  ) {
    throw new Error("ingestion_run_boundary.invalid_response");
  }
  return { affected: Number((payload as { affected: number }).affected) };
}

export function ingestionRunBoundaryEnvironmentDefaults() {
  return {
    [OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]: OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  };
}
