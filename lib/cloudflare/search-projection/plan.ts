import { sortSearchProjectionDocuments } from "./checksum";
import { projectionError } from "./errors";
import { alignSearchProjectionFtsDocuments } from "./fts-document";
import {
  SEARCH_DOCUMENT_COLUMNS,
  SEARCH_DOCUMENT_TABLE,
  SEARCH_FTS_COLUMNS,
  SEARCH_FTS_TABLE,
  SEARCH_PROJECTION_SCOPE,
  type SearchProjectionDocument,
  type SearchProjectionFtsDocument,
  type SearchProjectionParam,
  type SearchProjectionPlan,
  type SearchProjectionPlanChanges,
  type SearchProjectionPlanSummary,
  type SearchProjectionStatement,
} from "./types";

/**
 * Local FTS5 synchronization planning.
 *
 * The plan is deterministic, fully parameterized (only authored table/column
 * names appear in SQL text) and hard-scoped to exactly
 * `worldcons_search.search_documents` + `worldcons_search.search_fts`. The plan is
 * explicitly marked non-atomic because M7.1 does not choose or execute an
 * application primitive. A later slice may execute the prepared statements via
 * D1 batch transaction semantics after rollback/failure tests; this module never
 * executes anything.
 */

const INSERT_DOCUMENT_SQL = `INSERT INTO ${SEARCH_DOCUMENT_TABLE} (${SEARCH_DOCUMENT_COLUMNS.join(
  ", ",
)}) VALUES (${SEARCH_DOCUMENT_COLUMNS.map(() => "?").join(", ")})`;
const INSERT_FTS_SQL = `INSERT INTO ${SEARCH_FTS_TABLE} (${SEARCH_FTS_COLUMNS.join(
  ", ",
)}) VALUES (${SEARCH_FTS_COLUMNS.map(() => "?").join(", ")})`;
const DELETE_DOCUMENT_SQL = `DELETE FROM ${SEARCH_DOCUMENT_TABLE} WHERE article_id = ?`;
const DELETE_FTS_SQL = `DELETE FROM ${SEARCH_FTS_TABLE} WHERE article_id = ?`;
const DELETE_ALL_DOCUMENTS_SQL = `DELETE FROM ${SEARCH_DOCUMENT_TABLE}`;
const DELETE_ALL_FTS_SQL = `DELETE FROM ${SEARCH_FTS_TABLE}`;

function documentParams(document: SearchProjectionDocument): SearchProjectionParam[] {
  return SEARCH_DOCUMENT_COLUMNS.map((column) => document[column] as SearchProjectionParam);
}

function ftsParams(document: SearchProjectionFtsDocument): SearchProjectionParam[] {
  return [
    document.article_id,
    document.title,
    document.case_numbers,
    document.search_text,
    document.tags_text,
  ];
}

function documentInsert(document: SearchProjectionDocument): SearchProjectionStatement {
  return { sql: INSERT_DOCUMENT_SQL, params: documentParams(document) };
}

function ftsInsert(document: SearchProjectionFtsDocument): SearchProjectionStatement {
  return { sql: INSERT_FTS_SQL, params: ftsParams(document) };
}

function documentDelete(articleId: string): SearchProjectionStatement {
  return { sql: DELETE_DOCUMENT_SQL, params: [articleId] };
}

function ftsDelete(articleId: string): SearchProjectionStatement {
  return { sql: DELETE_FTS_SQL, params: [articleId] };
}

function indexUniqueDocuments(
  documents: readonly SearchProjectionDocument[],
  label: string,
): Map<string, SearchProjectionDocument> {
  const byId = new Map<string, SearchProjectionDocument>();
  for (const document of documents) {
    if (byId.has(document.article_id)) {
      throw projectionError(
        "duplicate_published_authority",
        `${label} contains duplicate projected article_id ${document.article_id}`,
        document.article_id,
      );
    }
    byId.set(document.article_id, document);
  }
  return byId;
}

function documentsEqual(left: SearchProjectionDocument, right: SearchProjectionDocument): boolean {
  return left.checksum === right.checksum && left.projection_version === right.projection_version;
}

function planChanges(partial: Partial<SearchProjectionPlanChanges>): SearchProjectionPlanChanges {
  return { added: 0, changed: 0, removed: 0, unchanged: 0, ...partial };
}

function plan(
  operation: SearchProjectionPlan["operation"],
  statements: SearchProjectionStatement[],
  changes: SearchProjectionPlanChanges,
): SearchProjectionPlan {
  return {
    scope: SEARCH_PROJECTION_SCOPE,
    operation,
    destructive: statements.some((statement) => statement.sql.startsWith("DELETE")),
    atomic: false,
    executionDeferred: true,
    noop: statements.length === 0,
    changes,
    statements,
  };
}

/**
 * Explicitly destructive, idempotent full rebuild inside `worldcons_search`
 * only: clear FTS5, clear `search_documents`, then insert both sides in
 * `article_id` order.
 */
export function planSearchProjectionFullRebuild(
  documents: readonly SearchProjectionDocument[],
  ftsDocuments: readonly SearchProjectionFtsDocument[],
): SearchProjectionPlan {
  const sorted = sortSearchProjectionDocuments(documents);
  indexUniqueDocuments(sorted, "full-rebuild input");
  const sortedFts = alignSearchProjectionFtsDocuments(sorted, ftsDocuments, "full-rebuild input");
  const statements: SearchProjectionStatement[] = [
    { sql: DELETE_ALL_FTS_SQL, params: [] },
    { sql: DELETE_ALL_DOCUMENTS_SQL, params: [] },
    ...sorted.map(documentInsert),
    ...sortedFts.map(ftsInsert),
  ];
  return plan("full-rebuild", statements, planChanges({ added: sorted.length }));
}

/**
 * Deterministic incremental plan from the current materialized documents to the
 * next desired documents. Added and changed rows update both the
 * `search_documents` and `search_fts` sides (the FTS side uses the M7.2
 * sidecar); removed rows delete from both, so no stale FTS identity survives.
 * Identical input is a true no-op.
 *
 * Changed detection is driven by the document `checksum`. Because every
 * authoritative title component is also part of `search_text`, any title change
 * already changes the checksum, so both the base and FTS sides are recreated.
 */
export function planSearchProjectionIncrementalSync(
  current: readonly SearchProjectionDocument[],
  next: readonly SearchProjectionDocument[],
  nextFtsDocuments: readonly SearchProjectionFtsDocument[],
): SearchProjectionPlan {
  const currentById = indexUniqueDocuments(current, "current");
  const nextById = indexUniqueDocuments(next, "next");
  const alignedNextFts = alignSearchProjectionFtsDocuments(next, nextFtsDocuments, "incremental next");
  const nextFtsById = new Map(alignedNextFts.map((ftsDocument) => [ftsDocument.article_id, ftsDocument]));

  const removed = [...currentById.keys()].filter((id) => !nextById.has(id)).sort();
  const added = [...nextById.keys()].filter((id) => !currentById.has(id)).sort();
  const changed = [...nextById.keys()]
    .filter((id) => {
      const previous = currentById.get(id);
      return previous !== undefined && !documentsEqual(previous, nextById.get(id)!);
    })
    .sort();

  const statements: SearchProjectionStatement[] = [];
  for (const id of removed) statements.push(ftsDelete(id), documentDelete(id));
  for (const id of changed) {
    const document = nextById.get(id)!;
    statements.push(ftsDelete(id), documentDelete(id), documentInsert(document), ftsInsert(nextFtsById.get(id)!));
  }
  for (const id of added) {
    const document = nextById.get(id)!;
    statements.push(documentInsert(document), ftsInsert(nextFtsById.get(id)!));
  }

  const unchanged = nextById.size - added.length - changed.length;
  return plan(
    "incremental",
    statements,
    planChanges({ added: added.length, changed: changed.length, removed: removed.length, unchanged }),
  );
}

/** Safe operator view: statement SQL and parameter counts, never values. */
export function searchProjectionPlanSummary(plan: SearchProjectionPlan): SearchProjectionPlanSummary {
  return {
    scope: plan.scope,
    operation: plan.operation,
    destructive: plan.destructive,
    atomic: plan.atomic,
    executionDeferred: plan.executionDeferred,
    noop: plan.noop,
    changes: plan.changes,
    statementCount: plan.statements.length,
    paramCount: plan.statements.reduce((total, statement) => total + statement.params.length, 0),
    statements: plan.statements.map((statement) => ({ sql: statement.sql, paramCount: statement.params.length })),
  };
}
