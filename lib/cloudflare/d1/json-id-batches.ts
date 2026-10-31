/**
 * Bounded JSON1 id batching for read-only guard lookups.
 *
 * Cloudflare D1 caps the number of bound parameters per statement, which is why
 * the original guard readers issued one `IN (...)` query per 80 ids. Passing the
 * ids as a single JSON array and expanding it with `json_each(?)` keeps the
 * parameter count at most two while still letting SQLite use the target table's
 * primary-key index. The helpers below also cap the input count and the encoded
 * payload size so a guard read can never become an unbounded statement.
 */
export const JSON_ID_BATCH_SIZE = 500;
export const JSON_ID_MAX_INPUT = 10_000;
export const JSON_ID_MAX_PAYLOAD_BYTES = 64 * 1024;
export const LEGACY_ID_BATCH_SIZE = 80;

const encoder = new TextEncoder();

function assertBoundedIds(ids: readonly string[]) {
  if (ids.length > JSON_ID_MAX_INPUT) throw new Error("e2e.id_batch_overflow");
  for (const id of ids) {
    if (typeof id !== "string") throw new Error("e2e.id_batch_invalid");
  }
}

export function jsonIdBatches(ids: readonly string[]): string[][] {
  assertBoundedIds(ids);
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 2; // "[]"
  for (const id of ids) {
    const encoded = encoder.encode(JSON.stringify(id)).length;
    const nextBytes = current.length === 0 ? 2 + encoded : bytes + 1 + encoded;
    if (current.length > 0 && (current.length >= JSON_ID_BATCH_SIZE || nextBytes > JSON_ID_MAX_PAYLOAD_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    if (current.length === 0) {
      bytes = 2 + encoded;
      if (bytes > JSON_ID_MAX_PAYLOAD_BYTES) throw new Error("e2e.id_batch_payload_exceeded");
      current.push(id);
    } else {
      current.push(id);
      bytes += 1 + encoded;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function legacyIdBatches(ids: readonly string[]): string[][] {
  assertBoundedIds(ids);
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += LEGACY_ID_BATCH_SIZE) {
    batches.push(ids.slice(index, index + LEGACY_ID_BATCH_SIZE));
  }
  return batches;
}

/**
 * Reads rows for a bounded id set through `json_each(?)`. If the JSON1 query
 * fails for any reason (including a SQLite build without JSON1), every id is
 * re-read with the proven 80-id `IN (...)` composition instead of returning the
 * partial JSON result. A fallback failure propagates so the caller still fails
 * closed.
 */
export async function readBatchedByIds<T>(options: {
  ids: readonly string[];
  readJsonBatch: (payload: string, limit: number) => Promise<T[]>;
  readLegacyBatch: (ids: readonly string[]) => Promise<T[]>;
  /** Request-local override; undefined preserves the existing global policy. */
  jsonBatching?: boolean;
}): Promise<T[]> {
  const unique = [...new Set(options.ids)];
  if (unique.length === 0) return [];
  // This helper is shared by public read paths beyond the sitemap. Keep the
  // new batching algorithm disabled until separately accepted in production.
  if (!(options.jsonBatching ?? (process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED === "true"))) {
    const rows: T[] = [];
    for (const batch of legacyIdBatches(unique)) rows.push(...await options.readLegacyBatch(batch));
    return rows;
  }
  const batches = jsonIdBatches(unique);
  try {
    const rows: T[] = [];
    for (const batch of batches) {
      rows.push(...await options.readJsonBatch(JSON.stringify(batch), batch.length));
    }
    return rows;
  } catch {
    const rows: T[] = [];
    for (const batch of legacyIdBatches(unique)) {
      rows.push(...await options.readLegacyBatch(batch));
    }
    return rows;
  }
}
