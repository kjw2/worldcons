/**
 * M13 authority profile override (leaf module).
 *
 * This module deliberately imports nothing so every M11 per-domain authority
 * resolver can consult it without an import cycle. It owns the single bounded
 * selector `WORLDCONS_M13_AUTHORITY_PROFILE` and the exact list of per-domain
 * selectors the profile owns.
 *
 * Semantics:
 *
 * - Unset/blank/`supabase` → no override (`null`). Every resolver keeps its
 *   existing behavior, including an explicit per-domain `d1`/`d1-canary`.
 * - `d1` → every owned selector resolves to `d1`, regardless of a stale
 *   per-domain value, so the whole switch is authoritative from one variable and
 *   a partial env wiring can never leave one domain on Supabase.
 * - Any other value → `fail_closed`; the resolvers treat the unowned/invalid
 *   case exactly as their own resting default, while the Worker entry and the
 *   readiness command reject it explicitly.
 */

export const M13_AUTHORITY_PROFILE_ENV = "WORLDCONS_M13_AUTHORITY_PROFILE";

/** The exact M13-owned selector env var names (canonical literals). */
export const M13_AUTHORITY_ENV_VARS = {
  siteEventsWrite: "WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY",
  adminAuditWrite: "WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY",
  adminArticleEditWrite: "WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY",
  opsHeartbeatWrite: "WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY",
  adminOpsEventsWrite: "WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY",
  ingestRunWrite: "WORLDCONS_INGEST_RUN_WRITE_AUTHORITY",
  coreWrite: "WORLDCONS_CORE_WRITE_AUTHORITY",
  opsHeartbeatRead: "WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY",
  adminOpsEventsRead: "WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY",
} as const;

export const M13_AUTHORITY_PROFILES = ["supabase", "d1"] as const;
export type M13AuthorityProfile = (typeof M13_AUTHORITY_PROFILES)[number];

export type M13AuthorityEnvironment = Record<string, string | undefined>;

export type M13AuthorityProfileErrorCode = "invalid_authority_profile";

export interface M13AuthorityProfileResolution {
  profile: M13AuthorityProfile;
  source: "default" | "env" | "fail_closed";
  error: M13AuthorityProfileErrorCode | null;
}

/**
 * Resolves the active profile. `fail_closed` marks an unrecognized value; the
 * caller MUST refuse rather than treat it as the resting default.
 */
export function resolveM13AuthorityProfile(
  environment: M13AuthorityEnvironment = {},
): M13AuthorityProfileResolution {
  const raw = environment[M13_AUTHORITY_PROFILE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { profile: "supabase", source: "default", error: null };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "supabase" || normalized === "d1") {
    return { profile: normalized, source: "env", error: null };
  }
  return { profile: "supabase", source: "fail_closed", error: "invalid_authority_profile" };
}

export function m13OwnsEnvVar(envVar: string): boolean {
  return Object.values(M13_AUTHORITY_ENV_VARS).some((value) => value === envVar);
}

/**
 * Resolves the profile's authoritative value for one owned selector.
 *
 * Returns `"d1"` only when the profile is explicitly `d1` AND the selector is
 * owned. Returns `null` for the resting `supabase` profile and for an unowned
 * selector, so resolvers keep their exact prior behavior in those cases.
 *
 * FAIL CLOSED: an unrecognized profile value throws. Every resolver that owns a
 * selector calls this, so a typo in `WORLDCONS_M13_AUTHORITY_PROFILE` refuses the
 * request/operation instead of silently falling back to the resting `supabase`
 * writer.
 */
export function m13ProfileValueForEnvVar(
  envVar: string,
  environment: M13AuthorityEnvironment = {},
): M13AuthorityProfile | null {
  if (!m13OwnsEnvVar(envVar)) return null;
  const resolution = resolveM13AuthorityProfile(environment);
  if (resolution.source === "fail_closed") {
    throw new Error(`m13_authority_profile.${resolution.error ?? "invalid_authority_profile"}`);
  }
  return resolution.profile === "d1" ? "d1" : null;
}
