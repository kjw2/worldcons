import { OPS_HEARTBEAT_BOUNDARY_PATH, OPS_HEARTBEAT_BOUNDARY_READ_PATH } from "@/lib/cloudflare/ops-write/heartbeat";

/**
 * M11.3-OIDC: GitHub Actions OIDC trust for the `worldcons-ops-write` boundary.
 *
 * The original M11.3 design authenticated GitHub-hosted callers with a shared
 * repository secret (`WORLDCONS_OPS_WRITE_TOKEN` -> the Worker's
 * `OPS_WRITE_TOKEN`). A shared long-lived secret is the weakest part of that
 * design: it must be copied into GitHub, it does not bind the caller identity,
 * and the execution environment's credential-transfer safety inspection refuses
 * to move the value into the repository. This module replaces that path with
 * short-lived, per-job GitHub Actions OIDC tokens verified inside the Worker.
 *
 * The verification is deliberately strict and fail-closed:
 *
 * - discovery + JWKS are fetched from the exact GitHub issuer only, and a
 *   discovery document whose `issuer`/`jwks_uri` leave that origin is rejected;
 * - only `RS256` is accepted;
 * - the JWT signature is verified with `crypto.subtle` against the discovered
 *   RSA key, and the RSA modulus must be at least 2048 bits;
 * - `iss` must equal the exact issuer; `aud` must equal the dedicated audience;
 * - `repository` must equal `kjw2/worldcons`;
 * - the workflow must be one of the explicitly trusted workflow files *and*
 *   its `workflow_ref` must be exactly `<repo>/<workflow-path>@<allowed-ref>`;
 * - `exp`/`nbf`/`iat` are all required and validated with a bounded clock skew;
 * - a `jti` is required and single-use within its lifetime to blunt replay.
 *
 * The module is runtime-neutral (no `node:*`/`next/*`) so the Worker can bundle
 * it and the focused tests can import it. It never logs or returns a token.
 */

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_DISCOVERY_URL = `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`;
/** The dedicated audience the boundary accepts; never GitHub's default `sts.amazonaws.com`. */
export const WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE = "worldcons-ops-write";
/** The single trusted repository. Exactly one value, not a pattern. */
export const WORLDCONS_OPS_HEARTBEAT_OIDC_REPOSITORY = "kjw2/worldcons";
/** Resting ref allowlist. Only `main` unless an operator explicitly extends it. */
export const WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS_DEFAULT = ["refs/heads/main"] as const;

export const WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE_ENV = "WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE";
export const WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS_ENV = "WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS";

/**
 * Bounded validation windows. The skew is intentionally small; a token that is
 * outside its own `exp`/`nbf`/`iat` window by more than this is rejected.
 */
export const GITHUB_OIDC_MAX_SKEW_SECONDS = 300;
export const GITHUB_OIDC_DEFAULT_SKEW_SECONDS = 60;
/** Replay entries live no longer than a token can: JWKS TTL-bounded. */
export const GITHUB_OIDC_JTI_TTL_SECONDS = 3600;
export const GITHUB_OIDC_DEFAULT_JTI_CACHE_MAX = 4096;
export const GITHUB_OIDC_JWKS_TTL_MS = 3_600_000;
export const GITHUB_OIDC_JWKS_MIN_REFETCH_MS = 30_000;
/** Bounded timeout for each discovery/JWKS HTTP request. */
export const GITHUB_OIDC_FETCH_TIMEOUT_MS = 5_000;
/** Minimum accepted RSA modulus size. */
const GITHUB_OIDC_MIN_RSA_MODULUS_BYTES = 256;

export type OpsWriteOperation = "read" | "write";

/**
 * The exact workflow files trusted for each boundary operation. `workflow_ref`
 * embeds this path, so a token minted for any other workflow — including a
 * brand-new workflow added to the repo — is rejected even though the repository
 * and audience match.
 */
export const OPS_WRITE_TRUSTED_WORKFLOWS: Record<OpsWriteOperation, readonly string[]> = {
  write: [
    ".github/workflows/crawlee-worker.yml",
    ".github/workflows/summary-drain.yml",
    ".github/workflows/embedding-backfill.yml",
    ".github/workflows/admin-watchdog.yml",
    ".github/workflows/admin-command-worker-p1.yml",
  ],
  read: [".github/workflows/admin-watchdog.yml"],
};

export interface GithubOidcTrustConfig {
  issuer: string;
  discoveryUrl: string;
  audience: string;
  repository: string;
  allowedRefs: readonly string[];
  skewSeconds: number;
  jtiTtlSeconds: number;
  jtiCacheMax: number;
  jwksTtlMs: number;
  jwksMinRefetchMs: number;
  fetcher: typeof fetch;
  now: () => number;
}

export interface GithubOidcClaims {
  iss: string;
  aud: string;
  sub: string;
  repository: string;
  ref: string;
  workflow: string;
  workflowRef: string;
  jti: string;
  exp: number;
  nbf: number;
  iat: number;
}

export type GithubOidcFailureCode =
  | "missing_token"
  | "malformed_token"
  | "unsupported_algorithm"
  | "unknown_key"
  | "invalid_signature"
  | "invalid_issuer"
  | "invalid_audience"
  | "invalid_repository"
  | "invalid_workflow"
  | "invalid_ref"
  | "invalid_claims"
  | "token_not_yet_valid"
  | "token_expired"
  | "token_issued_in_future"
  | "replayed_token"
  // Discovery/JWKS trust-chain failures, split so an operator can tell which
  // stage broke without ever logging a URL, body or claim value.
  | "discovery_fetch_failed"
  | "discovery_http_error"
  | "discovery_invalid"
  | "jwks_uri_invalid"
  | "jwks_fetch_failed"
  | "jwks_http_error"
  | "jwks_invalid"
  | "jwks_no_usable_keys";

export type GithubOidcVerification =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; code: GithubOidcFailureCode };

export interface GithubOidcVerifyOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  /** Test seam: bypass the bounded-clock cap when the caller supplies a clock. */
  clockSkewSeconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSkew(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return GITHUB_OIDC_DEFAULT_SKEW_SECONDS;
  }
  return Math.min(Math.floor(value), GITHUB_OIDC_MAX_SKEW_SECONDS);
}

function parseAllowedRefs(raw: string | undefined): readonly string[] {
  if (raw === undefined) return WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS_DEFAULT;
  const refs = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,200}$/u.test(value));
  return refs.length > 0 ? refs : WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS_DEFAULT;
}

/**
 * Builds the trust config from Worker `env`. The audience and repository are not
 * caller-overridable; only the accepted ref allowlist may be extended by an
 * operator-provided var, and only to well-formed `refs/heads|tags/*` values.
 */
export function resolveGithubOidcTrustConfig(
  environment: Record<string, string | undefined> = {},
  overrides: Partial<GithubOidcTrustConfig> = {},
): GithubOidcTrustConfig {
  const audience = environment[WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE_ENV]?.trim();
  return {
    issuer: GITHUB_OIDC_ISSUER,
    discoveryUrl: GITHUB_OIDC_DISCOVERY_URL,
    audience: overrides.audience ?? (audience || WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE),
    repository: WORLDCONS_OPS_HEARTBEAT_OIDC_REPOSITORY,
    allowedRefs: overrides.allowedRefs
      ?? parseAllowedRefs(environment[WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS_ENV]),
    skewSeconds: boundedSkew(overrides.skewSeconds),
    jtiTtlSeconds: overrides.jtiTtlSeconds ?? GITHUB_OIDC_JTI_TTL_SECONDS,
    jtiCacheMax: overrides.jtiCacheMax ?? GITHUB_OIDC_DEFAULT_JTI_CACHE_MAX,
    jwksTtlMs: overrides.jwksTtlMs ?? GITHUB_OIDC_JWKS_TTL_MS,
    jwksMinRefetchMs: overrides.jwksMinRefetchMs ?? GITHUB_OIDC_JWKS_MIN_REFETCH_MS,
    fetcher: overrides.fetcher ?? fetch,
    now: overrides.now ?? (() => Date.now()),
  };
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  if (!header || !payload || !signature) return null;
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return { header, payload, signingInput, signature };
}

function headerString(header: Record<string, unknown>, key: string): string | null {
  const value = header[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function claimString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function claimNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface JwkValidationResult {
  jwk: JsonWebKey;
}

/** Rejects a JWK that is not a sufficiently strong RSA signing key. */
function validateRsaJwk(value: unknown): JwkValidationResult | null {
  if (!isRecord(value)) return null;
  if (value.kty !== "RSA") return null;
  if (value.use !== undefined && value.use !== "sig") return null;
  if (value.alg !== undefined && value.alg !== "RS256") return null;
  if (typeof value.kid !== "string" || value.kid.length === 0) return null;
  if (typeof value.n !== "string" || typeof value.e !== "string") return null;
  const modulus = base64UrlToBytes(value.n);
  if (!modulus || modulus.byteLength < GITHUB_OIDC_MIN_RSA_MODULUS_BYTES) return null;
  return { jwk: value as unknown as JsonWebKey };
}

interface CachedJwks {
  jwksUri: string;
  fetchedAt: number;
  keys: JwkValidationResult[];
}

/** Discovery/JWKS stage failures, a subset of the full failure-code union. */
export type GithubOidcJwksFailureCode =
  | "discovery_fetch_failed"
  | "discovery_http_error"
  | "discovery_invalid"
  | "jwks_uri_invalid"
  | "jwks_fetch_failed"
  | "jwks_http_error"
  | "jwks_invalid"
  | "jwks_no_usable_keys";

type JwksOutcome =
  | { ok: true; cached: CachedJwks }
  | { ok: false; code: GithubOidcJwksFailureCode };

let cachedJwks: CachedJwks | null = null;
let inFlightJwks: Promise<JwksOutcome> | null = null;

/** Clears the module-level JWKS/discovery cache. For tests and forced rotation. */
export function resetGithubOidcCaches(): void {
  cachedJwks = null;
  inFlightJwks = null;
}

/**
 * Calls the configured fetcher as a detached function.
 *
 * The global `fetch` is not an ordinary function in the Workers runtime: when
 * it is invoked as a method (`obj.fetch(...)`), workerd throws `TypeError:
 * Illegal invocation`. The trust config stores `fetcher: fetch`, so calling
 * `trust.fetcher(...)` passes the config object as `this` and always fails,
 * which previously collapsed every discovery/JWKS read into a single opaque
 * `jwks_unavailable`. Rebinding to a plain local call passes `this === undefined`,
 * which the Workers runtime accepts, while leaving the test fetcher seam intact.
 */
function detachedFetch(fetcher: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  const call = fetcher;
  return call(input, init);
}

async function fetchJwks(trust: GithubOidcTrustConfig): Promise<JwksOutcome> {
  let discovery: Response;
  try {
    discovery = await detachedFetch(trust.fetcher, trust.discoveryUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(GITHUB_OIDC_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "discovery_fetch_failed" };
  }
  if (!discovery.ok) {
    await discovery.body?.cancel();
    return { ok: false, code: "discovery_http_error" };
  }
  let discoveryBody: unknown;
  try {
    discoveryBody = await discovery.json();
  } catch {
    return { ok: false, code: "discovery_invalid" };
  }
  if (!isRecord(discoveryBody)) return { ok: false, code: "discovery_invalid" };
  if (discoveryBody.issuer !== trust.issuer) return { ok: false, code: "discovery_invalid" };
  const jwksUri = discoveryBody.jwks_uri;
  if (typeof jwksUri !== "string" || !jwksUri.startsWith(`${trust.issuer}/`)) {
    return { ok: false, code: "jwks_uri_invalid" };
  }

  let response: Response;
  try {
    response = await detachedFetch(trust.fetcher, jwksUri, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(GITHUB_OIDC_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "jwks_fetch_failed" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, code: "jwks_http_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "jwks_invalid" };
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) return { ok: false, code: "jwks_invalid" };
  const keys = body.keys.flatMap((key) => {
    const validated = validateRsaJwk(key);
    return validated ? [validated] : [];
  });
  if (keys.length === 0) return { ok: false, code: "jwks_no_usable_keys" };
  return { ok: true, cached: { jwksUri, fetchedAt: trust.now(), keys } };
}

async function loadJwks(trust: GithubOidcTrustConfig, force: boolean): Promise<JwksOutcome> {
  const fresh = cachedJwks
    && trust.now() - cachedJwks.fetchedAt < trust.jwksTtlMs
    && !force;
  if (fresh) return { ok: true, cached: cachedJwks as CachedJwks };
  if (inFlightJwks) return inFlightJwks;
  inFlightJwks = fetchJwks(trust).then(
    (result) => {
      if (result.ok) cachedJwks = result.cached;
      inFlightJwks = null;
      return result;
    },
    (): JwksOutcome => {
      inFlightJwks = null;
      return { ok: false, code: "discovery_fetch_failed" };
    },
  );
  return inFlightJwks;
}

async function selectKey(
  trust: GithubOidcTrustConfig,
  kid: string,
): Promise<{ key: JsonWebKey } | { code: GithubOidcFailureCode }> {
  let outcome = await loadJwks(trust, false);
  let match = outcome.ok
    ? outcome.cached.keys.find((key) => (key.jwk as { kid?: string }).kid === kid)
    : undefined;
  if (!match && outcome.ok && trust.now() - outcome.cached.fetchedAt >= trust.jwksMinRefetchMs) {
    outcome = await loadJwks(trust, true);
    match = outcome.ok
      ? outcome.cached.keys.find((key) => (key.jwk as { kid?: string }).kid === kid)
      : undefined;
  }
  if (match) return { key: match.jwk };
  // We hold a usable, discovered JWKS but the token's kid is not in it: the key
  // is genuinely unknown. Without a usable JWKS the stage failure is surfaced
  // verbatim so the operator can tell discovery from fetch from key-set errors.
  if (outcome.ok) return { code: "unknown_key" };
  return { code: outcome.code };
}

async function verifySignature(signingInput: Uint8Array, signature: Uint8Array, jwk: JsonWebKey) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(signingInput),
    );
  } catch {
    return false;
  }
}

/** Copies a byte view into a plain ArrayBuffer-backed source for `crypto.subtle`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function expectedWorkflowRef(trust: GithubOidcTrustConfig, workflowPath: string, ref: string) {
  return `${trust.repository}/${workflowPath}@${ref}`;
}

/** Resolves which workflow paths are trusted for an operation. */
export function trustedWorkflowsForOperation(operation: OpsWriteOperation): readonly string[] {
  return OPS_WRITE_TRUSTED_WORKFLOWS[operation];
}

/** Extracts the `.github/workflows/<file>.yml` path from a `workflow_ref`. */
function workflowPathFromRef(workflowRef: string): string | null {
  const at = workflowRef.lastIndexOf("@");
  if (at <= 0) return null;
  const withoutRef = workflowRef.slice(0, at);
  const marker = "/.github/workflows/";
  const index = withoutRef.indexOf(marker);
  if (index < 0) return null;
  const path = withoutRef.slice(index + 1);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u.test(path)) return null;
  return path;
}

/**
 * Verifies one GitHub Actions OIDC JWT for a boundary operation.
 *
 * Returns a stable failure code and never throws / never returns token material.
 * Any discovery, JWKS, network, parse or crypto error fails closed.
 */
export async function verifyGithubOidcToken(
  token: string | null | undefined,
  operation: OpsWriteOperation,
  trust: GithubOidcTrustConfig,
): Promise<GithubOidcVerification> {
  if (typeof token !== "string" || token.length === 0) return { ok: false, code: "missing_token" };

  const parsed = parseJwt(token);
  if (!parsed) return { ok: false, code: "malformed_token" };

  if (headerString(parsed.header, "alg") !== "RS256") {
    return { ok: false, code: "unsupported_algorithm" };
  }
  const kid = headerString(parsed.header, "kid");
  if (!kid) return { ok: false, code: "malformed_token" };

  const { payload } = parsed;

  if (claimString(payload, "iss") !== trust.issuer) return { ok: false, code: "invalid_issuer" };
  if (claimString(payload, "aud") !== trust.audience) return { ok: false, code: "invalid_audience" };
  if (claimString(payload, "repository") !== trust.repository) {
    return { ok: false, code: "invalid_repository" };
  }

  const exp = claimNumber(payload, "exp");
  const nbf = claimNumber(payload, "nbf");
  const iat = claimNumber(payload, "iat");
  if (exp === null || nbf === null || iat === null) return { ok: false, code: "invalid_claims" };
  if (nbf > exp) return { ok: false, code: "invalid_claims" };

  const jti = claimString(payload, "jti");
  if (!jti) return { ok: false, code: "invalid_claims" };

  const workflowRef = claimString(payload, "workflow_ref");
  const ref = claimString(payload, "ref");
  const workflow = claimString(payload, "workflow");
  if (!workflowRef || !ref || workflow === null) return { ok: false, code: "invalid_claims" };

  const workflowPath = workflowPathFromRef(workflowRef);
  if (!workflowPath || !trustedWorkflowsForOperation(operation).includes(workflowPath)) {
    return { ok: false, code: "invalid_workflow" };
  }
  if (!trust.allowedRefs.includes(ref)) return { ok: false, code: "invalid_ref" };
  if (workflowRef !== expectedWorkflowRef(trust, workflowPath, ref)) {
    return { ok: false, code: "invalid_workflow" };
  }

  const nowSeconds = Math.floor(trust.now() / 1_000);
  const skew = trust.skewSeconds;
  if (nbf > nowSeconds + skew) return { ok: false, code: "token_not_yet_valid" };
  if (iat > nowSeconds + skew) return { ok: false, code: "token_issued_in_future" };
  if (exp <= nowSeconds - skew) return { ok: false, code: "token_expired" };

  const selected = await selectKey(trust, kid);
  if (!("key" in selected)) return { ok: false, code: selected.code };

  if (!(await verifySignature(parsed.signingInput, parsed.signature, selected.key))) {
    return { ok: false, code: "invalid_signature" };
  }

  if (!recordJti(jti, trust, nowSeconds)) return { ok: false, code: "replayed_token" };

  return {
    ok: true,
    claims: {
      iss: trust.issuer,
      aud: trust.audience,
      sub: claimString(payload, "sub") ?? "",
      repository: trust.repository,
      ref,
      workflow,
      workflowRef,
      jti,
      exp,
      nbf,
      iat,
    },
  };
}

const seenJti = new Map<string, number>();
let jtiSweepAt = 0;

function sweepJti(nowSeconds: number) {
  if (nowSeconds - jtiSweepAt < 60) return;
  jtiSweepAt = nowSeconds;
  for (const [jti, expiresAt] of seenJti) {
    if (expiresAt <= nowSeconds) seenJti.delete(jti);
  }
}

/**
 * Records a `jti` as used. Returns `false` if it was already seen within its
 * live window, which fails the request closed. The cache is process-local (a
 * Worker isolate), so this is a best-effort, bounded anti-replay control: it
 * strictly prevents the common retry/replay of a captured token against the
 * same isolate without claiming a globally consistent replay ledger.
 */
export function recordJti(jti: string, trust: GithubOidcTrustConfig, nowSeconds: number): boolean {
  sweepJti(nowSeconds);
  if (seenJti.has(jti)) return false;
  if (seenJti.size >= trust.jtiCacheMax) {
    const oldest = seenJti.keys().next();
    if (!oldest.done) seenJti.delete(oldest.value);
  }
  seenJti.set(jti, nowSeconds + trust.jtiTtlSeconds);
  return true;
}

/** Clears the anti-replay cache. For tests. */
export function resetGithubOidcReplayCache(): void {
  seenJti.clear();
  jtiSweepAt = 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/**
 * Verifies the request's bearer token as a GitHub OIDC JWT for `operation`.
 * Convenience wrapper used by the Worker boundary.
 */
export async function authorizeGithubOidcRequest(
  request: Request,
  operation: OpsWriteOperation,
  environment: Record<string, string | undefined>,
  overrides: Partial<GithubOidcTrustConfig> = {},
): Promise<GithubOidcVerification> {
  const trust = resolveGithubOidcTrustConfig(environment, overrides);
  return verifyGithubOidcToken(bearerToken(request), operation, trust);
}

/** The boundary paths that may use OIDC, for documentation/tests. */
export const OIDC_PROTECTED_PATHS = [OPS_HEARTBEAT_BOUNDARY_PATH, OPS_HEARTBEAT_BOUNDARY_READ_PATH] as const;
