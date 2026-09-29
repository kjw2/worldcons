import assert from "node:assert/strict";
import test from "node:test";
import {
  M13_AUTHORITY_PROFILE_ENV,
  buildM13AuthorityEnvProfile,
} from "@/lib/cloudflare/m13/authority-profile";
import {
  buildM13AuthoritySummary,
  emptyM13GovernanceEvidence,
  evaluateM13Readiness,
  type M13ReadinessInput,
} from "@/lib/cloudflare/m13/readiness";
import type { M13FinalDeltaReport } from "@/lib/cloudflare/m13/final-delta";

function clearDelta(): M13FinalDeltaReport {
  return {
    databases: ["worldcons_core", "worldcons_ingest", "worldcons_ops"],
    dryRun: true,
    deltaClear: true,
    tableCount: 3,
    exactCount: 3,
    remoteOnlyTotal: 0,
    pendingInsertTotal: 0,
    pendingUpdateTotal: 0,
    tables: [],
    blockers: [],
    upstreamOk: true,
    upstreamErrors: [],
  };
}

function fullMachineInput(now: Date): M13ReadinessInput {
  return {
    environment: buildM13AuthorityEnvProfile("d1"),
    finalDelta: clearDelta(),
    search: { ftsParityPass: true, vectorizeParityPass: true, stable: true, reference: "search-1" },
    strandedVercelObjects: { resolved: true, recovered: 10, inventoriedUnresolved: 0, reference: "vercel-1" },
    finalSupabaseExport: { exists: true, reference: "export-1" },
    credentialRotation: { complete: true, reference: "rotation-1" },
    drRehearsal: { passed: true, at: "2026-09-20T00:00:00.000Z", reference: "dr-1", maxAgeHours: 720 },
    p5Retirement: { implementationStatus: "implementation-ready", evidenceStatus: "passing", ready: true, reference: "p5-1", gates: [] },
    governance: emptyM13GovernanceEvidence(),
    now,
  };
}

test("M13 readiness stays BLOCKED without explicit human attestation even when all machine gates pass", () => {
  const report = evaluateM13Readiness(fullMachineInput(new Date("2026-09-21T00:00:00.000Z")));
  assert.equal(report.machineGatesPass, true);
  assert.equal(report.governanceGatesPass, false);
  assert.equal(report.readyForDestructiveRetirement, false);
  assert.equal(report.destructiveRetirementAuthorized, false);
  assert.ok(report.blockers.includes("approvals.owners"));
  assert.ok(report.blockers.includes("legal.retention_review"));
  assert.ok(report.blockers.includes("retirement.approval"));
});

test("M13 readiness is READY only with complete machine AND governance gates", () => {
  const input = fullMachineInput(new Date("2026-09-21T00:00:00.000Z"));
  input.governance = {
    ownerApprovals: { requiredRoles: ["operations", "data", "security"], approvedRoles: ["operations", "data", "security"], distinctActorCount: 3, attestation: true, reference: "owners-1" },
    legalRetentionReview: { attestation: true, reference: "legal-1" },
    retirementApproval: { attestation: true, reference: "approval-1" },
  };
  const report = evaluateM13Readiness(input);
  assert.equal(report.readyForDestructiveRetirement, true);
  assert.equal(report.blockers.length, 0);
  // Even "ready" never authorizes the destructive action from this read-only tool.
  assert.equal(report.destructiveRetirementAuthorized, false);
  assert.equal(report.humanApprovalRequired, true);
});

test("M13 readiness blocks a partial or stale governance attestation", () => {
  const input = fullMachineInput(new Date("2026-09-21T00:00:00.000Z"));
  input.governance = {
    ownerApprovals: { requiredRoles: ["operations", "data", "security"], approvedRoles: ["operations"], distinctActorCount: 1, attestation: true, reference: "owners-1" },
    legalRetentionReview: { attestation: true, reference: "legal-1" },
    retirementApproval: { attestation: true, reference: "" },
  };
  const report = evaluateM13Readiness(input);
  assert.equal(report.governanceGatesPass, false);
  assert.ok(report.blockers.includes("approvals.owners"));
  assert.ok(report.blockers.includes("retirement.approval"));
});

test("M13 readiness fails closed on an invalid authority profile", () => {
  const input = fullMachineInput(new Date("2026-09-21T00:00:00.000Z"));
  input.environment = { [M13_AUTHORITY_PROFILE_ENV]: "d1-canary" };
  const report = evaluateM13Readiness(input);
  assert.equal(report.authority.source, "fail_closed");
  assert.equal(report.authority.d1SoleAuthority, false);
  assert.ok(report.blockers.includes("authority.profile_valid"));
  assert.ok(report.blockers.includes("authority.d1_sole"));
});

test("M13 readiness blocks a stale DR rehearsal", () => {
  const input = fullMachineInput(new Date("2026-12-01T00:00:00.000Z"));
  const report = evaluateM13Readiness(input);
  assert.ok(report.blockers.includes("dr.rehearsal_current"), "an over-age or unparseable DR record blocks");
});

test("M13 authority summary exposes the exact forward and rollback values", () => {
  const summary = buildM13AuthoritySummary(buildM13AuthorityEnvProfile("d1"));
  assert.equal(summary.d1SoleAuthority, true);
  assert.ok(Object.values(summary.targetProfile).every((value) => value === "d1"));
  assert.ok(Object.values(summary.rollbackProfile).every((value) => value === "supabase"));
});
