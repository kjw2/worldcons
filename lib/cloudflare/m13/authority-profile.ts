/**
 * M13 permanent D1 authority profile.
 *
 * M11 proved each D1 write/read authority domain one at a time, each with its
 * own `supabase | d1-canary | d1` selector. The resting authority for every
 * domain is still `supabase`. M13 is the deliberate, single, bounded operation
 * that moves every *already proven* domain to permanent D1 authority and keeps
 * an explicit, named rollback.
 *
 * This module is the runtime-neutral contract for that switch. It is
 * deliberately free of `node:*` and `next/*` imports so it can be bundled into
 * the Cloudflare Worker and imported by the Node/GitHub operator tooling.
 *
 * Design rules:
 *
 * 1. One bounded operation. An operator selects the target profile once with
 *    `WORLDCONS_M13_AUTHORITY_PROFILE=d1`. The profile expands to the exact,
 *    authored per-domain selector values; it never invents a parallel selector.
 *    The per-domain M11 resolvers themselves consult the profile through the
 *    leaf `profile-override.ts`, so the switch is authoritative even when only
 *    the profile variable is supplied (a partial env wiring cannot leave one
 *    domain on Supabase).
 * 2. Explicit rollback. The same profile variable set to `supabase` (or
 *    removed) is the rollback value. Both the forward and rollback assignments
 *    are defined here.
 * 3. Fail closed. A permanent D1 selector is `d1`, never `d1-canary`. An
 *    unrecognized profile value is a hard error (`fail_closed`): the Worker
 *    entry, the ops-write boundary and the readiness command refuse rather than
 *    silently run under the resting `supabase` default. A selected `d1` domain
 *    whose D1 path fails still fails closed in the existing M11 seam code; this
 *    module only resolves the selector value.
 * 4. No silent drift. `verifyM13AuthorityProfileAssignment()` compares the
 *    resolved per-domain values against the profile and reports every
 *    divergence as a machine-checkable blocker.
 */

import {
  ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/d1/write-authority/admin-article-edit";
import {
  ADMIN_AUDIT_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/d1/write-authority/admin-audit";
import {
  SITE_EVENTS_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/d1/write-authority/site-events";
import {
  CORE_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/core-write/authority";
import {
  INGEST_RUN_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/ingest-write/ingestion-runs";
import {
  ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV,
  ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import {
  OPS_HEARTBEAT_READ_AUTHORITY_ENV,
  OPS_HEARTBEAT_WRITE_AUTHORITY_ENV,
} from "@/lib/cloudflare/ops-write/heartbeat";
import { RATE_LIMIT_AUTHORITY_ENV } from "@/lib/cloudflare/rate-limit/authority";
import {
  M13_AUTHORITY_PROFILE_ENV,
  resolveM13AuthorityProfile,
  type M13AuthorityEnvironment,
  type M13AuthorityProfile,
  type M13AuthorityProfileErrorCode,
} from "@/lib/cloudflare/m13/profile-override";

export {
  M13_AUTHORITY_PROFILE_ENV,
  M13_AUTHORITY_PROFILES,
  m13ProfileValueForEnvVar,
  resolveM13AuthorityProfile,
} from "@/lib/cloudflare/m13/profile-override";
export type {
  M13AuthorityEnvironment,
  M13AuthorityProfile,
  M13AuthorityProfileErrorCode,
  M13AuthorityProfileResolution,
} from "@/lib/cloudflare/m13/profile-override";

export type M13AuthorityDirection = "write" | "read";

/**
 * Every selector the permanent switch owns, in a stable order. Each entry names
 * the proven M11 domain, its direction and the existing env/Worker var it
 * already uses. M13 adds no new per-domain selector.
 */
export interface M13AuthorityAssignment {
  domain: string;
  direction: M13AuthorityDirection;
  envVar: string;
}

export const M13_AUTHORITY_ASSIGNMENTS: readonly M13AuthorityAssignment[] = [
  { domain: "ops.site_events", direction: "write", envVar: SITE_EVENTS_WRITE_AUTHORITY_ENV },
  { domain: "ops.admin_audit", direction: "write", envVar: ADMIN_AUDIT_WRITE_AUTHORITY_ENV },
  { domain: "ops.admin_article_edit", direction: "write", envVar: ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY_ENV },
  { domain: "ops.ops_heartbeat", direction: "write", envVar: OPS_HEARTBEAT_WRITE_AUTHORITY_ENV },
  { domain: "ops.admin_ops_events", direction: "write", envVar: ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV },
  { domain: "ingest.ingestion_runs", direction: "write", envVar: INGEST_RUN_WRITE_AUTHORITY_ENV },
  { domain: "core.publication", direction: "write", envVar: CORE_WRITE_AUTHORITY_ENV },
  { domain: "ops.ops_heartbeat", direction: "read", envVar: OPS_HEARTBEAT_READ_AUTHORITY_ENV },
  { domain: "ops.admin_ops_events", direction: "read", envVar: ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV },
  { domain: "ops.rate_limit", direction: "write", envVar: RATE_LIMIT_AUTHORITY_ENV },
] as const;

/** The exact value every assignment must carry under the permanent D1 profile. */
export const M13_D1_AUTHORITY_VALUE = "d1" as const;
/** The exact value every assignment must carry under the rollback profile. */
export const M13_SUPABASE_AUTHORITY_VALUE = "supabase" as const;

/** The full forward (target) assignment set for the permanent D1 authority. */
export function m13D1AuthorityAssignments(): Array<M13AuthorityAssignment & { value: "d1" }> {
  return M13_AUTHORITY_ASSIGNMENTS.map((assignment) => ({ ...assignment, value: M13_D1_AUTHORITY_VALUE }));
}

/** The full rollback assignment set (every domain back to Supabase). */
export function m13RollbackAuthorityAssignments(): Array<M13AuthorityAssignment & { value: "supabase" }> {
  return M13_AUTHORITY_ASSIGNMENTS.map((assignment) => ({ ...assignment, value: M13_SUPABASE_AUTHORITY_VALUE }));
}

export function m13AuthorityAssignmentsForProfile(
  profile: M13AuthorityProfile,
): Array<M13AuthorityAssignment & { value: M13AuthorityProfile }> {
  return M13_AUTHORITY_ASSIGNMENTS.map((assignment) => ({ ...assignment, value: profile }));
}

/**
 * Expands the profile into the exact per-domain environment variables the
 * Worker/GitHub contracts already read. This is the bounded operation.
 *
 * `supabase` yields the explicit rollback map; `d1` yields the permanent map.
 */
export function buildM13AuthorityEnvProfile(
  profile: M13AuthorityProfile,
): Record<string, M13AuthorityProfile> {
  const result: Record<string, M13AuthorityProfile> = { [M13_AUTHORITY_PROFILE_ENV]: profile };
  for (const assignment of m13AuthorityAssignmentsForProfile(profile)) {
    result[assignment.envVar] = assignment.value;
  }
  return result;
}

/**
 * Applies the profile over a base environment, returning a NEW environment when
 * the profile is explicitly `d1`. For the resting `supabase`/unset profile the
 * base environment is returned unchanged, so existing per-domain values (for
 * example an in-flight canary) are never disturbed.
 *
 * Throws on an invalid profile (fail closed).
 */
export function applyM13AuthorityProfileToEnvironment<T extends M13AuthorityEnvironment>(
  base: T,
  profileEnvironment: M13AuthorityEnvironment = base,
): T {
  const resolution = resolveM13AuthorityProfile(profileEnvironment);
  if (resolution.source === "fail_closed") {
    throw new Error(`m13_authority_profile.${resolution.error ?? "invalid_authority_profile"}`);
  }
  if (resolution.profile !== "d1") return base;
  const next: M13AuthorityEnvironment = { ...base };
  for (const assignment of m13AuthorityAssignmentsForProfile("d1")) {
    next[assignment.envVar] = assignment.value;
  }
  return next as T;
}

export interface M13AuthorityProfileDivergence {
  domain: string;
  direction: M13AuthorityDirection;
  envVar: string;
  expected: M13AuthorityProfile;
  actual: string | null;
}

export interface M13AuthorityProfileVerification {
  profile: M13AuthorityProfile;
  source: "default" | "env" | "fail_closed";
  error: M13AuthorityProfileErrorCode | null;
  assignments: Array<M13AuthorityAssignment & { value: M13AuthorityProfile; actual: string | null; matches: boolean }>;
  divergences: M13AuthorityProfileDivergence[];
  /** True only when the resolution is valid AND every selector matches the profile. */
  holds: boolean;
}

/**
 * Verifies that every authored per-domain selector matches the active profile.
 *
 * Under the `d1` profile a missing selector is a divergence (`actual:null`), so a
 * partial switch can never be mistaken for a complete one. Under the resting
 * `supabase` profile an absent selector is a match, because every M11 resolver
 * defaults to `supabase` when its var is unset; any explicit `d1`/`d1-canary`
 * value is still reported so an overlooked switch is visible.
 *
 * This checks the EXPLICITLY configured per-domain vars (the deployed wiring).
 * The per-domain resolvers additionally treat the profile as authoritative, so
 * an operator who sets only `WORLDCONS_M13_AUTHORITY_PROFILE=d1` and forgets the
 * per-domain vars is told `holds:false` and cannot ship a half-wired switch.
 */
export function verifyM13AuthorityProfileAssignment(
  environment: M13AuthorityEnvironment = {},
): M13AuthorityProfileVerification {
  const resolution = resolveM13AuthorityProfile(environment);
  const expectedValue = resolution.profile;
  const assignments = M13_AUTHORITY_ASSIGNMENTS.map((assignment) => {
    const actual = environment[assignment.envVar]?.trim().toLowerCase() ?? null;
    const effective = actual ?? "supabase";
    return { ...assignment, value: expectedValue, actual, matches: effective === expectedValue };
  });
  const divergences = assignments
    .filter((assignment) => !assignment.matches)
    .map(({ domain, direction, envVar, actual }) => ({ domain, direction, envVar, expected: expectedValue, actual }));
  const holds = resolution.source !== "fail_closed" && divergences.length === 0;
  return { profile: resolution.profile, source: resolution.source, error: resolution.error, assignments, divergences, holds };
}
