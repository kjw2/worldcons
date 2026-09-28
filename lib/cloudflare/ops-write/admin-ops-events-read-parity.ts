import {
  ADMIN_OPS_EVENTS_MAX_LIST_LIMIT,
  parseAdminOpsEventReadRow,
  type AdminOpsEventRecord,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { D1Database } from "@/lib/cloudflare/d1/types";

/**
 * M11.4R `admin_ops_events` list read-parity comparison (READ-ONLY).
 *
 * The nodes an operator compares during the M11.4R read cutover:
 *
 * - the canonical Supabase projection (`listAdminOpsEvents(limit=20)`, the
 *   resting authoritative read the admin ops page consumes);
 * - the boundary's D1 list projection (`GET /v1/ops/admin-events/list?limit=20`);
 * - an optional independent direct-D1 read through the D1 HTTP query API.
 *
 * Unlike the M11.3R heartbeat (one row per authored key), this is a list of
 * arbitrary event rows. The comparison is therefore **order-aware and
 * id-aligned**, exactly like the admin list projection:
 *
 * - the two arrays are compared positionally; a length difference is a
 *   difference on the index that is missing a counterpart;
 * - `id`, `event_type`, `severity`, `source_key`, `summary` and `detail` are
 *   compared exactly (`detail` as canonical JSON so object key order and the
 *   Supabase JSONB / D1 TEXT storage formatting cannot create a false
 *   difference);
 * - `created_at` is compared by INSTANT because Supabase (PostgREST
 *   `timestamptz`) and D1 (canonical UTC ISO-8601 TEXT) may print the same
 *   instant differently and every consumer parses it with `Date.parse`.
 *
 * Every difference carries the row `id` (or `null` when a position has no
 * counterpart) so the evidence is unambiguous.
 */

export interface AdminOpsEventParityDifference {
  index: number;
  id: string | null;
  field: "id" | "event_type" | "severity" | "source_key" | "summary" | "detail" | "created_at";
  left: string | null;
  right: string | null;
}

/**
 * Deterministic JSON for `detail`. Object keys are sorted recursively so a
 * differently-ordered Supabase JSONB object and the verbose D1 TEXT copy of the
 * same value compare equal. Arrays keep their order (semantic).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  // `undefined`, functions and symbols are not representable in stored JSON.
  return "null";
}

function instantEqual(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs === rightMs;
  return left === right;
}

function snapshot(record: AdminOpsEventRecord): Record<string, string> {
  return {
    id: record.id,
    event_type: record.event_type,
    severity: record.severity,
    source_key: record.source_key ?? "",
    summary: record.summary,
    detail: canonicalJson(record.detail),
    created_at: record.created_at,
  };
}

function pushDifference(
  differences: AdminOpsEventParityDifference[],
  index: number,
  id: string | null,
  field: AdminOpsEventParityDifference["field"],
  left: string | null,
  right: string | null,
): void {
  differences.push({ index, id, field, left, right });
}

const COMPARED_FIELDS = ["id", "event_type", "severity", "source_key", "summary", "detail"] as const;

export function compareAdminOpsEventsReadParity(
  left: readonly AdminOpsEventRecord[],
  right: readonly AdminOpsEventRecord[],
): AdminOpsEventParityDifference[] {
  const differences: AdminOpsEventParityDifference[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftRecord = left[index];
    const rightRecord = right[index];
    if (!leftRecord || !rightRecord) {
      const id = (leftRecord ?? rightRecord)?.id ?? null;
      pushDifference(differences, index, id, "id", leftRecord ? leftRecord.id : null, rightRecord ? rightRecord.id : null);
      continue;
    }
    const leftFields = snapshot(leftRecord);
    const rightFields = snapshot(rightRecord);
    for (const field of COMPARED_FIELDS) {
      if (leftFields[field] !== rightFields[field]) {
        pushDifference(differences, index, leftRecord.id, field, leftFields[field], rightFields[field]);
      }
    }
    if (!instantEqual(leftRecord.created_at, rightRecord.created_at)) {
      pushDifference(differences, index, leftRecord.id, "created_at", leftRecord.created_at, rightRecord.created_at);
    }
  }
  return differences;
}

export function adminOpsEventsReadParityHolds(
  left: readonly AdminOpsEventRecord[],
  right: readonly AdminOpsEventRecord[],
): boolean {
  return compareAdminOpsEventsReadParity(left, right).length === 0;
}

/**
 * The bound-parameter D1 HTTP query surface, structurally compatible with
 * `createD1HttpQueryExecutor`. Declared here so this comparator stays free of
 * the `remote/http-query` module at import time.
 */
export type AdminOpsEventsHttpQueryExecutor = (
  database: D1Database,
  statement: D1ImportStatement,
) => Promise<Record<string, unknown>[]>;

/** The exact projection the boundary serves and the Supabase reader selects. */
export const ADMIN_OPS_EVENTS_READ_COLUMNS = "id, event_type, severity, source_key, summary, detail, created_at";

/**
 * Independent direct-D1 read of the same descending `created_at` projection the
 * boundary serves, for the read-parity proof. One parameterized
 * `ORDER BY created_at DESC LIMIT ?` statement; `limit` is an internal,
 * validated safe integer (the shared D1 HTTP helper literalizes numbers), and no
 * caller value enters the SQL text.
 */
export async function readAdminOpsEventsViaHttp(
  execute: AdminOpsEventsHttpQueryExecutor,
  limit: number,
): Promise<AdminOpsEventRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_OPS_EVENTS_MAX_LIST_LIMIT) {
    throw new Error("admin_ops_events_read_parity.invalid_limit");
  }
  const rows = await execute("worldcons_ops", {
    sql: `SELECT ${ADMIN_OPS_EVENTS_READ_COLUMNS} FROM admin_ops_events ORDER BY created_at DESC LIMIT ?`,
    params: [limit],
  });
  if (!Array.isArray(rows)) throw new Error("admin_ops_events_read_parity.invalid_d1_rows");
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("admin_ops_events_read_parity.invalid_d1_rows");
    }
    const parsed = parseAdminOpsEventReadRow(row as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}
