import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  GITHUB_OIDC_DISCOVERY_URL,
  GITHUB_OIDC_ISSUER,
  OPS_WRITE_TRUSTED_WORKFLOWS,
  WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE,
  WORLDCONS_OPS_HEARTBEAT_OIDC_REPOSITORY,
  authorizeGithubOidcRequest,
  resetGithubOidcCaches,
  resetGithubOidcReplayCache,
  resolveGithubOidcTrustConfig,
  verifyGithubOidcToken,
  type GithubOidcTrustConfig,
} from "@/lib/cloudflare/ops-write/github-oidc";
import { handleOpsHeartbeatBoundary, type WorldconsOpsWriteWorkerEnv } from "@/workers/ops-write/src/index";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URI = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = "worldcons-ops-write";
const REPOSITORY = "kjw2/worldcons";
const WORKFLOW_REF = "kjw2/worldcons/.github/workflows/crawlee-worker.yml@refs/heads/main";

const KEY_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) } as const;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

interface KeyPair {
  kid: string;
  privateKey: webcrypto.CryptoKey;
  jwk: JsonWebKey;
}

async function generateKeyPair(kid = "test-key-1"): Promise<KeyPair> {
  const pair = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey,
  };
}

interface TokenClaims {
  iss?: string;
  aud?: string;
  repository?: string;
  ref?: string;
  workflow?: string;
  workflow_ref?: string;
  jti?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
}

async function signToken(
  key: KeyPair,
  claims: TokenClaims,
  options: { alg?: string; kid?: string | null } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header: Record<string, unknown> = { typ: "JWT", alg: options.alg ?? "RS256" };
  if (options.kid !== null) header.kid = options.kid ?? key.kid;
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    repository: REPOSITORY,
    ref: "refs/heads/main",
    workflow: "Crawlee worker ingest",
    workflow_ref: WORKFLOW_REF,
    sub: `repo:${REPOSITORY}:ref:refs/heads/main`,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    iat: now,
    nbf: now,
    exp: now + 600,
    ...claims,
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

interface DiscoveryOptions {
  issuer?: unknown;
  jwksUri?: unknown;
  jwksStatus?: number;
  discoveryStatus?: number;
  jwksKeys?: unknown;
}

function oidcFetcher(key: KeyPair, options: DiscoveryOptions = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === GITHUB_OIDC_DISCOVERY_URL) {
      if (options.discoveryStatus && options.discoveryStatus !== 200) {
        return new Response(null, { status: options.discoveryStatus });
      }
      return Response.json({
        issuer: options.issuer === undefined ? ISSUER : options.issuer,
        jwks_uri: options.jwksUri === undefined ? JWKS_URI : options.jwksUri,
      });
    }
    if (url === JWKS_URI) {
      if (options.jwksStatus && options.jwksStatus !== 200) {
        return new Response(null, { status: options.jwksStatus });
      }
      return Response.json({ keys: options.jwksKeys === undefined ? [key.jwk] : options.jwksKeys });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

interface TrustOverrides extends Partial<GithubOidcTrustConfig> {
  fetcher: typeof fetch;
}

function trust(overrides: TrustOverrides): GithubOidcTrustConfig {
  return resolveGithubOidcTrustConfig({}, overrides);
}

test.beforeEach(() => {
  resetGithubOidcCaches();
  resetGithubOidcReplayCache();
});

test("M11.3-OIDC issuer, audience and repository are the exact dedicated values", () => {
  assert.equal(GITHUB_OIDC_ISSUER, "https://token.actions.githubusercontent.com");
  assert.equal(WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE, "worldcons-ops-write");
  assert.equal(WORLDCONS_OPS_HEARTBEAT_OIDC_REPOSITORY, "kjw2/worldcons");
  const config = resolveGithubOidcTrustConfig({});
  assert.equal(config.issuer, GITHUB_OIDC_ISSUER);
  assert.equal(config.audience, "worldcons-ops-write");
  assert.equal(config.repository, "kjw2/worldcons");
  assert.deepEqual(config.allowedRefs, ["refs/heads/main"]);
  // The audience is not caller-overridable to GitHub's default STS audience.
  assert.notEqual(config.audience, "sts.amazonaws.com");
});

test("M11.3-OIDC a correctly signed token for the trusted workflow verifies", async () => {
  const key = await generateKeyPair();
  const { fetcher, calls } = oidcFetcher(key);
  const token = await signToken(key, {});
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.repository, REPOSITORY);
    assert.equal(result.claims.ref, "refs/heads/main");
    assert.equal(result.claims.workflowRef, WORKFLOW_REF);
    assert.ok(result.claims.jti.length > 0);
  }
  assert.ok(calls.includes(GITHUB_OIDC_DISCOVERY_URL));
  assert.ok(calls.includes(JWKS_URI));
});

test("M11.3-OIDC rejects a wrong issuer", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, { iss: "https://evil.example" });
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher }));
  assert.deepEqual(result, { ok: false, code: "invalid_issuer" });
});

test("M11.3-OIDC rejects a wrong audience", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, { aud: "sts.amazonaws.com" });
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher }));
  assert.deepEqual(result, { ok: false, code: "invalid_audience" });
});

test("M11.3-OIDC rejects a foreign repository even with valid signature", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, {
    repository: "attacker/worldcons",
    workflow_ref: "attacker/worldcons/.github/workflows/crawlee-worker.yml@refs/heads/main",
  });
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher }));
  assert.deepEqual(result, { ok: false, code: "invalid_repository" });
});

test("M11.3-OIDC rejects an untrusted workflow file", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, {
    workflow_ref: "kjw2/worldcons/.github/workflows/evil.yml@refs/heads/main",
    workflow: "Evil",
  });
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher }));
  assert.deepEqual(result, { ok: false, code: "invalid_workflow" });
});

test("M11.3-OIDC read operation only trusts the watchdog workflow", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const writeOnly = await signToken(key, {
    workflow_ref: "kjw2/worldcons/.github/workflows/crawlee-worker.yml@refs/heads/main",
  });
  assert.deepEqual(
    await verifyGithubOidcToken(writeOnly, "read", trust({ fetcher })),
    { ok: false, code: "invalid_workflow" },
  );

  resetGithubOidcReplayCache();
  const watchdog = await signToken(key, {
    workflow_ref: "kjw2/worldcons/.github/workflows/admin-watchdog.yml@refs/heads/main",
  });
  const readOk = await verifyGithubOidcToken(watchdog, "read", trust({ fetcher }));
  assert.equal(readOk.ok, true);
  assert.deepEqual(OPS_WRITE_TRUSTED_WORKFLOWS.read, [".github/workflows/admin-watchdog.yml"]);
});

test("M11.3-OIDC rejects a disallowed ref and a workflow_ref/ref mismatch", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const wrongRef = await signToken(key, { ref: "refs/heads/feature" });
  assert.deepEqual(
    await verifyGithubOidcToken(wrongRef, "write", trust({ fetcher })),
    { ok: false, code: "invalid_ref" },
  );

  resetGithubOidcReplayCache();
  // Both the ref claim and the workflow_ref suffix must agree exactly. A token
  // whose embedded ref disagrees with the ref claim is rejected.
  const mismatch = await signToken(key, {
    ref: "refs/heads/main",
    workflow_ref: "kjw2/worldcons/.github/workflows/crawlee-worker.yml@refs/heads/other",
  });
  assert.deepEqual(
    await verifyGithubOidcToken(mismatch, "write", trust({ fetcher })),
    { ok: false, code: "invalid_workflow" },
  );

  resetGithubOidcReplayCache();
  const branchless = await signToken(key, {
    workflow_ref: "kjw2/worldcons/.github/workflows/crawlee-worker.yml",
  });
  assert.deepEqual(
    await verifyGithubOidcToken(branchless, "write", trust({ fetcher })),
    { ok: false, code: "invalid_workflow" },
  );
});

test("M11.3-OIDC validates exp, nbf and iat with bounded skew", async () => {
  const key = await generateKeyPair();
  const now = Math.floor(Date.now() / 1_000);
  const { fetcher } = oidcFetcher(key);

  const expired = await signToken(key, { iat: now - 3_600, nbf: now - 3_600, exp: now - 1_200 });
  assert.deepEqual(
    await verifyGithubOidcToken(expired, "write", trust({ fetcher })),
    { ok: false, code: "token_expired" },
  );

  resetGithubOidcReplayCache();
  const notYet = await signToken(key, { iat: now + 1_200, nbf: now + 1_200, exp: now + 3_600 });
  assert.deepEqual(
    await verifyGithubOidcToken(notYet, "write", trust({ fetcher })),
    { ok: false, code: "token_not_yet_valid" },
  );

  resetGithubOidcReplayCache();
  const futureIat = await signToken(key, { iat: now + 1_200, nbf: now, exp: now + 3_600 });
  assert.deepEqual(
    await verifyGithubOidcToken(futureIat, "write", trust({ fetcher })),
    { ok: false, code: "token_issued_in_future" },
  );

  // A genuinely missing/malformed time claim fails closed.
  const malformed = await signToken(key, { exp: Number.NaN as unknown as number });
  assert.deepEqual(
    await verifyGithubOidcToken(malformed, "write", trust({ fetcher })),
    { ok: false, code: "invalid_claims" },
  );
});

test("M11.3-OIDC rejects an altered signature, unknown key and unsupported alg", async () => {
  const key = await generateKeyPair();
  const other = await generateKeyPair("other-key");
  const { fetcher } = oidcFetcher(key);

  const token = await signToken(key, {});
  const tampered = `${token.slice(0, -4)}AAAA`;
  assert.deepEqual(
    await verifyGithubOidcToken(tampered, "write", trust({ fetcher })),
    { ok: false, code: "invalid_signature" },
  );

  resetGithubOidcReplayCache();
  const unknownKid = await signToken(key, {}, { kid: "missing-key" });
  assert.deepEqual(
    await verifyGithubOidcToken(unknownKid, "write", trust({ fetcher })),
    { ok: false, code: "unknown_key" },
  );

  resetGithubOidcReplayCache();
  // Same kid as the advertised JWKS key, but signed by a different private key:
  // the signature must not verify even though the key is "found".
  const wrongSigner = await signToken(other, {}, { kid: key.kid });
  assert.deepEqual(
    await verifyGithubOidcToken(wrongSigner, "write", trust({ fetcher })),
    { ok: false, code: "invalid_signature" },
  );

  const algNone = await signToken(key, {}, { alg: "none" });
  assert.deepEqual(
    await verifyGithubOidcToken(algNone, "write", trust({ fetcher })),
    { ok: false, code: "unsupported_algorithm" },
  );

  assert.deepEqual(
    await verifyGithubOidcToken(null, "write", trust({ fetcher })),
    { ok: false, code: "missing_token" },
  );
  assert.deepEqual(
    await verifyGithubOidcToken("not-a-jwt", "write", trust({ fetcher })),
    { ok: false, code: "malformed_token" },
  );
});

test("M11.3-OIDC fails closed on discovery, jwks and network errors", async () => {
  const key = await generateKeyPair();
  const token = await signToken(key, {});

  const discoveryDown = oidcFetcher(key, { discoveryStatus: 500 });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: discoveryDown.fetcher })),
    { ok: false, code: "discovery_http_error" },
  );

  resetGithubOidcCaches();
  const jwksDown = oidcFetcher(key, { jwksStatus: 500 });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: jwksDown.fetcher })),
    { ok: false, code: "jwks_http_error" },
  );

  resetGithubOidcCaches();
  const wrongIssuer = oidcFetcher(key, { issuer: "https://evil.example" });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: wrongIssuer.fetcher })),
    { ok: false, code: "discovery_invalid" },
  );

  resetGithubOidcCaches();
  const offOriginJwks = oidcFetcher(key, { jwksUri: "https://evil.example/jwks" });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: offOriginJwks.fetcher })),
    { ok: false, code: "jwks_uri_invalid" },
  );

  resetGithubOidcCaches();
  const weakKey = await generateKeyPair();
  const weakJwk = { ...weakKey.jwk, n: base64Url(new Uint8Array(128)) };
  const weak = oidcFetcher(key, { jwksKeys: [weakJwk] });
  // A JWKS with only unacceptable keys is not a usable cache, so discovery is
  // treated as unavailable rather than silently continuing without a key.
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: weak.fetcher })),
    { ok: false, code: "jwks_no_usable_keys" },
  );

  resetGithubOidcCaches();
  const networkError = (async () => { throw new Error("network blocked"); }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: networkError })),
    { ok: false, code: "discovery_fetch_failed" },
  );
});

test("M11.3-OIDC categorises every discovery and jwks failure stage distinctly", async () => {
  const key = await generateKeyPair();
  const token = await signToken(key, {});

  // discovery: transport throw
  resetGithubOidcCaches();
  const discoveryThrow = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: discoveryThrow })),
    { ok: false, code: "discovery_fetch_failed" },
  );

  // discovery: non-2xx
  resetGithubOidcCaches();
  const discovery500 = oidcFetcher(key, { discoveryStatus: 503 });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: discovery500.fetcher })),
    { ok: false, code: "discovery_http_error" },
  );

  // discovery: body is not JSON
  resetGithubOidcCaches();
  const discoveryBadJson = (async (input: string | URL | Request) => {
    if (String(input) === GITHUB_OIDC_DISCOVERY_URL) return new Response("<html>not json</html>", { status: 200 });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: discoveryBadJson })),
    { ok: false, code: "discovery_invalid" },
  );

  // discovery: mismatched issuer
  resetGithubOidcCaches();
  const wrongIssuer = oidcFetcher(key, { issuer: "https://evil.example" });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: wrongIssuer.fetcher })),
    { ok: false, code: "discovery_invalid" },
  );

  // discovery: jwks_uri leaves the issuer origin
  resetGithubOidcCaches();
  const offOrigin = oidcFetcher(key, { jwksUri: "https://evil.example/jwks" });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: offOrigin.fetcher })),
    { ok: false, code: "jwks_uri_invalid" },
  );

  // discovery: jwks_uri is not a string
  resetGithubOidcCaches();
  const noJwksUri = oidcFetcher(key, { jwksUri: 42 });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: noJwksUri.fetcher })),
    { ok: false, code: "jwks_uri_invalid" },
  );

  // jwks: transport throw after a valid discovery document
  resetGithubOidcCaches();
  const jwksThrow = (async (input: string | URL | Request) => {
    if (String(input) === GITHUB_OIDC_DISCOVERY_URL) {
      return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI });
    }
    throw new Error("tls failure");
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: jwksThrow })),
    { ok: false, code: "jwks_fetch_failed" },
  );

  // jwks: non-2xx
  resetGithubOidcCaches();
  const jwks500 = oidcFetcher(key, { jwksStatus: 502 });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: jwks500.fetcher })),
    { ok: false, code: "jwks_http_error" },
  );

  // jwks: body is not a JSON key set
  resetGithubOidcCaches();
  const jwksBadJson = (async (input: string | URL | Request) => {
    if (String(input) === GITHUB_OIDC_DISCOVERY_URL) {
      return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI });
    }
    return new Response("not json", { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: jwksBadJson })),
    { ok: false, code: "jwks_invalid" },
  );

  // jwks: keys array missing
  resetGithubOidcCaches();
  const jwksNoKeys = (async (input: string | URL | Request) => {
    if (String(input) === GITHUB_OIDC_DISCOVERY_URL) {
      return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI });
    }
    return Response.json({ nope: true });
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: jwksNoKeys })),
    { ok: false, code: "jwks_invalid" },
  );

  // jwks: every advertised key is unusable
  resetGithubOidcCaches();
  const weakOnly = oidcFetcher(key, { jwksKeys: [{ kty: "oct", kid: "hmac", k: "AAAA" }] });
  assert.deepEqual(
    await verifyGithubOidcToken(token, "write", trust({ fetcher: weakOnly.fetcher })),
    { ok: false, code: "jwks_no_usable_keys" },
  );

  // A usable JWKS without the token's kid is a genuine unknown key, not a
  // discovery failure, and must remain distinguishable.
  resetGithubOidcCaches();
  const goodKeys = oidcFetcher(key);
  const unknownKidToken = await signToken(key, {}, { kid: "not-in-jwks" });
  assert.deepEqual(
    await verifyGithubOidcToken(unknownKidToken, "write", trust({ fetcher: goodKeys.fetcher })),
    { ok: false, code: "unknown_key" },
  );
});

test("M11.3-OIDC calls the fetcher detached so workerd does not throw Illegal invocation", async () => {
  const key = await generateKeyPair();

  // workerd rejects `obj.fetch(...)` with `TypeError: Illegal invocation`
  // because the global fetch is not an ordinary method. A regression here is
  // invisible to a normal test fetcher, so this guarded fetcher throws unless
  // it is invoked with `this === undefined`, exactly like the real runtime.
  const guardedFetch = function (this: unknown, input: string | URL | Request) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    const url = String(input);
    if (url === GITHUB_OIDC_DISCOVERY_URL) {
      return Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI }));
    }
    if (url === JWKS_URI) return Promise.resolve(Response.json({ keys: [key.jwk] }));
    return Promise.resolve(new Response(null, { status: 404 }));
  } as unknown as typeof fetch;

  const token = await signToken(key, {});
  const result = await verifyGithubOidcToken(token, "write", trust({ fetcher: guardedFetch }));
  assert.equal(result.ok, true, "a detached fetcher call must preserve discovery/JWKS verification");
});

test("M11.3-OIDC caches JWKS and refetches on an unknown kid within bounds", async () => {
  const key = await generateKeyPair();
  const { fetcher, calls } = oidcFetcher(key);
  const token = await signToken(key, {});
  const config = trust({ fetcher, jwksMinRefetchMs: 0 });

  const first = await verifyGithubOidcToken(token, "write", config);
  assert.equal(first.ok, true);
  const jwksCallsAfterFirst = calls.filter((url) => url === JWKS_URI).length;

  resetGithubOidcReplayCache();
  const second = await verifyGithubOidcToken(token, "write", config);
  assert.equal(second.ok, true);
  assert.equal(
    calls.filter((url) => url === JWKS_URI).length,
    jwksCallsAfterFirst,
    "a fresh cache must not refetch JWKS",
  );
});

test("M11.3-OIDC rejects a replayed jti but accepts a fresh one", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const config = trust({ fetcher, jwksMinRefetchMs: 0 });
  const token = await signToken(key, { jti: "fixed-jti" });

  const first = await verifyGithubOidcToken(token, "write", config);
  assert.equal(first.ok, true);
  const replay = await verifyGithubOidcToken(token, "write", config);
  assert.deepEqual(replay, { ok: false, code: "replayed_token" });

  const fresh = await signToken(key, { jti: "fresh-jti" });
  assert.equal((await verifyGithubOidcToken(fresh, "write", config)).ok, true);
});

test("M11.3-OIDC boundary accepts OIDC and does not require OPS_WRITE_TOKEN", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, {});
  const env = {} satisfies WorldconsOpsWriteWorkerEnv;

  const request = new Request("https://worldcons-ops-write.example.workers.dev/v1/ops/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workflow_key: "watchdog",
      status: "success",
      run_id: "github-1",
      detail: {},
      observed_at: "2026-09-28T12:00:00.000Z",
    }),
  });

  const unauthorized = await handleOpsHeartbeatBoundary(request.clone(), env, {
    writeToSupabase: async () => {},
    auth: { oidc: { fetcher } },
  });
  assert.equal(unauthorized.status, 200);
  assert.equal((await unauthorized.json() as { ok: boolean }).ok, true);
});

test("M11.3-OIDC boundary still rejects an OIDC token for another repo", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, { repository: "attacker/x", workflow_ref: "attacker/x/.github/workflows/crawlee-worker.yml@refs/heads/main" });
  const request = new Request("https://worldcons-ops-write.example.workers.dev/v1/ops/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workflow_key: "watchdog",
      status: "success",
      run_id: "github-1",
      detail: {},
      observed_at: "2026-09-28T12:00:00.000Z",
    }),
  });
  const response = await handleOpsHeartbeatBoundary(request, {}, {
    writeToSupabase: async () => { throw new Error("must not write"); },
    auth: { oidc: { fetcher } },
  });
  assert.equal(response.status, 401);
});

test("M11.3-OIDC authorizeGithubOidcRequest returns stable failure codes", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const request = new Request("https://worldcons-ops-write.example.workers.dev/health", {
    headers: { Authorization: "Bearer not-a-jwt" },
  });
  const result = await authorizeGithubOidcRequest(request, "write", {}, { fetcher });
  assert.deepEqual(result, { ok: false, code: "malformed_token" });
});

function heartbeatRequest(token: string | null) {
  return new Request("https://worldcons-ops-write.example.workers.dev/v1/ops/heartbeat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      workflow_key: "watchdog",
      status: "success",
      run_id: "github-1",
      detail: {},
      observed_at: "2026-09-28T12:00:00.000Z",
    }),
  });
}

function captureWarn() {
  const records: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    records.push(args.map((value) => String(value)).join(" "));
  };
  return { records, restore: () => { console.warn = original; } };
}

test("M11.3-OIDC auth-failure log records only operation and stable code", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, { ref: "refs/heads/feature" });
  const capture = captureWarn();
  try {
    const response = await handleOpsHeartbeatBoundary(
      heartbeatRequest(token),
      { OPS_WRITE_TOKEN: "operator-secret" } satisfies WorldconsOpsWriteWorkerEnv,
      { writeToSupabase: async () => { throw new Error("must not write"); }, auth: { oidc: { fetcher } } },
    );
    assert.equal(response.status, 401);
  } finally {
    capture.restore();
  }
  assert.equal(capture.records.length, 1);
  const logged = JSON.parse(capture.records[0]) as Record<string, unknown>;
  assert.deepEqual(logged, {
    event: "worldcons_ops_write_auth_failure",
    operation: "write",
    code: "invalid_ref",
    bearerConfigured: true,
  });
});

test("M11.3-OIDC auth-failure log contains no token or claim material", async () => {
  const key = await generateKeyPair();
  const { fetcher } = oidcFetcher(key);
  const token = await signToken(key, {
    ref: "refs/heads/attacker-branch",
    repository: "attacker/worldcons",
    jti: "raw-jti-claim-123",
    workflow_ref: "attacker/worldcons/.github/workflows/crawlee-worker.yml@refs/heads/attacker-branch",
  });
  const capture = captureWarn();
  try {
    await handleOpsHeartbeatBoundary(
      heartbeatRequest(token),
      { OPS_WRITE_TOKEN: "operator-secret" } satisfies WorldconsOpsWriteWorkerEnv,
      { writeToSupabase: async () => {}, auth: { oidc: { fetcher } } },
    );
  } finally {
    capture.restore();
  }
  assert.equal(capture.records.length, 1);
  const raw = capture.records[0];
  for (const forbidden of [token, "raw-jti-claim-123", "attacker-branch", "attacker/worldcons", "operator-secret"]) {
    assert.ok(!raw.includes(forbidden), `auth-failure log must not contain ${forbidden}`);
  }
  assert.ok(!raw.includes("Bearer"), "auth-failure log must not contain the Authorization scheme");
  assert.ok(!raw.includes("eyJ"), "auth-failure log must not contain a JWT segment");
});

test("M11.3-OIDC no auth-failure log when the bearer fallback succeeds", async () => {
  const capture = captureWarn();
  try {
    // "operator-secret" is not a JWT, so OIDC fails, but the matching bearer
    // succeeds: the OIDC failure must not be reported.
    const response = await handleOpsHeartbeatBoundary(
      heartbeatRequest("operator-secret"),
      { OPS_WRITE_TOKEN: "operator-secret" } satisfies WorldconsOpsWriteWorkerEnv,
      { writeToSupabase: async () => {} },
    );
    assert.equal(response.status, 200);
  } finally {
    capture.restore();
  }
  assert.equal(capture.records.length, 0, "a successful bearer must not emit an OIDC failure log");
});

test("M11.3-OIDC no committed source file sets an OIDC token or shared secret value", () => {
  const sources = [
    ".github/workflows/crawlee-worker.yml",
    ".github/workflows/summary-drain.yml",
    ".github/workflows/embedding-backfill.yml",
    ".github/workflows/admin-watchdog.yml",
    ".github/workflows/admin-command-worker-p1.yml",
  ];
  for (const file of sources) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    for (const line of source.split(/\r?\n/u)) {
      if (/^\s*#/u.test(line)) continue;
      assert.doesNotMatch(
        line,
        /WORLDCONS_OPS_WRITE_OIDC_TOKEN\s*[:=]\s*[^${\s]/u,
        `${file} must never inline an OIDC JWT: ${line.trim()}`,
      );
      assert.doesNotMatch(
        line,
        /WORLDCONS_OPS_WRITE_TOKEN\s*[:=]\s*[^${\s]/u,
        `${file} must never inline a shared token: ${line.trim()}`,
      );
    }
  }
});
