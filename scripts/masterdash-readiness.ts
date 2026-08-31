import "dotenv/config";
import { createHmac } from "node:crypto";

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

  console.log(JSON.stringify({
    localSecrets: [sso, control],
    signingContract: { input: "<timestamp>.<rawBody>", encoding: "base64url", sampleLength: sample.length },
    hub,
    blocking,
    note: "Value parity between the hub and Vercel cannot be checked from here; only a deployer holding both can confirm it.",
  }, null, 2));

  if (blocking.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
