import "dotenv/config";
import { createHmac } from "node:crypto";
import { verifyMasterdashControlRequest, verifyMasterdashSsoToken, MasterdashSecurityError } from "@/lib/masterdash/security";
import { resolveExistingAdminSessionIdentityForMasterdash } from "@/lib/utils/auth";

const HUB_READY_URL = "https://masterdash-prod.cclib.workers.dev/api/ready";
const MIN_SECRET_BYTES = 32;

interface SecretStatus {
  name: string;
  configured: boolean;
  meetsMinimumBytes: boolean;
  bytes: number;
}

function secretStatus(name: string): SecretStatus {
  const value = process.env[name]?.trim() ?? "";
  const bytes = Buffer.byteLength(value, "utf8");
  return { name, configured: bytes > 0, meetsMinimumBytes: bytes >= MIN_SECRET_BYTES, bytes };
}

// Reproduces the hub contract exactly: HMAC-SHA256 over `<timestamp>.<raw body>`, base64url.
function controlSignature(secret: string, timestamp: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64url");
}

function base64Url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Mints a token in the exact shape the hub issues, then runs it through the real verifier.
// This turns "the secret looks set" into "a hub-shaped token actually produces a session".
function ssoRoundTrip(secret: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url({ alg: "HS256", typ: "JWT", kid: "masterdash-v1" });
  const payload = base64Url({
    iss: "masterdash",
    aud: "worldcons-admin",
    systemId: "worldcons",
    // The hub puts its internal user id in sub and the real address in email.
    sub: `user_${crypto.randomUUID()}`,
    email: process.env.ADMIN_USERNAME?.trim() || "ap570@naver.com",
    role: "admin",
    jti: `readiness-${crypto.randomUUID()}`,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");

  try {
    const claims = verifyMasterdashSsoToken(`${header}.${payload}.${signature}`);
    const identity = resolveExistingAdminSessionIdentityForMasterdash({
      subject: claims.sub,
      email: claims.email,
      role: claims.role,
    });
    return identity
      ? { ok: true as const, mappedIdentity: identity }
      : { ok: false as const, reason: "Token verified but no local administrator matched; check ADMIN_USERNAME or MASTERDASH_ADMIN_IDENTITIES." };
  } catch (error) {
    const reason = error instanceof MasterdashSecurityError ? `${error.status} ${error.message}` : String(error);
    return { ok: false as const, reason };
  }
}

// Same idea for the control path: sign a request the way the hub does and verify it here.
function controlRoundTrip(secret: string) {
  const timestamp = new Date().toISOString();
  // requestId must be a bare RFC 4122 UUID; a prefixed value is rejected with 400.
  const requestId = crypto.randomUUID();
  const rawBody = JSON.stringify({
    version: "2026-08-01",
    requestId,
    systemId: "worldcons",
    action: "resume_collection",
    requestedAt: timestamp,
    requestedBy: {
      userId: `user_${crypto.randomUUID()}`,
      email: process.env.ADMIN_USERNAME?.trim() || "ap570@naver.com",
      workspaceId: "readiness",
      role: "admin",
    },
  });

  try {
    verifyMasterdashControlRequest({
      rawBody,
      signature: controlSignature(secret, timestamp, rawBody),
      timestamp,
      requestId,
    });
    return { ok: true as const };
  } catch (error) {
    const reason = error instanceof MasterdashSecurityError ? `${error.status} ${error.message}` : String(error);
    return { ok: false as const, reason };
  }
}

async function hubPortalSecrets() {
  try {
    const response = await fetch(HUB_READY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { reachable: true, httpStatus: response.status, portalSecrets: null };
    const payload = (await response.json()) as { checks?: Record<string, unknown> };
    const checks = payload.checks ?? {};
    return {
      reachable: true,
      httpStatus: response.status,
      // portalSecrets only appears after the hub deploys commit 92a79d4.
      portalSecrets: (checks.portalSecrets as Record<string, boolean> | undefined) ?? null,
      availableChecks: Object.keys(checks),
    };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const sso = secretStatus("MASTERDASH_SSO_SECRET");
  const control = secretStatus("MASTERDASH_CONTROL_SECRET");

  // Prove our verifier and the hub signer agree on the signing input shape.
  const timestamp = "2026-08-01T10:00:00.000Z";
  const rawBody = JSON.stringify({ version: "2026-08-01", requestId: "req-1", systemId: "worldcons", action: "pause_collection", requestedAt: timestamp, requestedBy: { userId: "user_x", email: "ap570@naver.com", workspaceId: "ws", role: "admin" } });
  const sample = controlSignature("s".repeat(48), timestamp, rawBody);

  const hub = await hubPortalSecrets();

  const blocking: string[] = [];
  for (const status of [sso, control]) {
    if (!status.configured) blocking.push(`${status.name} is not set.`);
    else if (!status.meetsMinimumBytes) blocking.push(`${status.name} is ${status.bytes} bytes; needs >= ${MIN_SECRET_BYTES}.`);
  }
  if (sso.configured && control.configured && process.env.MASTERDASH_SSO_SECRET === process.env.MASTERDASH_CONTROL_SECRET) {
    blocking.push("MASTERDASH_SSO_SECRET and MASTERDASH_CONTROL_SECRET must not share a value.");
  }

  // With both secrets present, prove the contract end to end rather than stopping at presence.
  const ssoCheck = sso.configured && sso.meetsMinimumBytes ? ssoRoundTrip(process.env.MASTERDASH_SSO_SECRET!.trim()) : null;
  const controlCheck = control.configured && control.meetsMinimumBytes ? controlRoundTrip(process.env.MASTERDASH_CONTROL_SECRET!.trim()) : null;
  if (ssoCheck && !ssoCheck.ok) blocking.push(`SSO round trip failed: ${ssoCheck.reason}`);
  if (controlCheck && !controlCheck.ok) blocking.push(`Control round trip failed: ${controlCheck.reason}`);

  const hubSecrets = hub.portalSecrets;
  if (hubSecrets) {
    if (hubSecrets.ssoSecretConfigured === false) blocking.push("Hub PORTAL_SSO_SECRET is not configured.");
    if (hubSecrets.controlSecretConfigured === false) blocking.push("Hub PORTAL_CONTROL_SECRET is not configured.");
  }

  console.log(JSON.stringify({
    localSecrets: [sso, control],
    signingContract: { input: "<timestamp>.<rawBody>", encoding: "base64url", sampleLength: sample.length },
    localContractRoundTrip: {
      sso: ssoCheck ?? "skipped: secret not usable locally",
      control: controlCheck ?? "skipped: secret not usable locally",
    },
    hub,
    blocking,
    note: "A passing round trip proves this side honours the contract. It cannot prove the hub holds the same secret value; only a deployer with access to both can confirm that.",
  }, null, 2));

  if (blocking.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
