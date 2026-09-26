import { createHash } from "node:crypto";

export interface P1InvocationEnvironment {
  M8_IDEMPOTENCY_KEY?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_RUN_ATTEMPT?: string;
  [key: string]: string | undefined;
}

function boundedIdentity(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * Deterministic invocation identity for a P1 compatibility-executor run.
 *
 * The M8 orchestration identity (the colon-form `m8:<kind>:<minute>` key) is
 * the stable source of truth whenever present, so a replayed Queue message or a
 * re-entered Workflow resolves to the same executor identity. Only when it is
 * absent does the function fall back to the GitHub run id/attempt (or the local
 * clock). This is the value that seeds the admin command `idempotencyKey`, so
 * two identical M8 identities can never produce two distinct command
 * identities.
 */
export function resolveP1InvocationIdentity(
  env: P1InvocationEnvironment = process.env,
  now: () => number = () => Date.now(),
): string {
  const m8 = boundedIdentity(env.M8_IDEMPOTENCY_KEY ?? "");
  if (m8) return digest(m8);
  const runId = boundedIdentity(env.GITHUB_RUN_ID ?? "") ?? "local";
  const runAttempt = boundedIdentity(env.GITHUB_RUN_ATTEMPT ?? "") ?? String(now());
  return digest(`${runId}:${runAttempt}`);
}

/**
 * Admin command identity pair derived from a resolved invocation identity.
 *
 * - `idempotencyKey` binds the exact executor invocation to the command type, so
 *   two runs with the same M8 identity collapse on the
 *   `(command_type, idempotency_key)` unique constraint.
 * - `dedupeKey` suppresses a second *active* run for the same cohort/command
 *   regardless of invocation identity, which is the fail-closed guard against
 *   duplicate publication work overlapping in time.
 */
export function p1CommandIdentities(identity: string, commandType: string, cohort: unknown) {
  const boundedIdentityValue = boundedIdentity(identity);
  if (!boundedIdentityValue) throw new Error("p1_invocation_identity_invalid");
  return {
    idempotencyKey: `p1:${boundedIdentityValue}:${commandType}`,
    dedupeKey: `p1:${String(cohort)}:${commandType}`,
  };
}
