import type {
  ArticleLifecycleResult,
  ArticleLifecycleSnapshot,
  ArticleLifecycleTransitionInput,
  ArticleLifecycleTransitionResult,
} from "@/lib/article-lifecycle/types";
import type {
  ArticlePublicationResult,
  ArticlePublicationSnapshot,
  ArticlePublicationTransitionInput,
  ArticlePublicationTransitionResult,
} from "@/lib/article-publication/types";
import {
  CORE_LIFECYCLE_BOUNDARY_PATH,
  CORE_PUBLICATION_BOUNDARY_PATH,
  resolveCoreWriteCanaryMarker,
} from "@/lib/cloudflare/core-write/authority";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  OPS_HEARTBEAT_BOUNDARY_OIDC_TOKEN_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
  requestGithubActionsOidcToken,
} from "@/lib/cloudflare/ops-write/boundary-client";

const CORE_BOUNDARY_TIMEOUT_MS = 8_000;

export interface CoreBoundaryOptions {
  fetcher?: typeof fetch;
  environment?: Record<string, string | undefined>;
  authTokenProvider?: () => Promise<string | null>;
}

function trimToNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function authorization(
  environment: Record<string, string | undefined>,
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

async function post<T>(
  path: string,
  body: unknown,
  options: CoreBoundaryOptions = {},
): Promise<T> {
  const environment = options.environment ?? process.env;
  const rawBaseUrl = trimToNull(environment[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  if (!rawBaseUrl) throw new Error("core_boundary.not_configured");
  const fetcher = options.fetcher ?? fetch;
  const auth = await authorization(environment, fetcher, options.authTokenProvider);
  if (!auth) throw new Error("core_boundary.auth_unavailable");
  const response = await fetcher(`${rawBaseUrl.replace(/\/+$/u, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CORE_BOUNDARY_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(`core_boundary_failed_${response.status}`);
  }
  return payload as T;
}

export function readLifecycleViaCoreBoundary(articleId: string, options: CoreBoundaryOptions = {}) {
  const environment = options.environment ?? process.env;
  return post<ArticleLifecycleResult<ArticleLifecycleSnapshot>>(
    CORE_LIFECYCLE_BOUNDARY_PATH,
    { operation: "get", articleId, canary: resolveCoreWriteCanaryMarker(environment) },
    options,
  );
}

export function transitionLifecycleViaCoreBoundary(
  input: ArticleLifecycleTransitionInput,
  options: CoreBoundaryOptions = {},
) {
  const environment = options.environment ?? process.env;
  return post<ArticleLifecycleResult<ArticleLifecycleTransitionResult>>(
    CORE_LIFECYCLE_BOUNDARY_PATH,
    { operation: "transition", input, canary: resolveCoreWriteCanaryMarker(environment) },
    options,
  );
}

export function readPublicationViaCoreBoundary(articleId: string, options: CoreBoundaryOptions = {}) {
  const environment = options.environment ?? process.env;
  return post<ArticlePublicationResult<ArticlePublicationSnapshot>>(
    CORE_PUBLICATION_BOUNDARY_PATH,
    { operation: "get", articleId, canary: resolveCoreWriteCanaryMarker(environment) },
    options,
  );
}

export function transitionPublicationViaCoreBoundary(
  input: ArticlePublicationTransitionInput,
  options: CoreBoundaryOptions = {},
) {
  const environment = options.environment ?? process.env;
  return post<ArticlePublicationResult<ArticlePublicationTransitionResult>>(
    CORE_PUBLICATION_BOUNDARY_PATH,
    { operation: "transition", input, canary: resolveCoreWriteCanaryMarker(environment) },
    options,
  );
}

export function coreBoundaryEnvironmentDefaults() {
  return {
    [OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]: OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  };
}
