import assert from "node:assert/strict";
import test from "node:test";
import {
  M13_AUTHORITY_ASSIGNMENTS,
  M13_AUTHORITY_PROFILE_ENV,
  applyM13AuthorityProfileToEnvironment,
  buildM13AuthorityEnvProfile,
  m13D1AuthorityAssignments,
  m13RollbackAuthorityAssignments,
  resolveM13AuthorityProfile,
  verifyM13AuthorityProfileAssignment,
} from "@/lib/cloudflare/m13/authority-profile";
import { resolveSiteEventsWriteAuthorityConfig } from "@/lib/cloudflare/d1/write-authority/site-events";
import { resolveAdminAuditWriteAuthorityConfig } from "@/lib/cloudflare/d1/write-authority/admin-audit";
import { resolveAdminArticleEditWriteAuthorityConfig } from "@/lib/cloudflare/d1/write-authority/admin-article-edit";
import { resolveOpsHeartbeatReadAuthorityConfig, resolveOpsHeartbeatWriteAuthorityConfig } from "@/lib/cloudflare/ops-write/heartbeat";
import { resolveAdminOpsEventsReadAuthorityConfig, resolveAdminOpsEventsWriteAuthorityConfig } from "@/lib/cloudflare/ops-write/admin-ops-events";
import { resolveIngestRunWriteAuthorityConfig } from "@/lib/cloudflare/ingest-write/ingestion-runs";
import { resolveCoreWriteAuthorityConfig } from "@/lib/cloudflare/core-write/authority";

test("M13 authority profile defaults to the resting supabase profile", () => {
  const resolution = resolveM13AuthorityProfile({});
  assert.equal(resolution.profile, "supabase");
  assert.equal(resolution.source, "default");
  assert.equal(resolution.error, null);
  assert.equal(resolveM13AuthorityProfile({ [M13_AUTHORITY_PROFILE_ENV]: "   " }).source, "default");
});

test("M13 authority profile accepts the exact d1/supabase switch and fails closed on anything else", () => {
  assert.equal(resolveM13AuthorityProfile({ [M13_AUTHORITY_PROFILE_ENV]: "d1" }).profile, "d1");
  assert.equal(resolveM13AuthorityProfile({ [M13_AUTHORITY_PROFILE_ENV]: " D1 " }).profile, "d1");
  assert.equal(resolveM13AuthorityProfile({ [M13_AUTHORITY_PROFILE_ENV]: "Supabase" }).profile, "supabase");
  const invalid = resolveM13AuthorityProfile({ [M13_AUTHORITY_PROFILE_ENV]: "d1-canary" });
  assert.equal(invalid.source, "fail_closed");
  assert.equal(invalid.error, "invalid_authority_profile");
  assert.equal(invalid.profile, "supabase");
});

test("M13 permanent d1 assignments are d1 and rollback assignments are supabase, never d1-canary", () => {
  const forward = m13D1AuthorityAssignments();
  const rollback = m13RollbackAuthorityAssignments();
  assert.equal(forward.length, M13_AUTHORITY_ASSIGNMENTS.length);
  assert.ok(forward.every((assignment) => assignment.value === "d1"));
  assert.ok(rollback.every((assignment) => assignment.value === "supabase"));
  assert.ok(forward.every((assignment) => (assignment.value as string) !== "d1-canary"));
  const domains = new Set(M13_AUTHORITY_ASSIGNMENTS.map((assignment) => `${assignment.domain}:${assignment.direction}`));
  assert.ok(domains.has("core.publication:write"));
  assert.ok(domains.has("ingest.ingestion_runs:write"));
  assert.ok(domains.has("ops.admin_ops_events:read"));
  assert.equal(domains.size, M13_AUTHORITY_ASSIGNMENTS.length, "no duplicate domain/direction assignment");
});

test("M13 authority env profile expands to the exact authored selector variables", () => {
  const profile = buildM13AuthorityEnvProfile("d1");
  assert.equal(profile[M13_AUTHORITY_PROFILE_ENV], "d1");
  for (const assignment of M13_AUTHORITY_ASSIGNMENTS) {
    assert.equal(profile[assignment.envVar], "d1", assignment.envVar);
  }
});

test("applyM13AuthorityProfileToEnvironment leaves the resting env untouched and applies the d1 overlay", () => {
  const resting: Record<string, string | undefined> = { WORLDCONS_CORE_WRITE_AUTHORITY: "d1-canary", KEEP: "value" };
  const unchanged = applyM13AuthorityProfileToEnvironment(resting, {});
  assert.deepEqual(unchanged, resting);

  const applied = applyM13AuthorityProfileToEnvironment(resting, { [M13_AUTHORITY_PROFILE_ENV]: "d1" });
  assert.notEqual(applied, resting, "a new object is returned for the switch");
  assert.equal(applied.KEEP, "value");
  for (const assignment of M13_AUTHORITY_ASSIGNMENTS) {
    assert.equal(applied[assignment.envVar], "d1", assignment.envVar);
  }
});

test("applyM13AuthorityProfileToEnvironment fails closed on an invalid profile", () => {
  assert.throws(
    () => applyM13AuthorityProfileToEnvironment({}, { [M13_AUTHORITY_PROFILE_ENV]: "d1-canary" }),
    /m13_authority_profile\.invalid_authority_profile/u,
  );
});

test("verifyM13AuthorityProfileAssignment reports every divergence", () => {
  const complete = buildM13AuthorityEnvProfile("d1");
  const verified = verifyM13AuthorityProfileAssignment(complete);
  assert.equal(verified.holds, true);
  assert.equal(verified.divergences.length, 0);

  const partial: Record<string, string | undefined> = { ...complete };
  delete partial[M13_AUTHORITY_ASSIGNMENTS[0].envVar];
  partial[M13_AUTHORITY_ASSIGNMENTS[1].envVar] = "supabase";
  const partialVerification = verifyM13AuthorityProfileAssignment(partial);
  assert.equal(partialVerification.holds, false);
  assert.equal(partialVerification.divergences.length, 2);

  const invalid = verifyM13AuthorityProfileAssignment({ [M13_AUTHORITY_PROFILE_ENV]: "bogus" });
  assert.equal(invalid.holds, false);
  assert.equal(invalid.source, "fail_closed");
});

test("M13 profile is authoritative in every M11 resolver even with only the profile var set", () => {
  const d1Only = { [M13_AUTHORITY_PROFILE_ENV]: "d1" };
  assert.equal(resolveSiteEventsWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveAdminAuditWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveAdminArticleEditWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveOpsHeartbeatWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveOpsHeartbeatReadAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveAdminOpsEventsWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveAdminOpsEventsReadAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveIngestRunWriteAuthorityConfig(d1Only).authority, "d1");
  assert.equal(resolveCoreWriteAuthorityConfig(d1Only).authority, "d1");
});

test("M13 profile never overrides an explicit d1-canary when it rests at supabase", () => {
  const canary = { WORLDCONS_CORE_WRITE_AUTHORITY: "d1-canary" };
  assert.equal(resolveCoreWriteAuthorityConfig(canary).authority, "d1-canary");
  const d1Win = { ...canary, [M13_AUTHORITY_PROFILE_ENV]: "d1" };
  assert.equal(resolveCoreWriteAuthorityConfig(d1Win).authority, "d1");
  const rollback = { ...canary, [M13_AUTHORITY_PROFILE_ENV]: "supabase" };
  assert.equal(resolveCoreWriteAuthorityConfig(rollback).authority, "d1-canary", "resting profile keeps explicit per-domain values");
  const failClosed = { WORLDCONS_CORE_WRITE_AUTHORITY: "d1", [M13_AUTHORITY_PROFILE_ENV]: "bogus" };
  assert.throws(
    () => resolveCoreWriteAuthorityConfig(failClosed),
    /m13_authority_profile\.invalid_authority_profile/u,
    "an invalid profile must fail closed in every resolver, never fall back to supabase",
  );
});
