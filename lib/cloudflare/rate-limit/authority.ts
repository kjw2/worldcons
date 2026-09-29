import { m13ProfileValueForEnvVar } from "@/lib/cloudflare/m13/profile-override";

/**
 * M13 rate-limit authority selector.
 *
 * The M11 per-domain selectors prove one authority domain at a time. The
 * distributed rate limiter is the `ops.rate_limit` domain. M13 made the
 * Cloudflare-native distributed backend the permanent resting authority.
 *
 * The selector is owned by the M13 profile through the leaf `profile-override`
 * module, so `WORLDCONS_M13_AUTHORITY_PROFILE=d1` moves this domain too. Exact
 * accepted legacy values are `supabase | d1`; the resting default is `d1`.
 *
 * IMPORTANT: selecting `d1` here is decisive. A Durable Object binding being
 * present is never sufficient to switch behavior on its own.
 */
export const RATE_LIMIT_AUTHORITY_ENV = "WORLDCONS_RATE_LIMIT_AUTHORITY";

export type RateLimitAuthority = "supabase" | "d1";

export interface RateLimitAuthorityConfig {
  authority: RateLimitAuthority;
}

export interface RateLimitAuthorityEnvironment {
  [key: string]: string | undefined;
}

export interface RateLimitAuthorityGlobal {
  __worldconsRateLimitAuthorityV1?: RateLimitAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & RateLimitAuthorityGlobal {
  return globalThis as typeof globalThis & RateLimitAuthorityGlobal;
}

/**
 * Resolves the configured authority. D1 is permanent after M13; missing or
 * unrecognized values remain on the Cloudflare backend.
 */
export function resolveRateLimitAuthorityConfig(
  environment: RateLimitAuthorityEnvironment = {},
): RateLimitAuthorityConfig {
  if (m13ProfileValueForEnvVar(RATE_LIMIT_AUTHORITY_ENV, environment) === "d1") {
    return { authority: "d1" };
  }
  const raw = environment[RATE_LIMIT_AUTHORITY_ENV]?.trim().toLowerCase();
  return { authority: "d1" };
}

export function setRuntimeRateLimitAuthorityConfig(config: RateLimitAuthorityConfig | null) {
  const target = runtimeGlobal();
  if (config) target.__worldconsRateLimitAuthorityV1 = config;
  else delete target.__worldconsRateLimitAuthorityV1;
}

export function getRuntimeRateLimitAuthorityConfig(): RateLimitAuthorityConfig | null {
  return runtimeGlobal().__worldconsRateLimitAuthorityV1 ?? null;
}

/**
 * Resolves the effective authority for the current runtime. The Worker-entry
 * runtime slot (set from `env`) wins when present; otherwise the process
 * environment (Node/Vercel) is consulted.
 */
export function resolveEffectiveRateLimitAuthorityConfig(
  environment: RateLimitAuthorityEnvironment = {},
): RateLimitAuthorityConfig {
  return getRuntimeRateLimitAuthorityConfig() ?? resolveRateLimitAuthorityConfig(environment);
}

export function shouldUseCloudflareRateLimit(config: RateLimitAuthorityConfig): boolean {
  return config.authority === "d1";
}
