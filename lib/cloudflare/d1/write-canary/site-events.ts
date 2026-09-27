import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";

export const M10_SITE_EVENT_CANARY_PATH = "/__m10/d1-write-canary";
export const M10_SITE_EVENT_CANARY_SOURCE_KEY = "m10-d1-write-canary";
export const M10_SITE_EVENT_CANARY_TYPE = "security_event";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

export interface M10SiteEventCanaryRow {
  id: string;
  occurred_at: string;
  event_type: typeof M10_SITE_EVENT_CANARY_TYPE;
  path: typeof M10_SITE_EVENT_CANARY_PATH;
  source_key: typeof M10_SITE_EVENT_CANARY_SOURCE_KEY;
  result_count: 1;
  metadata: {
    authority: "d1";
    m10Canary: true;
    purpose: "site_events_write_canary";
  };
  is_bot: false;
}

export interface M10SiteEventCanonicalRow {
  id: string;
  occurredAt: string;
  eventType: string;
  path: string | null;
  sourceKey: string | null;
  resultCount: number | null;
  metadataJson: string;
  isBot: boolean;
}

export function createM10SiteEventCanaryRow(input: {
  id: string;
  occurredAt: string;
}): M10SiteEventCanaryRow {
  if (!UUID_PATTERN.test(input.id)) {
    throw new Error("m10_site_event_canary.invalid_id");
  }
  if (!UTC_SECONDS_PATTERN.test(input.occurredAt)) {
    throw new Error("m10_site_event_canary.invalid_occurred_at");
  }
  return {
    id: input.id.toLowerCase(),
    occurred_at: input.occurredAt,
    event_type: M10_SITE_EVENT_CANARY_TYPE,
    path: M10_SITE_EVENT_CANARY_PATH,
    source_key: M10_SITE_EVENT_CANARY_SOURCE_KEY,
    result_count: 1,
    metadata: {
      authority: "d1",
      m10Canary: true,
      purpose: "site_events_write_canary",
    },
    is_bot: false,
  };
}

export function buildM10SiteEventInsert(row: M10SiteEventCanaryRow): D1ImportStatement {
  return {
    sql: [
      "INSERT INTO site_events",
      "(id, occurred_at, event_type, path, source_key, result_count, metadata, is_bot)",
      "VALUES (?, ?, ?, ?, ?, 1, ?, 0)",
    ].join(" "),
    params: [
      row.id,
      row.occurred_at,
      row.event_type,
      row.path,
      row.source_key,
      canonicalJson(row.metadata),
    ],
  };
}

export function buildM10SiteEventSelect(id: string): D1ImportStatement {
  assertCanaryId(id);
  return {
    sql: [
      "SELECT id, occurred_at, event_type, path, source_key, result_count, metadata, is_bot",
      "FROM site_events WHERE id = ?",
    ].join(" "),
    params: [id.toLowerCase()],
  };
}

export function buildM10SiteEventDelete(id: string): D1ImportStatement {
  assertCanaryId(id);
  return {
    sql: "DELETE FROM site_events WHERE id = ?",
    params: [id.toLowerCase()],
  };
}

export function canonicalizeM10SiteEventRow(
  row: Record<string, unknown>,
): M10SiteEventCanonicalRow {
  const metadata = parseMetadata(row.metadata);
  return {
    id: requiredString(row.id, "id").toLowerCase(),
    occurredAt: requiredString(row.occurred_at, "occurred_at"),
    eventType: requiredString(row.event_type, "event_type"),
    path: optionalString(row.path),
    sourceKey: optionalString(row.source_key),
    resultCount: optionalInteger(row.result_count),
    metadataJson: canonicalJson(metadata),
    isBot: booleanValue(row.is_bot),
  };
}

export function m10SiteEventRowsMatch(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(canonicalizeM10SiteEventRow(left))
    === JSON.stringify(canonicalizeM10SiteEventRow(right));
}

function assertCanaryId(id: string) {
  if (!UUID_PATTERN.test(id)) throw new Error("m10_site_event_canary.invalid_id");
}

function requiredString(value: unknown, key: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m10_site_event_canary.invalid_${key}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("m10_site_event_canary.invalid_integer");
  }
  return number;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error("m10_site_event_canary.invalid_boolean");
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("m10_site_event_canary.invalid_metadata");
    }
    return parsed as Record<string, unknown>;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("m10_site_event_canary.invalid_metadata");
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, entry]),
    ),
  );
}
