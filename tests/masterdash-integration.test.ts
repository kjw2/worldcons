import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import {
  MASTERDASH_CONTROL_VERSION,
  MasterdashSecurityError,
  verifyMasterdashControlRequest,
  verifyMasterdashSsoToken,
} from "../lib/masterdash/security";
import { GET as exchangeMasterdashSso } from "../app/api/auth/masterdash/route";

const originalSsoSecret = process.env.MASTERDASH_SSO_SECRET;
const originalControlSecret = process.env.MASTERDASH_CONTROL_SECRET;
const originalIssuer = process.env.MASTERDASH_SSO_ISSUER;
const ssoSecret = "worldcons-masterdash-sso-secret-for-tests-0001";
const controlSecret = "worldcons-masterdash-control-secret-tests-0001";

before(() => {
  process.env.MASTERDASH_SSO_SECRET = ssoSecret;
  process.env.MASTERDASH_CONTROL_SECRET = controlSecret;
  process.env.MASTERDASH_SSO_ISSUER = "masterdash";
});

after(() => {
  if (originalSsoSecret === undefined) delete process.env.MASTERDASH_SSO_SECRET;
  else process.env.MASTERDASH_SSO_SECRET = originalSsoSecret;
  if (originalControlSecret === undefined) delete process.env.MASTERDASH_CONTROL_SECRET;
  else process.env.MASTERDASH_CONTROL_SECRET = originalControlSecret;
  if (originalIssuer === undefined) delete process.env.MASTERDASH_SSO_ISSUER;
  else process.env.MASTERDASH_SSO_ISSUER = originalIssuer;
});

function jwt(payload: Record<string, unknown>, secret = ssoSecret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

test("requires exactly one token for the SSO exchange", async () => {
  const response = await exchangeMasterdashSso(new Request("https://worldcons.example/api/auth/masterdash"));
  assert.equal(response.status, 401);
});

test("accepts the exact one-minute WorldCons SSO contract", () => {
  const now = new Date("2026-08-01T10:00:00.000Z");
  const iat = Math.floor(now.getTime() / 1000);
  const claims = verifyMasterdashSsoToken(
    jwt({
      iss: "masterdash",
      aud: "worldcons-admin",
      sub: "operator-1",
      role: "operator",
      systemId: "worldcons",
      iat,
      exp: iat + 60,
      jti: "single-use-id",
    }),
    now,
  );
  assert.equal(claims.systemId, "worldcons");
  assert.equal(claims.role, "operator");
});

test("rejects wrong audience and token lifetime over 60 seconds", () => {
  const now = new Date("2026-08-01T10:00:00.000Z");
  const iat = Math.floor(now.getTime() / 1000);
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "masterdash", aud: "other", sub: "u", role: "admin", systemId: "worldcons", iat, exp: iat + 60, jti: "j" }), now),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "masterdash", aud: "worldcons-admin", sub: "u", role: "admin", systemId: "worldcons", iat, exp: iat + 61, jti: "j" }), now),
    MasterdashSecurityError,
  );
});

test("authenticates the exact raw control body and matching headers", () => {
  const timestamp = "2026-08-01T10:00:00.000Z";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const rawBody = JSON.stringify({
    version: MASTERDASH_CONTROL_VERSION,
    requestId,
    systemId: "worldcons",
    action: "incremental_collect",
    requestedAt: timestamp,
    requestedBy: { userId: "operator-1", workspaceId: "workspace-1", role: "operator" },
  });
  const signature = createHmac("sha256", controlSecret).update(`${timestamp}.${rawBody}`).digest("base64url");
  const verified = verifyMasterdashControlRequest({ rawBody, signature, timestamp, requestId, now: new Date(timestamp) });
  assert.equal(verified.body.action, "incremental_collect");
  assert.match(verified.bodyHash, /^[A-Za-z0-9_-]+$/);
});

test("rejects tampering, stale timestamps, and header/body request id mismatch", () => {
  const timestamp = "2026-08-01T10:00:00.000Z";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const rawBody = JSON.stringify({
    version: MASTERDASH_CONTROL_VERSION,
    requestId,
    systemId: "worldcons",
    action: "pause_collection",
    requestedAt: timestamp,
    requestedBy: { userId: "operator-1", workspaceId: "workspace-1", role: "operator" },
  });
  const signature = createHmac("sha256", controlSecret).update(`${timestamp}.${rawBody}`).digest("base64url");
  assert.throws(
    () => verifyMasterdashControlRequest({ rawBody: `${rawBody} `, signature, timestamp, requestId, now: new Date(timestamp) }),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashControlRequest({ rawBody, signature, timestamp, requestId, now: new Date("2026-08-01T10:02:00.001Z") }),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashControlRequest({ rawBody, signature, timestamp, requestId: "223e4567-e89b-42d3-a456-426614174000", now: new Date(timestamp) }),
    MasterdashSecurityError,
  );
});
