/**
 * Provider-owned T3 Service Binding adapter candidates.
 *
 * Public HTTPS `/api/cclrag2` and its existing auth/rate-limit remain unchanged.
 * Same-account Cloudflare bindings are not tenant trust. RPC stays fail-closed
 * until the T1 contract is owner-signed, the dedicated S2S bearer is configured,
 * and the caller presents that bearer. This module never accepts arbitrary URLs,
 * never shares raw D1/R2, and never treats catalog-only worldlaw as case/statute
 * evidence.
 */
import {
  getWorldconsProviderCapabilities,
  WORLDCONS_PROVIDER_CONTRACT_VERSION,
  WORLDCONS_PROVIDER_LIMITS,
} from "./capabilities";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
  type ProviderDependencies,
} from "./provider-handler";

export const WORLDCONS_T3_ADAPTER_ID = "worldcons-t3-search-v1" as const;
export const WORLDCONS_T3_RPC_METHOD = "searchV1" as const;
export const WORLDCONS_T3_CONTRACT_VERSION = WORLDCONS_PROVIDER_CONTRACT_VERSION;
export const WORLDCONS_T3_INTERNAL_ORIGIN = "https://worldcons.t3.invalid";
export const WORLDCONS_T3_S2S_HEADER = "Authorization";
export const WORLDCONS_T3_DEFAULT_TIMEOUT_MS = 8_000;
export const WORLDCONS_T3_SCOPE = "published_foreign_constitutional" as const;
export const WORLDCONS_T3_OPERATIONS = Object.freeze(["search", "capabilities"] as const);

export const WORLDCONS_T3_ENV = Object.freeze({
  bindingEnabled: "WORLDCONS_CCLRAG2_T3_BINDING_ENABLED",
  t1ContractStatus: "WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS",
  s2sToken: "WORLDCONS_CCLRAG2_S2S_TOKEN",
} as const);

const ALLOWED_OPERATIONS = new Set<string>(WORLDCONS_T3_OPERATIONS);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const BEARER_PREFIX = "Bearer ";

export type WorldconsT3Operation = (typeof WORLDCONS_T3_OPERATIONS)[number];
export type WorldconsT3Scope = typeof WORLDCONS_T3_SCOPE;

/** Versioned RPC argument. Authorization is S2S only and is not a query semantic. */
export type WorldconsSearchV1Arg = {
  operation: WorldconsT3Operation;
  scope: WorldconsT3Scope;
  query: string;
  limit: number;
  contractVersion: typeof WORLDCONS_T3_CONTRACT_VERSION;
  authorization?: string;
};

export type WorldconsT3BindingEnv = Cclrag2ProviderEnv & {
  WORLDCONS_CCLRAG2_T3_BINDING_ENABLED?: string;
  WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS?: string;
  WORLDCONS_CCLRAG2_S2S_TOKEN?: string;
  WORLDCONS_PORTAL_TOKEN?: string;
  WORLDCONS_CORE?: unknown;
  WORLDCONS_SEARCH?: unknown;
  WORLDCONS_SEARCH_VECTOR?: unknown;
  WORLDCONS_RAW?: unknown;
};

export type WorldconsT3SearchDispatchInput = {
  arg: unknown;
  env: WorldconsT3BindingEnv;
  dependencies?: ProviderDependencies;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
};

export type WorldconsT3AdapterStatus = {
  adapterId: typeof WORLDCONS_T3_ADAPTER_ID;
  rpcMethod: typeof WORLDCONS_T3_RPC_METHOD;
  contractVersion: typeof WORLDCONS_T3_CONTRACT_VERSION;
  bindingEnabled: boolean;
  t1ContractSigned: boolean;
  s2sTokenConfigured: boolean;
  authentication: "bearer_s2s";
  publicHttpsAuthentication: "none";
  sameAccountBindingSufficient: false;
  anonymousRpcAllowed: false;
  arbitraryUrlsAllowed: false;
  rawD1R2Shared: false;
  catalogOnlyWorldlawPrimaryEvidence: false;
  liveCloudflareBindingProvisioned: false;
};

class T3RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "T3RequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function getWorldconsT3AdapterStatus(env: WorldconsT3BindingEnv | undefined): WorldconsT3AdapterStatus {
  return {
    adapterId: WORLDCONS_T3_ADAPTER_ID,
    rpcMethod: WORLDCONS_T3_RPC_METHOD,
    contractVersion: WORLDCONS_T3_CONTRACT_VERSION,
    bindingEnabled: worldconsT3BindingIsEnabled(env),
    t1ContractSigned: isSignedT1Contract(env),
    s2sTokenConfigured: Boolean(configuredS2sToken(env)),
    authentication: "bearer_s2s",
    publicHttpsAuthentication: "none",
    sameAccountBindingSufficient: false,
    anonymousRpcAllowed: false,
    arbitraryUrlsAllowed: false,
    rawD1R2Shared: false,
    catalogOnlyWorldlawPrimaryEvidence: false,
    liveCloudflareBindingProvisioned: false,
  };
}

export function worldconsT3BindingIsEnabled(env: WorldconsT3BindingEnv | undefined): boolean {
  return env?.WORLDCONS_CCLRAG2_T3_BINDING_ENABLED?.trim() === "true"
    && isSignedT1Contract(env)
    && Boolean(configuredS2sToken(env));
}

export function getWorldconsT3SafeCapability(): ReturnType<typeof getWorldconsProviderCapabilities> & {
  t3: {
    adapterId: typeof WORLDCONS_T3_ADAPTER_ID;
    rpcMethod: typeof WORLDCONS_T3_RPC_METHOD;
    authentication: "bearer_s2s";
    defaultBindingEnabled: false;
    sameAccountBindingSufficient: false;
    evidence: {
      sourceType: "foreign_constitutional";
      authorityLevel: "persuasive";
      catalogOnlyWorldlawPrimaryEvidence: false;
      metadataOnlyUntilSigned: true;
    };
  };
} {
  const manifest = getWorldconsProviderCapabilities();
  return {
    ...manifest,
    t3: {
      adapterId: WORLDCONS_T3_ADAPTER_ID,
      rpcMethod: WORLDCONS_T3_RPC_METHOD,
      authentication: "bearer_s2s",
      defaultBindingEnabled: false,
      sameAccountBindingSufficient: false,
      evidence: {
        sourceType: "foreign_constitutional",
        authorityLevel: "persuasive",
        catalogOnlyWorldlawPrimaryEvidence: false,
        metadataOnlyUntilSigned: true,
      },
    },
  };
}

/**
 * Typed future RPC adapter. Node tests must use this function. Instantiating
 * `WorkerEntrypoint` here is not a live Cloudflare RPC success.
 */
export async function searchV1(
  arg: unknown,
  env: WorldconsT3BindingEnv,
  dependencies: ProviderDependencies = {},
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  return dispatchWorldconsT3SearchV1({
    arg,
    env,
    dependencies,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export async function dispatchWorldconsT3SearchV1(input: WorldconsT3SearchDispatchInput): Promise<Response> {
  const requestId = crypto.randomUUID();
  const timeoutMs = boundedTimeoutMs(input.timeoutMs);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ?? deadline;

  try {
    if (signal.aborted || deadline.aborted) {
      throw new T3RequestError(503, "SERVICE_UNAVAILABLE", "The WorldCons T3 search request was cancelled or timed out.", true);
    }
    if (!worldconsT3BindingIsEnabled(input.env)) {
      throw new T3RequestError(
        503,
        "BINDING_DISABLED",
        "The WorldCons T3 service-binding adapter is disabled until the T1 contract is signed and the caller is verified.",
      );
    }

    const arg = parseSearchV1Arg(input.arg);
    await assertAuthorizedS2sCaller(arg.authorization, input.env);
    assertNoCrossOwnerResources(input.env, input.dependencies);

    if (arg.operation === "capabilities") {
      return jsonResponse({
        ...getWorldconsT3SafeCapability(),
        requestId,
      }, 200, requestId, WORLDCONS_PROVIDER_LIMITS.capabilitiesResponseBytes);
    }

    const request = createWorldconsT3ProviderFetchRequest(arg, requestId);
    const response = await handleWorldconsSearchRequest(request, providerEnvFrom(input.env), {
      fetcher: rejectedNetworkFetcher,
      ...input.dependencies,
    });
    if (signal.aborted || deadline.aborted) {
      throw new T3RequestError(503, "SERVICE_UNAVAILABLE", "The WorldCons T3 search request was cancelled or timed out.", true);
    }
    return response;
  } catch (error) {
    if (error instanceof T3RequestError) {
      return errorResponse(error.status, error.code, error.message, requestId, error.retryable);
    }
    return errorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "WorldCons search is temporarily unavailable.",
      requestId,
      true,
    );
  }
}

/** Fixed-path Request factory. Callers cannot supply a URL. */
export function createWorldconsT3ProviderFetchRequest(arg: WorldconsSearchV1Arg, requestId = crypto.randomUUID()): Request {
  const url = new URL("/api/search", WORLDCONS_T3_INTERNAL_ORIGIN);
  url.searchParams.set("q", arg.query);
  url.searchParams.set("mode", "hybrid");
  url.searchParams.set("count", "none");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", String(arg.limit));
  return new Request(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Request-Id": requestId,
    },
  });
}

export function parseSearchV1Arg(value: unknown): WorldconsSearchV1Arg {
  const record = asRecord(value);
  if (!record) {
    throw new T3RequestError(400, "INVALID_REQUEST", "searchV1 requires an object argument.");
  }

  const extraKeys = Object.keys(record).filter((key) => (
    key !== "operation"
    && key !== "scope"
    && key !== "query"
    && key !== "limit"
    && key !== "contractVersion"
    && key !== "authorization"
  ));
  if (extraKeys.length > 0) {
    throw new T3RequestError(400, "INVALID_REQUEST", "searchV1 does not accept additional fields.");
  }

  if (record.contractVersion !== WORLDCONS_T3_CONTRACT_VERSION) {
    throw new T3RequestError(400, "INVALID_REQUEST", `contractVersion must be ${WORLDCONS_T3_CONTRACT_VERSION}.`);
  }
  if (typeof record.operation !== "string" || !ALLOWED_OPERATIONS.has(record.operation)) {
    throw new T3RequestError(400, "INVALID_REQUEST", "operation must be search or capabilities.");
  }
  if (record.scope !== WORLDCONS_T3_SCOPE) {
    throw new T3RequestError(
      400,
      "INVALID_REQUEST",
      "scope must be published_foreign_constitutional. Catalog-only worldlaw is not primary case or statute evidence.",
    );
  }
  if (typeof record.query !== "string") {
    throw new T3RequestError(400, "INVALID_REQUEST", "query must be a string.");
  }

  const query = record.query.normalize("NFKC").trim();
  if (query.length > WORLDCONS_PROVIDER_LIMITS.queryChars || CONTROL_CHARACTER_PATTERN.test(query)) {
    throw new T3RequestError(400, "INVALID_REQUEST", "query must be at most 200 characters and contain no control characters.");
  }
  if (looksLikeCallerSuppliedUrl(query) || looksLikeCallerSuppliedUrl(record.authorization)) {
    throw new T3RequestError(400, "INVALID_REQUEST", "Arbitrary URLs are not accepted.");
  }

  const limit = boundedLimit(record.limit);
  const authorization = typeof record.authorization === "string" ? record.authorization : undefined;
  return {
    operation: record.operation as WorldconsT3Operation,
    scope: WORLDCONS_T3_SCOPE,
    query,
    limit,
    contractVersion: WORLDCONS_T3_CONTRACT_VERSION,
    ...(authorization ? { authorization } : {}),
  };
}

async function assertAuthorizedS2sCaller(authorization: string | undefined, env: WorldconsT3BindingEnv): Promise<void> {
  const expected = configuredS2sToken(env);
  if (!expected) {
    throw new T3RequestError(
      503,
      "BINDING_DISABLED",
      "The WorldCons T3 service-binding adapter is disabled until the T1 contract is signed and the caller is verified.",
    );
  }

  const supplied = bearerTokenFrom(authorization);
  if (!supplied) {
    throw new T3RequestError(401, "AUTH_REQUIRED", "A Bearer S2S token is required.");
  }

  const portal = env.WORLDCONS_PORTAL_TOKEN?.trim() || "";
  if (portal && await tokensEqual(supplied, portal) && !await tokensEqual(supplied, expected)) {
    throw new T3RequestError(403, "FORBIDDEN", "The catalog portal token cannot authorize case search.");
  }

  if (!await tokensEqual(supplied, expected)) {
    throw new T3RequestError(403, "FORBIDDEN", "The integration token is invalid.");
  }
}

function assertNoCrossOwnerResources(env: WorldconsT3BindingEnv, dependencies: ProviderDependencies | undefined) {
  if (env.WORLDCONS_RAW && dependencies?.fetcher === undefined) {
    // R2 may exist on the worker env; the adapter never forwards it.
  }
  const forwarded = dependencies ?? {};
  const keys = Object.keys(forwarded);
  for (const key of keys) {
    if (key !== "fetcher" && key !== "coreBinding" && key !== "searchBinding" && key !== "vectorBinding") {
      throw new T3RequestError(400, "INVALID_REQUEST", "Unsupported provider dependency.");
    }
  }
}

function isSignedT1Contract(env: WorldconsT3BindingEnv | undefined): boolean {
  return env?.WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS?.trim() === "signed";
}

function configuredS2sToken(env: WorldconsT3BindingEnv | undefined): string | null {
  const token = env?.WORLDCONS_CCLRAG2_S2S_TOKEN?.trim() || "";
  return token || null;
}

function bearerTokenFrom(authorization: string | undefined): string {
  const value = authorization?.trim() ?? "";
  if (value.length < BEARER_PREFIX.length || value.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return "";
  }
  return value.slice(BEARER_PREFIX.length).trim();
}

function boundedLimit(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new T3RequestError(
      400,
      "INVALID_REQUEST",
      `limit must be an integer between 1 and ${WORLDCONS_PROVIDER_LIMITS.pageSize}.`,
    );
  }
  const limit = value as number;
  if (limit < 1 || limit > WORLDCONS_PROVIDER_LIMITS.pageSize) {
    throw new T3RequestError(
      400,
      "INVALID_REQUEST",
      `limit must be an integer between 1 and ${WORLDCONS_PROVIDER_LIMITS.pageSize}.`,
    );
  }
  return limit;
}

function boundedTimeoutMs(value: number | undefined): number {
  if (value === undefined) return WORLDCONS_T3_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1) return WORLDCONS_T3_DEFAULT_TIMEOUT_MS;
  return Math.min(value, WORLDCONS_T3_DEFAULT_TIMEOUT_MS);
}

function looksLikeCallerSuppliedUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^https?:\/\//iu.test(trimmed) || /^\/\//u.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerEnvFrom(env: WorldconsT3BindingEnv): Cclrag2ProviderEnv {
  return {
    ENVIRONMENT: env.ENVIRONMENT?.trim() || "production",
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL?.trim() || "https://worldcons.cclib.workers.dev/api/cclrag2",
    EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
    SEMANTIC_SEARCH_ENABLED: env.SEMANTIC_SEARCH_ENABLED,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GEMINI_EMBEDDING_MODEL: env.GEMINI_EMBEDDING_MODEL,
  };
}

async function rejectedNetworkFetcher(): Promise<Response> {
  throw new T3RequestError(400, "INVALID_REQUEST", "Arbitrary URLs are not accepted.");
}

async function tokensEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0 && left.length === right.length;
}

function jsonResponse(body: unknown, status: number, requestId: string, maxBytes: number): Response {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    return errorResponse(
      503,
      "RESPONSE_TOO_LARGE",
      "The bounded WorldCons response could not be produced.",
      requestId,
      true,
    );
  }
  return new Response(serialized, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Provider-Contract-Version": WORLDCONS_T3_CONTRACT_VERSION,
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable = status === 429 || status === 503,
): Response {
  const serialized = JSON.stringify({
    contractVersion: WORLDCONS_T3_CONTRACT_VERSION,
    schemaVersion: 1,
    requestId,
    service: "worldcons",
    error: {
      code,
      message,
      retryable,
    },
  });
  return new Response(serialized, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Provider-Contract-Version": WORLDCONS_T3_CONTRACT_VERSION,
      "X-Request-Id": requestId,
    },
  });
}
