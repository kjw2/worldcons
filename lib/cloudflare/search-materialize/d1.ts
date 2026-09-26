import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import {
  SEARCH_DOCUMENT_COLUMNS,
  SEARCH_FTS_COLUMNS,
  hashSearchProjectionDocuments,
  planSearchProjectionIncrementalSync,
  searchProjectionPlanSummary,
  verifySearchProjection,
  type SearchProjectionDocument,
  type SearchProjectionDocumentRow,
  type SearchProjectionFtsDocument,
  type SearchProjectionParam,
} from "@/lib/cloudflare/search-projection";
import { boundedMessage, materializeError } from "./errors";
import {
  SEARCH_MATERIALIZE_D1_BATCH_SIZE,
  SEARCH_MATERIALIZE_D1_DATABASE,
  SEARCH_MATERIALIZE_VERSION,
  type D1BatchStatement,
  type D1CurrentState,
  type D1MaterializationResult,
  type D1PlanReport,
  type D1PreApplySnapshot,
  type D1SnapshotRow,
} from "./types";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 120_000;
const READ_PAGE_SIZE = 500;

export interface D1RestClientOptions {
  accountId: string;
  apiToken: string;
  databaseId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface D1RestClient {
  query(statement: D1BatchStatement): Promise<Record<string, unknown>[]>;
  batch(statements: readonly D1BatchStatement[]): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function flattenResult(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === null || record.success !== true || !Array.isArray(record.result)) {
    throw materializeError("d1_apply_failed", "d1 rest response was not a successful result envelope");
  }
  const rows: Record<string, unknown>[] = [];
  for (const entry of record.result) {
    const envelope = asRecord(entry);
    if (envelope === null || envelope.success !== true) {
      throw materializeError("d1_apply_failed", "d1 rest result entry was not successful");
    }
    const results = envelope.results;
    if (results === undefined) continue;
    if (!Array.isArray(results)) {
      throw materializeError("d1_apply_failed", "d1 rest result entry had a non-array results field");
    }
    for (const row of results) {
      const object = asRecord(row);
      if (object === null) throw materializeError("d1_apply_failed", "d1 rest result contained a non-object row");
      rows.push(object);
    }
  }
  return rows;
}

/**
 * Minimal bound-parameter D1 REST client over the Cloudflare API.
 *
 * Reads use a single `{ sql, params }` query; writes use the transactional
 * per-batch `{ batch: [{ sql, params }, ...] }` body. Credentials are held
 * privately and never returned or logged. All response validation is fail
 * closed.
 */
export function createD1RestClient(options: D1RestClientOptions): D1RestClient {
  const { accountId, apiToken, databaseId } = options;
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("invalid cloudflare account id");
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) throw new Error("invalid cloudflare api token");
  if (!DATABASE_ID_PATTERN.test(databaseId)) throw new Error("invalid cloudflare d1 database id");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid d1 timeout");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  const post = async (body: unknown): Promise<Record<string, unknown>[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw controller.signal.aborted
          ? materializeError("d1_apply_failed", "d1 rest request timed out")
          : materializeError("d1_apply_failed", "d1 rest request failed");
      }
      if (!response.ok) throw materializeError("d1_apply_failed", `d1 rest http status ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw materializeError("d1_apply_failed", "d1 rest response was not json");
      }
      return flattenResult(payload);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    query: (statement) => post({ sql: statement.sql, params: [...statement.params] }),
    batch: async (statements) => {
      if (statements.length === 0) return;
      await post({ batch: statements.map((statement) => ({ sql: statement.sql, params: [...statement.params] })) });
    },
  };
}

async function readAll(
  query: D1RestClient["query"],
  sql: string,
  pageSize: number = READ_PAGE_SIZE,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const page = await query({ sql, params: [pageSize, offset] });
    if (page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return rows;
}

const DOC_SELECT = `SELECT article_id, checksum, projection_version FROM search_documents ORDER BY article_id LIMIT ? OFFSET ?`;
const FTS_SELECT = `SELECT article_id FROM search_fts ORDER BY article_id LIMIT ? OFFSET ?`;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw materializeError("d1_current_identity_mismatch", `search_documents.${field} was not a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** Reads the compact current `search_documents`/`search_fts` identity state. */
export async function readD1CurrentState(query: D1RestClient["query"]): Promise<D1CurrentState> {
  const documentRows = await readAll(query, DOC_SELECT);
  const ftsRows = await readAll(query, FTS_SELECT);
  const documents: SearchProjectionDocumentRow[] = documentRows.map((row) => ({
    article_id: requireString(row.article_id, "article_id"),
    checksum: optionalString(row.checksum),
    projection_version: optionalInteger(row.projection_version),
  }));
  const ftsArticleIds = ftsRows.map((row) => requireString(row.article_id, "article_id"));
  return { documents, documentCount: documents.length, ftsArticleIds, ftsCount: ftsArticleIds.length };
}

export function d1DocumentStateHash(documents: readonly SearchProjectionDocumentRow[]): string {
  return shadowDigest(
    canonicalJson(
      [...documents]
        .sort((left, right) => (left.article_id < right.article_id ? -1 : left.article_id > right.article_id ? 1 : 0))
        .map((row) => [row.article_id, row.checksum ?? null, row.projection_version ?? null]),
    ),
  );
}

export function d1FtsStateHash(articleIds: readonly string[]): string {
  return shadowDigest(canonicalJson([...articleIds].sort()));
}

function minimalCurrentDocument(row: SearchProjectionDocumentRow): SearchProjectionDocument {
  return {
    article_id: row.article_id,
    jurisdiction: null,
    source_key: null,
    language: null,
    content_type: null,
    publication_state: "",
    review_state: null,
    original_published_at: null,
    display_title: null,
    case_numbers: null,
    search_text: null,
    tags_text: null,
    projection_version: row.projection_version ?? -1,
    checksum: row.checksum ?? "",
    updated_at: "",
  };
}

export interface D1PlanResult {
  summary: ReturnType<typeof searchProjectionPlanSummary>;
  statements: D1BatchStatement[];
  report: D1PlanReport;
}

/**
 * Plans the incremental D1 synchronization from the current remote state to the
 * desired projection. Duplicate ids on either side, or a `search_documents` /
 * `search_fts` identity mismatch, fail closed. An empty current state yields
 * additions only; an exact match is a true no-op.
 */
export function planD1Materialization(
  desiredDocuments: readonly SearchProjectionDocument[],
  desiredFtsDocuments: readonly SearchProjectionFtsDocument[],
  current: D1CurrentState,
  batchSize: number = SEARCH_MATERIALIZE_D1_BATCH_SIZE,
): D1PlanResult {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("invalid d1 batch size");
  const documentIds = new Set<string>();
  for (const row of current.documents) {
    if (documentIds.has(row.article_id)) {
      throw materializeError("d1_current_duplicate", `search_documents has duplicate article_id ${row.article_id}`);
    }
    documentIds.add(row.article_id);
  }
  const ftsIds = new Set<string>();
  for (const id of current.ftsArticleIds) {
    if (ftsIds.has(id)) {
      throw materializeError("d1_current_duplicate", `search_fts has duplicate article_id ${id}`);
    }
    ftsIds.add(id);
  }
  for (const id of documentIds) {
    if (!ftsIds.has(id)) {
      throw materializeError("d1_current_identity_mismatch", `search_documents article ${id} has no search_fts row`);
    }
  }
  for (const id of ftsIds) {
    if (!documentIds.has(id)) {
      throw materializeError("d1_current_identity_mismatch", `search_fts article ${id} has no search_documents row`);
    }
  }

  const plan = planSearchProjectionIncrementalSync(
    current.documents.map(minimalCurrentDocument),
    desiredDocuments,
    desiredFtsDocuments,
  );
  const summary = searchProjectionPlanSummary(plan);
  const statements = plan.statements.map((statement) => ({
    sql: statement.sql,
    params: [...statement.params] as SearchProjectionParam[],
  }));
  const batchCount = Math.ceil(statements.length / batchSize);
  return {
    summary,
    statements,
    report: {
      operation: "incremental",
      destructive: summary.destructive,
      changes: summary.changes,
      statementCount: statements.length,
      batchCount,
      batchSize,
    },
  };
}

const SCOPED_STATEMENT = /^(insert into|delete from) (search_documents|search_fts)\b/i;

/** Rejects any statement whose SQL is not hard-scoped to the two search tables. */
export function assertD1StatementScope(statement: D1BatchStatement): void {
  const text = statement.sql.trim();
  const body = text.endsWith(";") ? text.slice(0, -1) : text;
  if (!SCOPED_STATEMENT.test(body) || body.includes(";")) {
    throw materializeError("d1_statement_out_of_scope", "statement is not scoped to search_documents/search_fts");
  }
}

export async function executeD1Statements(
  batch: D1RestClient["batch"],
  statements: readonly D1BatchStatement[],
  batchSize: number = SEARCH_MATERIALIZE_D1_BATCH_SIZE,
): Promise<number> {
  let batches = 0;
  for (let start = 0; start < statements.length; start += batchSize) {
    const group = statements.slice(start, start + batchSize);
    for (const statement of group) assertD1StatementScope(statement);
    await batch(group);
    batches += 1;
  }
  return batches;
}

const FULL_DOC_SELECT = `SELECT ${SEARCH_DOCUMENT_COLUMNS.join(", ")} FROM search_documents ORDER BY article_id LIMIT ? OFFSET ?`;
const FULL_FTS_SELECT = `SELECT ${SEARCH_FTS_COLUMNS.join(", ")} FROM search_fts ORDER BY article_id LIMIT ? OFFSET ?`;

function snapshotRow(row: Record<string, unknown>, columns: readonly string[]): D1SnapshotRow {
  const picked: D1SnapshotRow = {};
  for (const column of columns) {
    const value = row[column] ?? null;
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      throw materializeError("d1_snapshot_invalid", `column ${column} was not a scalar`);
    }
    picked[column] = value as SearchProjectionParam;
  }
  return picked;
}

/**
 * Reads the complete pre-apply snapshot of both tables, sufficient to restore
 * them. It is only persisted to the operator snapshot file, never printed.
 */
export async function readD1PreApplySnapshot(query: D1RestClient["query"]): Promise<D1PreApplySnapshot> {
  const documentRows = await readAll(query, FULL_DOC_SELECT);
  const ftsRows = await readAll(query, FULL_FTS_SELECT);
  return {
    version: SEARCH_MATERIALIZE_VERSION,
    stage: "search-materialize-d1-snapshot",
    database: SEARCH_MATERIALIZE_D1_DATABASE,
    documents: documentRows.map((row) => snapshotRow(row, SEARCH_DOCUMENT_COLUMNS)),
    fts: ftsRows.map((row) => snapshotRow(row, SEARCH_FTS_COLUMNS)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an untrusted snapshot before a rollback restores it. */
export function assertD1SnapshotShape(value: unknown): D1PreApplySnapshot {
  if (!isRecord(value)) throw materializeError("d1_snapshot_invalid", "snapshot is not an object");
  if (value.database !== SEARCH_MATERIALIZE_D1_DATABASE) {
    throw materializeError("d1_snapshot_invalid", "snapshot database is not worldcons_search");
  }
  if (!Array.isArray(value.documents) || !Array.isArray(value.fts)) {
    throw materializeError("d1_snapshot_invalid", "snapshot is missing documents/fts arrays");
  }
  const documents = value.documents.map((row, index) => {
    if (!isRecord(row)) throw materializeError("d1_snapshot_invalid", `snapshot document ${index} is not an object`);
    return snapshotRow(row, SEARCH_DOCUMENT_COLUMNS);
  });
  const fts = value.fts.map((row, index) => {
    if (!isRecord(row)) throw materializeError("d1_snapshot_invalid", `snapshot fts ${index} is not an object`);
    return snapshotRow(row, SEARCH_FTS_COLUMNS);
  });
  return {
    version: SEARCH_MATERIALIZE_VERSION,
    stage: "search-materialize-d1-snapshot",
    database: SEARCH_MATERIALIZE_D1_DATABASE,
    documents,
    fts,
  };
}

function insertStatement(table: string, columns: readonly string[], row: D1SnapshotRow): D1BatchStatement {
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")});`,
    params: columns.map((column) => row[column] ?? null),
  };
}

/** Deterministic explicit restore statements; never executed automatically. */
export function buildD1RestoreStatements(snapshot: D1PreApplySnapshot): D1BatchStatement[] {
  const statements: D1BatchStatement[] = [
    { sql: "DELETE FROM search_fts;", params: [] },
    { sql: "DELETE FROM search_documents;", params: [] },
  ];
  for (const row of snapshot.documents) {
    statements.push(insertStatement("search_documents", SEARCH_DOCUMENT_COLUMNS, row));
  }
  for (const row of snapshot.fts) {
    statements.push(insertStatement("search_fts", SEARCH_FTS_COLUMNS, row));
  }
  return statements;
}

export function desiredDocumentHash(documents: readonly SearchProjectionDocument[]): string {
  return hashSearchProjectionDocuments(documents);
}

export interface D1VerificationResult {
  ok: boolean;
  issues: { code: string; articleId: string | null }[];
}

/** Re-reads both tables and requires an exact checksum/version/identity match. */
export async function verifyD1Materialization(
  desiredDocuments: readonly SearchProjectionDocument[],
  desiredFtsDocuments: readonly SearchProjectionFtsDocument[],
  current: D1CurrentState,
): Promise<D1VerificationResult> {
  const report = verifySearchProjection({
    projected: desiredDocuments as SearchProjectionDocument[],
    documents: current.documents,
    ftsArticleIds: current.ftsArticleIds,
  });
  const countsOk =
    current.documentCount === desiredDocuments.length && current.ftsCount === desiredFtsDocuments.length;
  return {
    ok: report.ok && countsOk,
    issues: report.issues.map((issue) => ({ code: issue.code, articleId: issue.articleId })),
  };
}

/** Builds a deterministic empty D1 result used for a dry-run or a skipped apply. */
export function emptyD1Result(partial: Partial<D1MaterializationResult> = {}): D1MaterializationResult {
  return {
    attempted: false,
    applied: false,
    verified: false,
    state: "dry-run",
    current: { documentCount: 0, ftsCount: 0, documentChecksumHash: "", ftsIdHash: "" },
    desired: { documentCount: 0, ftsCount: 0 },
    plan: null,
    verification: null,
    snapshotPath: null,
    rollbackRequired: false,
    errors: [],
    ...partial,
  };
}

/** Wraps an apply failure into a rollback-required result with a bounded error. */
export function d1ApplyFailure(error: unknown, result: D1MaterializationResult): D1MaterializationResult {
  return {
    ...result,
    attempted: true,
    applied: false,
    verified: false,
    state: "rollback_required",
    rollbackRequired: true,
    errors: [...result.errors, boundedMessage(error)],
  };
}
