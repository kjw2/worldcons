/**
 * Shared, pure ownership-pairing precondition for staged country cutover
 * planners (Germany P2-M3, United States P2-M4).
 *
 * The staged source allowlist and the legacy M8 crawler exclusion must always
 * hold the **exact same ordered set** of native source keys. A cutover planner
 * that starts from a mis-paired (different content, different ordering, blank,
 * duplicate, or malformed) current ownership would emit planned strings that
 * are NOT byte-identical — an unsafe, ambiguous split. This helper lets both
 * planners fail closed on such input before any mutation is planned.
 *
 * It never reads the network or the database; callers supply the raw lists.
 */

export interface OwnershipPairingResult {
  paired: boolean;
  /** Named reason when not paired (stable, source-specific prefix added by callers). */
  reason?: "empty_entry" | "duplicate_entry" | "length_mismatch" | "order_or_content_mismatch";
}

function normalize(values: readonly string[]): string[] {
  return values.map((value) => (typeof value === "string" ? value.trim() : String(value ?? "").trim()));
}

/**
 * True only when both lists are structurally clean and exactly equal by
 * sequence (same length, same keys, same order). Blank/duplicate/malformed
 * entries fail closed; two identical (including both-empty) clean lists pass.
 */
export function evaluateOwnershipPairing(
  stagedAllowlist: readonly string[],
  m8Exclude: readonly string[],
): OwnershipPairingResult {
  const staged = normalize(stagedAllowlist ?? []);
  const exclude = normalize(m8Exclude ?? []);
  if (staged.some((value) => value.length === 0) || exclude.some((value) => value.length === 0)) {
    return { paired: false, reason: "empty_entry" };
  }
  if (new Set(staged).size !== staged.length || new Set(exclude).size !== exclude.length) {
    return { paired: false, reason: "duplicate_entry" };
  }
  if (staged.length !== exclude.length) return { paired: false, reason: "length_mismatch" };
  if (staged.some((value, index) => value !== exclude[index])) {
    return { paired: false, reason: "order_or_content_mismatch" };
  }
  return { paired: true };
}
