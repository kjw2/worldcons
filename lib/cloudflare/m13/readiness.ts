import {
  M13_AUTHORITY_PROFILE_ENV,
  buildM13AuthorityEnvProfile,
  verifyM13AuthorityProfileAssignment,
  type M13AuthorityEnvironment,
  type M13AuthorityProfileVerification,
} from "@/lib/cloudflare/m13/authority-profile";
import type { M13FinalDeltaReport } from "@/lib/cloudflare/m13/final-delta";

/**
 * M13 destructive-retirement readiness evaluator.
 *
 * This module is read-only and purely computational. It turns supplied,
 * content-free evidence into a deterministic machine-checkable gate list. It
 * never performs a production action, never fetches credentials and never
 * claims that a production operation happened.
 *
 * Two classes of gate are kept strictly separate:
 *
 * - `machine` gates are computed from evidence the orchestrator collects
 *   (authority assignment, final-delta clears, observation window, search
 *   parity, stranded-object resolution, export/rotation/DR records);
 * - `governance` gates (three distinct owner approvals, legal/retention review
 *   and explicit retirement approval) are NEVER auto-satisfied. They require an
 *   explicit human attestation input and remain blockers otherwise.
 *
 * `readyForDestructiveRetirement` is true only when EVERY machine gate passes
 * AND every governance gate has explicit attestation. A caller that supplies no
 * attestation therefore always receives `false`, so this tool can never
 * fabricate retirement readiness.
 */

export const M13_READINESS_SCHEMA_VERSION = 2 as const;

export type M13GateCategory = "machine" | "governance";

export interface M13ReadinessGate {
  key: string;
  category: M13GateCategory;
  label: string;
  passed: boolean;
  detail: string;
  /** True for a gate that can only be satisfied by explicit human attestation. */
  humanAttestationRequired: boolean;
}

export interface M13ObservationEvidence {
  start: string | null;
  end: string | null;
  hours: number | null;
  minimumHours: number;
  /** True when the observation evidence covers the full requested window. */
  verified: boolean;
  reference: string | null;
}

export interface M13SearchReadinessEvidence {
  ftsParityPass: boolean;
  vectorizeParityPass: boolean;
  stable: boolean;
  reference: string | null;
}

export interface M13StrandedVercelEvidence {
  /** Every stranded object either recovered to R2 or explicitly inventoried. */
  resolved: boolean;
  recovered: number | null;
  inventoriedUnresolved: number | null;
  reference: string | null;
}

export interface M13FinalExportEvidence {
  exists: boolean;
  reference: string | null;
}

export interface M13CredentialRotationEvidence {
  complete: boolean;
  reference: string | null;
}

export interface M13DrRehearsalEvidence {
  passed: boolean;
  at: string | null;
  reference: string | null;
  maxAgeHours: number;
}

export interface M13P5RetirementEvidence {
  implementationStatus: string | null;
  evidenceStatus: string | null;
  ready: boolean;
  reference: string | null;
  gates: Array<{ key: string; passed: boolean }> | null;
}

export interface M13HumanAttestation {
  /** Explicit actor/record reference for this attestation; must be non-empty. */
  reference: string | null;
  attestation: boolean;
}

export interface M13GovernanceEvidence {
  ownerApprovals: {
    requiredRoles: readonly string[];
    approvedRoles: readonly string[];
    distinctActorCount: number;
    attestation: boolean;
    reference: string | null;
  };
  legalRetentionReview: M13HumanAttestation;
  retirementApproval: M13HumanAttestation;
}

export interface M13ReadinessInput {
  /** The environment whose per-domain selectors are reported. */
  environment: M13AuthorityEnvironment;
  /** The final Supabase -> D1 delta report, or null when not yet measured. */
  finalDelta: M13FinalDeltaReport | null;
  observation: M13ObservationEvidence | null;
  search: M13SearchReadinessEvidence | null;
  strandedVercelObjects: M13StrandedVercelEvidence | null;
  finalSupabaseExport: M13FinalExportEvidence | null;
  credentialRotation: M13CredentialRotationEvidence | null;
  drRehearsal: M13DrRehearsalEvidence | null;
  p5Retirement: M13P5RetirementEvidence | null;
  governance: M13GovernanceEvidence;
  now?: Date;
}

export interface M13AuthoritySummary {
  profile: M13AuthorityProfileVerification["profile"];
  source: M13AuthorityProfileVerification["source"];
  error: M13AuthorityProfileVerification["error"];
  assignmentVerified: boolean;
  /** A complete, valid `d1` assignment. */
  d1SoleAuthority: boolean;
  assignments: M13AuthorityProfileVerification["assignments"];
  /** The exact per-domain values a permanent switch would set. */
  targetProfile: Record<string, string>;
  /** The exact per-domain rollback values. */
  rollbackProfile: Record<string, string>;
}

export interface M13ReadinessReport {
  schemaVersion: typeof M13_READINESS_SCHEMA_VERSION;
  generatedAt: string;
  /** This tool is read-only; it never authorizes the destructive operation. */
  destructiveRetirementAuthorized: false;
  authority: M13AuthoritySummary;
  finalDelta: M13FinalDeltaReport | null;
  observation: M13ObservationEvidence | null;
  search: M13SearchReadinessEvidence | null;
  strandedVercelObjects: M13StrandedVercelEvidence | null;
  finalSupabaseExport: M13FinalExportEvidence | null;
  credentialRotation: M13CredentialRotationEvidence | null;
  drRehearsal: M13DrRehearsalEvidence | null;
  p5Retirement: M13P5RetirementEvidence | null;
  gates: M13ReadinessGate[];
  /** Keys of every failed gate (machine and governance). */
  blockers: string[];
  machineGatesPass: boolean;
  governanceGatesPass: boolean;
  /** True only when every machine AND governance gate passes. */
  readyForDestructiveRetirement: boolean;
  /** Always true: retirement requires explicit human attestation even when all gate inputs pass. */
  humanApprovalRequired: true;
}

function attestationValid(input: M13HumanAttestation): boolean {
  return input.attestation === true && typeof input.reference === "string" && input.reference.trim().length > 0;
}

function drCurrent(evidence: M13DrRehearsalEvidence | null, now: Date): boolean {
  if (!evidence || evidence.passed !== true || !evidence.at) return false;
  const at = new Date(evidence.at);
  if (Number.isNaN(at.getTime())) return false;
  const ageHours = (now.getTime() - at.getTime()) / 3_600_000;
  return ageHours >= 0 && ageHours <= evidence.maxAgeHours;
}

function observationWindowPass(evidence: M13ObservationEvidence | null): boolean {
  if (!evidence || !evidence.verified) return false;
  if (!evidence.start || !evidence.end) return false;
  const start = new Date(evidence.start);
  const end = new Date(evidence.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return false;
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  return hours >= evidence.minimumHours;
}

export function buildM13AuthoritySummary(environment: M13AuthorityEnvironment): M13AuthoritySummary {
  const verification = verifyM13AuthorityProfileAssignment(environment);
  const d1Profile = buildM13AuthorityEnvProfile("d1");
  const supabaseProfile = buildM13AuthorityEnvProfile("supabase");
  const targetProfile: Record<string, string> = {};
  const rollbackProfile: Record<string, string> = {};
  for (const [key, value] of Object.entries(d1Profile)) {
    if (key !== M13_AUTHORITY_PROFILE_ENV) targetProfile[key] = value;
  }
  for (const [key, value] of Object.entries(supabaseProfile)) {
    if (key !== M13_AUTHORITY_PROFILE_ENV) rollbackProfile[key] = value;
  }
  return {
    profile: verification.profile,
    source: verification.source,
    error: verification.error,
    assignmentVerified: verification.holds,
    d1SoleAuthority: verification.profile === "d1" && verification.holds && verification.source !== "fail_closed",
    assignments: verification.assignments,
    targetProfile,
    rollbackProfile,
  };
}

/**
 * Evaluates the M13 gate list. Pure and deterministic for a fixed input + `now`.
 * `now` is injectable so DR-rehearsal freshness is testable.
 */
export function evaluateM13Readiness(input: M13ReadinessInput): M13ReadinessReport {
  const now = input.now ?? new Date();
  const authority = buildM13AuthoritySummary(input.environment);
  const gates: M13ReadinessGate[] = [];

  gates.push({
    key: "authority.profile_valid",
    category: "machine",
    label: "M13 authority profile is valid (not a fail-closed typo)",
    passed: authority.source !== "fail_closed",
    detail: authority.source === "fail_closed"
      ? `invalid ${M13_AUTHORITY_PROFILE_ENV}; refusing to treat it as the resting default`
      : `profile=${authority.profile} source=${authority.source}`,
    humanAttestationRequired: false,
  });

  gates.push({
    key: "authority.d1_sole",
    category: "machine",
    label: "D1 is the sole write authority across every proven domain",
    passed: authority.d1SoleAuthority,
    detail: authority.d1SoleAuthority
      ? "every authored domain selector resolves to d1"
      : `profile=${authority.profile}; ${authority.assignments.filter((a) => !a.matches).length} selector(s) diverge`,
    humanAttestationRequired: false,
  });

  const delta = input.finalDelta;
  gates.push({
    key: "delta.final_clear",
    category: "machine",
    label: "Final Supabase -> D1 delta across ops/ingest/core is zero",
    passed: Boolean(delta?.deltaClear),
    detail: delta
      ? `tables=${delta.tableCount} exact=${delta.exactCount} remoteOnly=${delta.remoteOnlyTotal} pendingInsert=${delta.pendingInsertTotal} pendingUpdate=${delta.pendingUpdateTotal} blockers=${delta.blockers.length}`
      : "final delta not yet measured",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "observation.window",
    category: "machine",
    label: "Approved continuous production observation window is satisfied",
    passed: observationWindowPass(input.observation),
    detail: input.observation
      ? `minimum=${input.observation.minimumHours}h verified=${input.observation.verified} window=${input.observation.start ?? "?"}..${input.observation.end ?? "?"}`
      : "no observation evidence",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "r2.corpus_verified",
    category: "machine",
    label: "R2 corpus verification is complete",
    passed: Boolean(input.search && input.search.ftsParityPass && input.search.vectorizeParityPass && input.search.stable),
    detail: input.search
      ? `fts=${input.search.ftsParityPass} vectorize=${input.search.vectorizeParityPass} stable=${input.search.stable}`
      : "no search/parity evidence",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "vercel.stranded_resolved",
    category: "machine",
    label: "Stranded Vercel objects recovered or explicitly inventoried",
    passed: Boolean(input.strandedVercelObjects?.resolved),
    detail: input.strandedVercelObjects
      ? `resolved=${input.strandedVercelObjects.resolved} recovered=${input.strandedVercelObjects.recovered ?? "?"} inventoriedUnresolved=${input.strandedVercelObjects.inventoriedUnresolved ?? "?"}`
      : "no stranded-object inventory",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "export.final_supabase",
    category: "machine",
    label: "Final Supabase export exists",
    passed: Boolean(input.finalSupabaseExport?.exists),
    detail: input.finalSupabaseExport?.exists
      ? `reference=${input.finalSupabaseExport.reference ?? "unset"}`
      : "no final export record",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "credentials.rotated",
    category: "machine",
    label: "Credential rotation is complete",
    passed: Boolean(input.credentialRotation?.complete),
    detail: input.credentialRotation?.complete
      ? `reference=${input.credentialRotation.reference ?? "unset"}`
      : "credential rotation not complete",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "dr.rehearsal_current",
    category: "machine",
    label: "Disaster-recovery rehearsal passes and is current",
    passed: drCurrent(input.drRehearsal, now),
    detail: input.drRehearsal
      ? `passed=${input.drRehearsal.passed} at=${input.drRehearsal.at ?? "?"} maxAgeHours=${input.drRehearsal.maxAgeHours}`
      : "no DR rehearsal record",
    humanAttestationRequired: false,
  });

  gates.push({
    key: "p5.retirement_ready",
    category: "machine",
    label: "P5 retirement evaluator passes (when available)",
    passed: Boolean(input.p5Retirement?.ready),
    detail: input.p5Retirement
      ? `implementationStatus=${input.p5Retirement.implementationStatus ?? "?"} evidenceStatus=${input.p5Retirement.evidenceStatus ?? "?"} ready=${input.p5Retirement.ready}`
      : "no P5 retirement evaluator evidence supplied",
    humanAttestationRequired: false,
  });

  const ownerApprovals = input.governance.ownerApprovals;
  const ownersComplete =
    attestationValid({ attestation: ownerApprovals.attestation, reference: ownerApprovals.reference })
    && ownerApprovals.distinctActorCount >= ownerApprovals.requiredRoles.length
    && ownerApprovals.requiredRoles.every((role) => ownerApprovals.approvedRoles.includes(role));
  gates.push({
    key: "approvals.owners",
    category: "governance",
    label: "Three distinct required owner approvals recorded",
    passed: ownersComplete,
    detail: `required=${ownerApprovals.requiredRoles.join(",")} approved=${ownerApprovals.approvedRoles.join(",")} distinctActors=${ownerApprovals.distinctActorCount} attested=${ownerApprovals.attestation === true}`,
    humanAttestationRequired: true,
  });

  gates.push({
    key: "legal.retention_review",
    category: "governance",
    label: "Legal/retention review complete",
    passed: attestationValid(input.governance.legalRetentionReview),
    detail: attestationValid(input.governance.legalRetentionReview)
      ? `reference=${input.governance.legalRetentionReview.reference}`
      : "no explicit legal/retention attestation",
    humanAttestationRequired: true,
  });

  gates.push({
    key: "retirement.approval",
    category: "governance",
    label: "Explicit retirement approval recorded",
    passed: attestationValid(input.governance.retirementApproval),
    detail: attestationValid(input.governance.retirementApproval)
      ? `reference=${input.governance.retirementApproval.reference}`
      : "no explicit retirement approval attestation",
    humanAttestationRequired: true,
  });

  const machineGatesPass = gates.filter((gate) => gate.category === "machine").every((gate) => gate.passed);
  const governanceGatesPass = gates.filter((gate) => gate.category === "governance").every((gate) => gate.passed);
  const blockers = gates.filter((gate) => !gate.passed).map((gate) => gate.key);

  return {
    schemaVersion: M13_READINESS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    destructiveRetirementAuthorized: false,
    authority,
    finalDelta: input.finalDelta,
    observation: input.observation,
    search: input.search,
    strandedVercelObjects: input.strandedVercelObjects,
    finalSupabaseExport: input.finalSupabaseExport,
    credentialRotation: input.credentialRotation,
    drRehearsal: input.drRehearsal,
    p5Retirement: input.p5Retirement,
    gates,
    blockers,
    machineGatesPass,
    governanceGatesPass,
    readyForDestructiveRetirement: machineGatesPass && governanceGatesPass,
    humanApprovalRequired: true,
  };
}

/** Builds a default, fully-blocked governance input (no attestation). */
export function emptyM13GovernanceEvidence(requiredRoles: readonly string[] = ["operations", "data", "security"]): M13GovernanceEvidence {
  return {
    ownerApprovals: { requiredRoles, approvedRoles: [], distinctActorCount: 0, attestation: false, reference: null },
    legalRetentionReview: { attestation: false, reference: null },
    retirementApproval: { attestation: false, reference: null },
  };
}
