/** Strict Cloudflare IAM-only one-off Spanish ordinary discovery. */
export const SPAIN_INCREMENTAL_SOURCE = "es-tribunal-constitucional" as const;
// The usual daily bootstrap uses the default 180-day range. A one-day
// overlapping window gives post-fix recovery an independent same-day D1
// idempotency key without broadening the source or bypassing the stage queue.
export const SPAIN_INCREMENTAL_RECOVERY_DAYS = 181;

export function parseSpainIncrementalRecoveryCommand(input: unknown):
  { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "spain_incremental.invalid_payload" };
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2
    || value.schemaVersion !== 1 || value.mode !== "bootstrap-once") {
    return { ok: false, reason: "spain_incremental.invalid_contract" };
  }
  return { ok: true };
}

export function pairedSpainStagedOwnership(allowlist: string | undefined, m8Exclude: string | undefined) {
  const list = (value: string | undefined) => (value ?? "").split(",").map(s => s.trim());
  return list(allowlist).includes(SPAIN_INCREMENTAL_SOURCE)
    && list(m8Exclude).includes(SPAIN_INCREMENTAL_SOURCE);
}
