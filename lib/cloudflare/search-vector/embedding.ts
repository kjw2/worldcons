import { normalizeEmbeddingVector } from "@/lib/ai/embedding-vector";
import { vectorError, type SearchVectorErrorCode } from "./errors";
import { VECTORIZE_MAX_DIMENSIONS } from "./types";

/**
 * Runtime-neutral embedding parsing/validation for the M7.4 Vectorize
 * foundation.
 *
 * Stored Gemini vectors and query embeddings are compared with cosine, so a
 * deterministic L2 normalization (reusing `normalizeEmbeddingVector`) is safe
 * and idempotent for already-unit vectors. Wrong width, non-finite values and
 * zero/invalid norms always fail closed; they are never accepted silently.
 */

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/** True for a 64-character lowercase hex string (artifact content/input hash). */
export function isLowercaseHex64(value: unknown): value is string {
  return typeof value === "string" && LOWER_HEX_64.test(value);
}

/** True for a non-blank ISO-8601 timestamp string with a finite parse. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

/** Epoch milliseconds for an ISO timestamp, or null when missing/unparseable. */
export function epochMsFromIso(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceNumericArray(value: unknown, code: SearchVectorErrorCode, label: string): number[] {
  if (Array.isArray(value)) {
    const out: number[] = [];
    for (const entry of value) {
      if (typeof entry !== "number") {
        throw vectorError(code, `${label}: embedding array must contain only numbers`);
      }
      out.push(entry);
    }
    return out;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw vectorError(code, `${label}: embedding string is empty`);
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return coerceNumericArray(parsed, code, label);
      } catch {
        // Fall through to the pgvector text form below.
      }
    }
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "[" && last === "]") || (first === "{" && last === "}")) {
      const body = trimmed.slice(1, -1).trim();
      if (body.length === 0) throw vectorError(code, `${label}: embedding text is empty`);
      const parts = body.split(",");
      const out: number[] = [];
      for (const part of parts) {
        const token = part.trim();
        if (token.length === 0) throw vectorError(code, `${label}: embedding text has an empty component`);
        const numeric = Number(token);
        if (!Number.isFinite(numeric)) throw vectorError(code, `${label}: embedding text has a non-numeric component`);
        out.push(numeric);
      }
      return out;
    }
    throw vectorError(code, `${label}: embedding text is not a bracketed vector`);
  }

  throw vectorError(code, `${label}: embedding must be a number[] or vector text`);
}

/**
 * Parses and L2-normalizes an untrusted embedding value to exactly
 * {@link VECTORIZE_MAX_DIMENSIONS} finite numbers. Always fails closed with the
 * supplied code on width/non-finite/zero-norm problems.
 */
export function parseAndNormalizeEmbedding(
  value: unknown,
  code: SearchVectorErrorCode,
  label: string,
  dimensions: number = VECTORIZE_MAX_DIMENSIONS,
): number[] {
  const numeric = coerceNumericArray(value, code, label);
  try {
    return normalizeEmbeddingVector(numeric, dimensions);
  } catch (error) {
    throw vectorError(code, `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validates/normalizes a query embedding (`invalid_embedding` on failure). */
export function normalizeQueryEmbedding(value: unknown, dimensions: number = VECTORIZE_MAX_DIMENSIONS): number[] {
  return parseAndNormalizeEmbedding(value, "invalid_embedding", "query embedding", dimensions);
}

/** Dot product of two equal-length numeric vectors. */
export function dotProduct(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}
