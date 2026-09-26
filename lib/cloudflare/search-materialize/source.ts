import { canonicalJson } from "@/lib/backfill/canonical-json";
import { assertPostgresIdentifier } from "@/lib/cloudflare/d1/convert/select";
import {
  buildPostgresSelectSql,
  parseSupabaseLinkedRows,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import { boundedMessage, materializeError } from "./errors";
import {
  SEARCH_SOURCE_DEFAULT_MAX_ROWS,
  SEARCH_SOURCE_DEFAULT_PAGE_SIZE,
  SEARCH_SOURCE_RELATIONS,
  SEARCH_SOURCE_RELATION_NAMES,
  type BuildNarrowSearchSourceOptions,
  type NarrowSearchSourceRows,
  type NarrowSearchSourceSnapshot,
  type SearchSourceRelationName,
} from "./types";

/**
 * Narrow, authored Supabase loader for the M7.5 operator.
 *
 * It never issues `select *` and never touches a full-table generic projection:
 * each relation selects exactly the columns the M7.1/M7.4 projection consumes,
 * in deterministic primary-key order, bounded by a small page size and a safe
 * per-relation ceiling. `article_content_versions_p3` omits `raw_text`,
 * `search_vector` and `embedding`; only `article_embedding_artifacts` reads
 * `embedding`.
 *
 * A page failure fails closed with the relation and offset only. After every
 * relation is collected its full authored column set is read a second time and
 * the count + fingerprint are compared; a change to any projected field fails
 * closed with `source_mutation_detected`, so Supabase mutation during collection
 * cannot produce a silently inconsistent projection.
 */

type RawRow = Record<string, unknown>;

function isRecord(value: unknown): value is RawRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickColumns(row: RawRow, columns: readonly string[]): RawRow {
  const picked: RawRow = {};
  for (const column of columns) picked[column] = row[column] ?? null;
  return picked;
}

function compareKeys(left: unknown[], right: unknown[]): number {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic digest over a relation's compact identity tuples. */
function relationFingerprint(
  rows: readonly RawRow[],
  compactColumns: readonly string[],
  orderBy: readonly string[],
): string {
  const sorted = [...rows].sort((left, right) =>
    compareKeys(
      orderBy.map((column) => left[column] ?? null),
      orderBy.map((column) => right[column] ?? null),
    ),
  );
  return shadowDigest(canonicalJson(sorted.map((row) => compactColumns.map((column) => row[column] ?? null))));
}

async function readPage(
  runner: (sql: string) => Promise<string>,
  relation: string,
  columns: readonly string[],
  orderBy: readonly string[],
  limit: number,
  offset: number,
): Promise<RawRow[]> {
  const sql = buildPostgresSelectSql({
    relation: assertPostgresIdentifier(relation),
    columns: columns.map(assertPostgresIdentifier),
    orderBy: orderBy.map(assertPostgresIdentifier),
    limit,
    offset,
  });
  let stdout: string;
  try {
    stdout = await runner(sql);
  } catch (error) {
    throw materializeError("source_page_failed", `${relation} offset ${offset}: ${boundedMessage(error)}`);
  }
  let rows: RawRow[];
  try {
    rows = parseSupabaseLinkedRows(stdout);
  } catch (error) {
    throw materializeError("source_page_failed", `${relation} offset ${offset}: ${boundedMessage(error)}`);
  }
  return rows.map((row) => {
    if (!isRecord(row)) {
      throw materializeError("source_row_invalid", `${relation} offset ${offset}: non-object row`);
    }
    return row;
  });
}

async function collectRelation(
  runner: (sql: string) => Promise<string>,
  name: SearchSourceRelationName,
  columns: readonly string[],
  pageSize: number,
  maxRows: number,
): Promise<{ rows: RawRow[]; pages: number }> {
  const spec = SEARCH_SOURCE_RELATIONS[name];
  const rows: RawRow[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = await readPage(runner, spec.relation, columns, spec.orderBy, pageSize, offset);
    pages += 1;
    if (page.length === 0) break;
    for (const row of page) rows.push(pickColumns(row, columns));
    offset += page.length;
    if (rows.length > maxRows) {
      throw materializeError(
        "source_safe_max_exceeded",
        `${spec.relation} exceeded safe max ${maxRows} rows at offset ${offset}`,
      );
    }
    if (page.length < pageSize) break;
  }
  return { rows, pages };
}

async function assertRelationStable(
  runner: (sql: string) => Promise<string>,
  name: SearchSourceRelationName,
  first: { rows: RawRow[]; pages: number },
  pageSize: number,
  maxRows: number,
): Promise<{ fingerprint: string; pages: number }> {
  const spec = SEARCH_SOURCE_RELATIONS[name];
  const second = await collectRelation(runner, name, spec.compactColumns, pageSize, maxRows);
  const firstFingerprint = relationFingerprint(first.rows, spec.compactColumns, spec.orderBy);
  const secondFingerprint = relationFingerprint(second.rows, spec.compactColumns, spec.orderBy);
  if (first.rows.length !== second.rows.length || firstFingerprint !== secondFingerprint) {
    throw materializeError("source_mutation_detected", `${spec.relation} changed during collection`);
  }
  return { fingerprint: secondFingerprint, pages: first.pages + second.pages };
}

export async function buildNarrowSearchSource(
  options: BuildNarrowSearchSourceOptions,
): Promise<NarrowSearchSourceSnapshot> {
  const rows = {
    publications: [],
    versions: [],
    articles: [],
    tags: [],
    articleTags: [],
    artifacts: [],
  } as NarrowSearchSourceRows;
  const counts = {} as Record<SearchSourceRelationName, number>;
  const fingerprints = {} as Record<SearchSourceRelationName, string>;
  let pageCount = 0;

  for (const name of SEARCH_SOURCE_RELATION_NAMES) {
    const spec = SEARCH_SOURCE_RELATIONS[name];
    const pageSize = options.pageSize?.[name] ?? SEARCH_SOURCE_DEFAULT_PAGE_SIZE[name];
    const maxRows = options.maxRows?.[name] ?? SEARCH_SOURCE_DEFAULT_MAX_ROWS[name];
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error(`invalid page size for ${name}`);
    if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error(`invalid max rows for ${name}`);
    const first = await collectRelation(options.runner, name, spec.columns, pageSize, maxRows);
    const stable = await assertRelationStable(options.runner, name, first, pageSize, maxRows);
    pageCount += stable.pages;
    counts[name] = first.rows.length;
    fingerprints[name] = stable.fingerprint;
    rows[name] = first.rows as never;
  }

  const fingerprint = shadowDigest(
    canonicalJson(
      SEARCH_SOURCE_RELATION_NAMES.map((name) => [name, counts[name], fingerprints[name]]),
    ),
  );

  return { rows, counts, fingerprints, fingerprint, pageCount };
}
