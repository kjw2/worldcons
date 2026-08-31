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
import { POST as loginAdmin } from "../app/api/admin/login/route";
import { GET as getMasterdashHealth } from "../app/api/masterdash/health/route";
import { isMasterdashSsoOnly, resolveExistingAdminSessionIdentityForMasterdash } from "../lib/utils/auth";
import {
  collectionHealthMetrics,
  FAILURE_RECENCY_WINDOW_HOURS,
  SUMMARY_BACKLOG_STALE_HOURS,
  summaryBacklogIsStale,
} from "../lib/masterdash/health";

const originalSsoSecret = process.env.MASTERDASH_SSO_SECRET;
const originalControlSecret = process.env.MASTERDASH_CONTROL_SECRET;
const originalAdminUsername = process.env.ADMIN_USERNAME;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
const originalMasterdashAdminIdentities = process.env.MASTERDASH_ADMIN_IDENTITIES;
const ssoSecret = "worldcons-masterdash-sso-secret-for-tests-0001";
const controlSecret = "worldcons-masterdash-control-secret-tests-0001";
const adminUsername = "admin@worldcons.example";

before(() => {
  process.env.MASTERDASH_SSO_SECRET = ssoSecret;
  process.env.MASTERDASH_CONTROL_SECRET = controlSecret;
  process.env.ADMIN_USERNAME = adminUsername;
  process.env.ADMIN_PASSWORD = "active-local-admin-password";
  process.env.MASTERDASH_ADMIN_IDENTITIES = " admin , , ADMIN2 ";
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
  if (originalMasterdashAdminIdentities === undefined) delete process.env.MASTERDASH_ADMIN_IDENTITIES;
  else process.env.MASTERDASH_ADMIN_IDENTITIES = originalMasterdashAdminIdentities;
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

test("accepts normalized allowlisted owner/admin identities and rejects unregistered identities", () => {
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: " ADMIN2 ",
      email: "admin2@masterdash.example",
      role: "admin",
    }),
    adminUsername,
  );
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: "admin3",
      email: "admin3@masterdash.example",
      role: "owner",
    }),
    null,
  );
  assert.equal(
    resolveExistingAdminSessionIdentityForMasterdash({
      subject: "admin2",
      email: "admin2@masterdash.example",
      role: "operator",
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

test("reports the stored successful collection metrics without recomputing missing values", () => {
  const metrics = collectionHealthMetrics({
    latest: {
      id: "run-success",
      source_key: "fr-conseil-constitutionnel",
      status: "completed",
      started_at: "2026-08-08T00:00:00.000Z",
      finished_at: "2026-08-08T00:02:00.000Z",
      fetched_count: 12,
      failed_count: 0,
      metadata: { recordsAdded: 4 },
    },
    successful: {
      source_key: "fr-conseil-constitutionnel",
      finished_at: "2026-08-08T00:02:00.000Z",
    },
    pendingItems: 2,
    failedJobCount: 0,
    now: Date.parse("2026-08-08T00:03:00.000Z"),
  });
  assert.equal(metrics.lastRunStatus, "success");
  assert.equal(metrics.recordsCollected, 12);
  assert.equal(metrics.recordsAdded, 4);
  assert.equal(metrics.durationMs, 120000);
  assert.equal(metrics.failureReason, null);
  assert.equal(metrics.runId, "run-success");
  assert.equal(metrics.bySource[0]?.sourceKey, "fr-conseil-constitutionnel");
});

test("reports per-source degraded collection and verified counts instead of raw fetch counts", () => {
  const metrics = collectionHealthMetrics({
    latest: {
      id: "run-bverfg",
      source_key: "de-bverfg",
      status: "completed",
      started_at: "2026-08-15T21:04:00.000Z",
      finished_at: "2026-08-15T21:15:00.000Z",
      fetched_count: 21,
      failed_count: 0,
      metadata: {
        outcome: "degraded",
        recordsAdded: 0,
        verifiedSourceTextCount: 0,
        uncollectedCandidateCount: 21,
        lastVerifiedPublishedAt: "2026-07-28T00:00:00.000Z",
      },
    },
    successful: {
      source_key: "es-tribunal-constitucional",
      finished_at: "2026-08-15T21:07:00.000Z",
      metadata: { lastVerifiedPublishedAt: "2026-08-14T00:00:00.000Z", checkpoint: "es-tribunal-constitucional:2026-08-14T00:00:00.000Z" },
    },
    recentRuns: [
      {
        id: "run-bverfg",
        source_key: "de-bverfg",
        status: "completed",
        started_at: "2026-08-15T21:04:00.000Z",
        finished_at: "2026-08-15T21:15:00.000Z",
        fetched_count: 21,
        metadata: { outcome: "degraded", verifiedSourceTextCount: 0, uncollectedCandidateCount: 21 },
      },
      {
        id: "run-es",
        source_key: "es-tribunal-constitucional",
        status: "completed",
        started_at: "2026-08-15T21:04:00.000Z",
        finished_at: "2026-08-15T21:07:00.000Z",
        fetched_count: 28,
        metadata: { outcome: "success", verifiedSourceTextCount: 19, recordsAdded: 0 },
      },
    ],
    pendingItems: 21,
    now: Date.parse("2026-08-15T21:16:00.000Z"),
  });
  assert.equal(metrics.lastRunStatus, "degraded");
  assert.equal(metrics.recordsCollected, 0);
  assert.equal(metrics.failureTarget, "de-bverfg");
  assert.equal(metrics.bySource.length, 2);
  assert.equal(metrics.bySource.find((source) => source.sourceKey === "de-bverfg")?.lastRunStatus, "degraded");
  assert.equal(metrics.bySource.find((source) => source.sourceKey === "es-tribunal-constitucional")?.verifiedSourceText, 19);
});

test("infers degraded status from legacy uncollected runs that have no outcome field", () => {
  const metrics = collectionHealthMetrics({
    latest: {
      id: "legacy-bverfg",
      source_key: "de-bverfg",
      status: "completed",
      started_at: "2026-08-15T21:04:00.000Z",
      finished_at: "2026-08-15T21:15:00.000Z",
      fetched_count: 21,
      failed_count: 0,
      metadata: { recordsAdded: 0, uncollectedCandidateCount: 21 },
    },
    recentRuns: [{
      id: "legacy-bverfg",
      source_key: "de-bverfg",
      status: "completed",
      fetched_count: 21,
      metadata: { recordsAdded: 0, uncollectedCandidateCount: 21 },
    }],
    // Pin the clock: the run timestamps are fixed, so without this the assertion would
    // start failing once the failure recency window elapsed in real time.
    now: Date.parse("2026-08-15T22:00:00.000Z"),
  });
  assert.equal(metrics.lastRunStatus, "degraded");
  assert.equal(metrics.bySource[0]?.lastRunStatus, "degraded");
  assert.equal(metrics.failureTarget, "de-bverfg");
});

test("enables SSO-only administrator access only on production deployments", () => {
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercelEnv = process.env.VERCEL_ENV;

  try {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.VERCEL_ENV = "production";
    assert.equal(isMasterdashSsoOnly(), true);

    mutableEnv.VERCEL_ENV = "preview";
    assert.equal(isMasterdashSsoOnly(), false);

    mutableEnv.NODE_ENV = "test";
    delete mutableEnv.VERCEL_ENV;
    assert.equal(isMasterdashSsoOnly(), false);
  } finally {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalVercelEnv === undefined) delete mutableEnv.VERCEL_ENV;
    else mutableEnv.VERCEL_ENV = originalVercelEnv;
  }
});

test("blocks the direct administrator login API in production", async () => {
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercelEnv = process.env.VERCEL_ENV;

  try {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.VERCEL_ENV = "production";
    const response = await loginAdmin(
      new Request("https://worldcons.example/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: adminUsername, password: "active-local-admin-password" }),
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalVercelEnv === undefined) delete mutableEnv.VERCEL_ENV;
    else mutableEnv.VERCEL_ENV = originalVercelEnv;
  }
});

test("reports the latest failed collection and its actual failure target", () => {
  const metrics = collectionHealthMetrics({
    latest: {
      id: "run-failed",
      source_key: "us-scotus",
      status: "failed",
      started_at: "2026-08-08T01:00:00.000Z",
      finished_at: "2026-08-08T01:00:10.000Z",
      fetched_count: 0,
      failed_count: 1,
      error_message: "SCOTUS source unavailable",
      metadata: { errors: ["secondary error"] },
    },
    pendingItems: 1,
    now: Date.parse("2026-08-08T01:01:00.000Z"),
  });
  assert.equal(metrics.lastRunStatus, "failed");
  assert.equal(metrics.failureReason, "SCOTUS source unavailable");
  assert.equal(metrics.failureTarget, "us-scotus");
  assert.equal(metrics.errorCount, 1);
  assert.equal(metrics.durationMs, 10000);
});

test("returns null for collection metrics that are absent from stored data", () => {
  const metrics = collectionHealthMetrics({ latest: null, successful: null });
  assert.equal(metrics.lastRunStatus, null);
  assert.equal(metrics.recordsCollected, null);
  assert.equal(metrics.recordsAdded, null);
  assert.equal(metrics.pendingItems, null);
  assert.equal(metrics.errorCount, null);
  assert.equal(metrics.failureReason, null);
  assert.equal(metrics.failureTarget, null);
  assert.equal(metrics.runId, null);
  assert.equal(metrics.durationMs, null);
  assert.equal(metrics.checkpoint, null);
  assert.deepEqual(metrics.bySource, []);
});

test("a failure is reported while recent and ages out of the badge", () => {
  const now = Date.parse("2026-08-31T00:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  function metricsForFailureAge(hours: number) {
    const startedAt = hoursAgo(hours);
    return collectionHealthMetrics({
      latest: {
        id: "run-1",
        source_key: "de-bverfg",
        status: "failed",
        started_at: startedAt,
        finished_at: startedAt,
        fetched_count: 0,
        failed_count: 3,
        error_message: "listing fetch timed out",
        metadata: { outcome: "failed" },
      },
      successful: null,
      now,
    });
  }

  // A failure inside the window is actionable, so it is named with when it happened.
  const recent = metricsForFailureAge(2);
  assert.equal(recent.failureTarget, "de-bverfg");
  assert.equal(recent.failureReason, "listing fetch timed out");
  assert.equal(recent.failureObservedAt, hoursAgo(2));

  // Once collection stops the newest run stays failed forever. Beyond the window the badge
  // clears so a consumer does not surface a failure nobody can act on, while lastRunStatus
  // still records what actually happened.
  const stale = metricsForFailureAge(FAILURE_RECENCY_WINDOW_HOURS + 24);
  assert.equal(stale.failureTarget, null);
  assert.equal(stale.failureReason, null);
  assert.equal(stale.failureObservedAt, null);
  assert.equal(stale.lastRunStatus, "failed");
});

test("a run that never finished is aged from when it started", () => {
  const now = Date.parse("2026-08-31T00:00:00.000Z");
  const startedAt = new Date(now - 3 * 3_600_000).toISOString();
  const metrics = collectionHealthMetrics({
    latest: {
      id: "run-2",
      source_key: "fr-conseil-constitutionnel",
      status: "failed",
      started_at: startedAt,
      finished_at: null,
      fetched_count: 0,
      failed_count: 1,
      error_message: "aborted",
      metadata: { outcome: "failed" },
    },
    successful: null,
    now,
  });

  assert.equal(metrics.failureTarget, "fr-conseil-constitutionnel");
  assert.equal(metrics.failureObservedAt, startedAt);
});

test("a stalled summariser is visible even while collection stays healthy", () => {
  const now = Date.parse("2026-08-31T00:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  // Nothing waiting is not a stall.
  assert.equal(summaryBacklogIsStale(0, null, now), false);
  assert.equal(summaryBacklogIsStale(null, null, now), false);

  // A queue that the six-hourly drain will clear is normal throughput, not a fault.
  assert.equal(summaryBacklogIsStale(40, hoursAgo(2), now), false);

  // Waiting longer than the drain interval means the worker is not keeping up. This is the
  // case collection freshness cannot express: source text keeps arriving while nothing
  // reaches the public listing.
  assert.equal(summaryBacklogIsStale(3, hoursAgo(SUMMARY_BACKLOG_STALE_HOURS + 1), now), true);

  // A large backlog with no usable timestamp must not be silently ignored.
  assert.equal(summaryBacklogIsStale(161, null, now), true);
});

test("summary backlog is reported as its own axis, separate from pending items", () => {
  const metrics = collectionHealthMetrics({
    latest: {
      id: "run-ok",
      source_key: "fr-conseil-constitutionnel",
      status: "completed",
      started_at: "2026-08-30T00:00:00.000Z",
      finished_at: "2026-08-30T00:10:00.000Z",
      fetched_count: 5,
      failed_count: 0,
      metadata: { outcome: "success", recordsAdded: 5, verifiedSourceTextCount: 5 },
    },
    successful: null,
    pendingItems: 15,
    summaryBacklogCount: 161,
    oldestSummaryBacklogAt: "2026-08-01T00:00:00.000Z",
    now: Date.parse("2026-08-30T01:00:00.000Z"),
  });

  // pendingItems counts queue work; it never reflected the publication gap.
  assert.equal(metrics.pendingItems, 15);
  assert.equal(metrics.summaryBacklogCount, 161);
  assert.equal(metrics.oldestSummaryBacklogAt, "2026-08-01T00:00:00.000Z");
  // Collection itself succeeded, which is exactly why the backlog needs its own signal.
  assert.equal(metrics.lastRunStatus, "success");
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
