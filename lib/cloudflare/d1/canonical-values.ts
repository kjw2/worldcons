import { canonicalJson } from "@/lib/backfill/canonical-json";

/**
 * Canonical scalar conversion for the D1 foundation (plan section 6.1).
 *
 * Every converter is total and deterministic: the same Postgres value always
 * produces the same canonical scalar, which is what the M5 per-table hashes and
 * the D1 <-> Postgres read parity checks compare. Invalid input throws instead
 * of silently coercing, so a converter bug cannot hide behind a default.
 */
export const CANONICAL_FOUNDATION_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^-?\d+$/;

export function canonicalizeUuid(value: unknown): string {
  if (typeof value !== "string") throw new Error(`uuid must be a string, received ${typeof value}`);
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`invalid uuid: ${value}`);
  return normalized;
}

export function canonicalizeTimestamp(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : typeof value === "string"
          ? new Date(value)
          : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}
export function canonicalizeBoolean(value: unknown): 0 | 1 {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "t") return 1;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "f") return 0;
  throw new Error(`invalid boolean: ${String(value)}`);
}

export function canonicalizeInteger(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || !Number.isSafeInteger(number)) {
    throw new Error(`invalid integer: ${String(value)}`);
  }
  return number;
}

export function canonicalizeBigIntText(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`invalid bigint: ${String(value)}`);
    return Math.trunc(value).toString();
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!DECIMAL_PATTERN.test(normalized)) throw new Error(`invalid bigint text: ${value}`);
    return normalized;
  }
  throw new Error(`invalid bigint: ${String(value)}`);
}

export function canonicalizeReal(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`invalid real: ${String(value)}`);
  return number;
}
export function canonicalizeJsonText(value: unknown): string {
  return canonicalJson(value ?? null);
}

export function parseCanonicalJsonText(text: string): unknown {
  return JSON.parse(text);
}

export function canonicalizeArrayText(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("array column requires an array value");
  return canonicalJson(value);
}

export function canonicalizeEnum(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`value ${String(value)} is not one of [${allowed.join(", ")}]`);
  }
  return value;
}

export function canonicalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("text column requires a string, number, boolean or null value");
}