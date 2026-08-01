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
import { GET as getMasterdashHealth } from "../app/api/masterdash/health/route";
import { resolveExistingAdminSessionIdentityForMasterdash } from "../lib/utils/auth";

const originalSsoSecret = process.env.MASTERDASH_SSO_SECRET;
const originalControlSecret = process.env.MASTERDASH_CONTROL_SECRET;
const originalAdminUsername = process.env.ADMIN_USERNAME;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
const ssoSecret = "worldcons-masterdash-sso-secret-for-tests-0001";
const controlSecret = "worldcons-masterdash-control-secret-tests-0001";
const adminUsername = "admin@worldcons.example";

before(() => {
  process.env.MASTERDASH_SSO_SECRET = ssoSecret;
  process.env.MASTERDASH_CONTROL_SECRET = controlSecret;
  process.env.ADMIN_USERNAME = adminUsername;
  process.env.ADMIN_PASSWORD = "active-local-admin-password";
});

after(() => {
  if (originalSsoSecret === undefined) delete process.env.MASTERDASH_SSO_SECRET;
  else process.env.MASTERDASH_SSO_SECRET = originalSsoSecret;
  if (originalControlSecret === undefined) delete process.env.MASTERDASH_CONTROL_SECRET;
  else process.env.MASTERDASH_CONTROL_SECRET = originalControlSecret;
  if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = originalAdminUsername;
  if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = originalAdminPassword;
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
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
});

test("maps only owner or admin identities to the existing active local administrator", () => {
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: "masterdash-user-1",
      email: adminUsername.toUpperCase(),
      role: "admin",
    }),
    adminUsername,
  );
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: adminUsername,
      role: "owner",
    }),
    adminUsername,
  );
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: adminUsername,
      role: "operator",
    }),
    null,
  );
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: "different-user",
      email: "different@worldcons.example",
      role: "admin",
    }),
    null,
  );
});

test("does not map an SSO identity when the local administrator is inactive", () => {
  const password = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.equal(
      resolveExistingAdminSessionIdentityForMasterdash({
        subject: adminUsername,
        email: adminUsername,
        role: "admin",
      }),
      null,
    );
  } finally {
    if (password !== undefined) process.env.ADMIN_PASSWORD = password;
  }
});

test("fails closed without a cookie or redirect when SSO identity mapping is denied", async () => {
  const iat = Math.floor(Date.now() / 1000);
  const token = jwt({
    iss: "masterdash",
    aud: "worldcons-admin",
    sub: adminUsername,
    email: adminUsername,
    role: "operator",
    systemId: "worldcons",
    iat,
    exp: iat + 60,
    jti: "operator-cannot-elevate",
  });
  const response = await exchangeMasterdashSso(
    new Request(`https://worldcons.example/api/auth/masterdash?masterdash_token=${token}`),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
});

test("returns a compact 2xx degraded health response when the database is unavailable", async () => {
  const names = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const response = await getMasterdashHealth();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.systemId, "worldcons");
    assert.equal(body.status, "degraded");
    assert.equal(body.metrics.checkpoint, null);
    assert.equal(JSON.stringify(body).includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

test("rejects wrong issuer, wrong audience, expired tokens, and lifetime over 60 seconds", () => {
  const now = new Date("2026-08-01T10:00:00.000Z");
  const iat = Math.floor(now.getTime() / 1000);
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "configurable-issuer", aud: "worldcons-admin", sub: "u", role: "admin", systemId: "worldcons", iat, exp: iat + 60, jti: "j" }), now),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "masterdash", aud: "other", sub: "u", role: "admin", systemId: "worldcons", iat, exp: iat + 60, jti: "j" }), now),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "masterdash", aud: "worldcons-admin", sub: "u", role: "admin", systemId: "worldcons", iat, exp: iat + 61, jti: "j" }), now),
    MasterdashSecurityError,
  );
  assert.throws(
    () => verifyMasterdashSsoToken(jwt({ iss: "masterdash", aud: "worldcons-admin", sub: "u", role: "admin", systemId: "worldcons", iat: iat - 60, exp: iat, jti: "j" }), now),
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

test("allows only admin or owner roles to change collection pause state", () => {
  const timestamp = "2026-08-01T10:00:00.000Z";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const bodyForRole = (role: "owner" | "admin" | "operator") =>
    JSON.stringify({
      version: MASTERDASH_CONTROL_VERSION,
      requestId,
      systemId: "worldcons",
      action: "pause_collection",
      requestedAt: timestamp,
      requestedBy: { userId: "masterdash-user-1", workspaceId: "workspace-1", role },
    });
  const verifyForRole = (role: "owner" | "admin" | "operator") => {
    const rawBody = bodyForRole(role);
    const signature = createHmac("sha256", controlSecret).update(`${timestamp}.${rawBody}`).digest("base64url");
    return verifyMasterdashControlRequest({ rawBody, signature, timestamp, requestId, now: new Date(timestamp) });
  };

  assert.equal(verifyForRole("owner").body.action, "pause_collection");
  assert.equal(verifyForRole("admin").body.action, "pause_collection");
  assert.throws(() => verifyForRole("operator"), (error: unknown) => {
    assert.ok(error instanceof MasterdashSecurityError);
    assert.equal(error.status, 403);
    return true;
  });
});

test("rejects tampering, stale timestamps, and header/body request id mismatch", () => {
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
  const wrongSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => verifyMasterdashControlRequest({ rawBody, signature: wrongSignature, timestamp, requestId, now: new Date(timestamp) }),
    (error: unknown) => {
      assert.ok(error instanceof MasterdashSecurityError);
      assert.equal(error.status, 403);
      return true;
    },
  );
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
