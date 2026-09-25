import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "./digest";

/**
 * Deterministic shadow comparison (M6.1).
 *
 * Both sides are already mapped to the platform-neutral contract shape, so this
 * module compares their canonical forms:
 *
 * - an array contract is compared after sorting items by a stable authored key,
 *   so a reordered but otherwise identical result set is EQUAL;
 * - the raw order is recorded separately as `orderMatches` (informational only);
 * - each side is hashed with the pure-JS `shadowDigest` over its canonical form;
 * - the first differing field path is captured, bounded, for triage.
 *
 * No row content enters the event: only counts, hashes and the diff path.
 */
export interface D1ShadowContract {
  method: string;
  kind: "array" | "object";
  /** Stable key field used to sort array items for equality. */
  stableKey: string | null;
}

export interface D1ShadowComparison {
  matched: boolean;
  orderMatches: boolean;
  primaryCount: number;
  shadowCount: number;
  primaryHash: string;
  shadowHash: string;
  diffPath: string | null;
}

const MAX_DIFF_PATH_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSortKey(item: unknown, stableKey: string | null): string {
  if (!stableKey || !isRecord(item)) return "";
  return canonicalJson(item[stableKey] ?? null);
}

function sortedByStableKey(items: readonly unknown[], stableKey: string | null): unknown[] {
  return [...items].sort((left, right) => {
    const a = stableSortKey(left, stableKey);
    const b = stableSortKey(right, stableKey);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function canonicalItems(items: readonly unknown[]): string[] {
  return items.map((item) => canonicalJson(item));
}

function equalityForm(kind: "array" | "object", items: string[]): string {
  return kind === "array" ? items.join("\n") : items[0] ?? "null";
}

function hashForm(contract: D1ShadowContract, count: number, equality: string): string {
  return shadowDigest(`d1-shadow/v1\n${contract.method}\n${contract.kind}\n${count}\n${equality}`);
}

function boundPath(path: string): string {
  if (path.length <= MAX_DIFF_PATH_LENGTH) return path;
  return `${path.slice(0, MAX_DIFF_PATH_LENGTH - 3)}...`;
}

/** The first differing field path between two canonicalizable values. */
function firstDiffPath(left: unknown, right: unknown, path: string): string | null {
  if (canonicalJson(left) === canonicalJson(right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    const common = Math.min(left.length, right.length);
    for (let index = 0; index < common; index += 1) {
      const diff = firstDiffPath(left[index], right[index], `${path}[${index}]`);
      if (diff) return diff;
    }
    return `${path}[${common}]`;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    for (const key of keys) {
      const diff = firstDiffPath(left[key], right[key], path ? `${path}.${key}` : key);
      if (diff) return diff;
    }
  }
  return path || "$";
}

function arrayDiffPath(
  contract: D1ShadowContract,
  primary: readonly unknown[],
  shadow: readonly unknown[],
): string | null {
  const sortedPrimary = sortedByStableKey(primary, contract.stableKey);
  const sortedShadow = sortedByStableKey(shadow, contract.stableKey);
  const common = Math.min(sortedPrimary.length, sortedShadow.length);
  for (let index = 0; index < common; index += 1) {
    const diff = firstDiffPath(sortedPrimary[index], sortedShadow[index], `${contract.method}[${index}]`);
    if (diff) return boundPath(diff);
  }
  if (sortedPrimary.length !== sortedShadow.length) return `${contract.method}[${common}]`;
  return null;
}

/** Compares an authoritative result against the shadow D1 result. */
export function compareD1Shadow(
  contract: D1ShadowContract,
  primary: unknown,
  shadow: unknown,
): D1ShadowComparison {
  if (contract.kind === "array") {
    const primaryItems = Array.isArray(primary) ? primary : [];
    const shadowItems = Array.isArray(shadow) ? shadow : [];
    const primaryForm = equalityForm("array", canonicalItems(sortedByStableKey(primaryItems, contract.stableKey)));
    const shadowForm = equalityForm("array", canonicalItems(sortedByStableKey(shadowItems, contract.stableKey)));
    return {
      matched: primaryForm === shadowForm,
      orderMatches: canonicalJson(primaryItems) === canonicalJson(shadowItems),
      primaryCount: primaryItems.length,
      shadowCount: shadowItems.length,
      primaryHash: hashForm(contract, primaryItems.length, primaryForm),
      shadowHash: hashForm(contract, shadowItems.length, shadowForm),
      diffPath: primaryForm === shadowForm ? null : arrayDiffPath(contract, primaryItems, shadowItems),
    };
  }

  const primaryForm = canonicalJson(primary);
  const shadowForm = canonicalJson(shadow);
  const matched = primaryForm === shadowForm;
  const objectDiff = matched ? null : firstDiffPath(primary, shadow, contract.method);
  return {
    matched,
    orderMatches: matched,
    primaryCount: primary === null || primary === undefined ? 0 : 1,
    shadowCount: shadow === null || shadow === undefined ? 0 : 1,
    primaryHash: hashForm(contract, 1, primaryForm),
    shadowHash: hashForm(contract, 1, shadowForm),
    diffPath: objectDiff ? boundPath(objectDiff) : null,
  };
}
