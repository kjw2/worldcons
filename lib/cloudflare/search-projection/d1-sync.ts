import { metadataRepairReady, invalidateSearchMetadata, claimMetadataRepair, finishMetadataRepair, applyMetadataProjection } from "./metadata-repair";
import {sha256Canonical} from "../e2e/contracts";
import { currentGenerations, e2eRows, hasE2ETable } from "../e2e/generation-state";
import { buildSearchProjection } from "./build";
import { planSearchProjectionIncrementalSync } from "./plan";
import { verifySearchProjection } from "./verify";
import type {
  SearchArticleTagRow,
  SearchBaseArticleRow,
  SearchProjectionDocument,
  SearchProjectionPlan,
  SearchPublicationP3Row,
  SearchTagRow,
  SearchVersionP3Row,
} from "./types";

type SyncResult<T = Record<string, unknown>> = {
  success?: boolean;
  results?: T[];
  error?: string | null;
  meta?: Record<string, unknown>;
};

type SyncStatement = {
  bind(...values: unknown[]): SyncStatement;
  all<T = Record<string, unknown>>(): Promise<SyncResult<T>>;
  run?(): Promise<SyncResult>;
};

export type SearchProjectionSyncDatabase = {
  prepare(sql: string): SyncStatement;
  batch?(statements: SyncStatement[]): Promise<SyncResult[]>;
};

export interface SearchProjectionSyncBindings {
  WORLDCONS_CORE: SearchProjectionSyncDatabase;
  WORLDCONS_SEARCH: SearchProjectionSyncDatabase;
}

export const SEARCH_PROJECTION_SYNC_PAGE_SIZE = 50;
export const SEARCH_PROJECTION_SYNC_BATCH_SIZE = 40;

export const ELIGIBLE_PUBLISHED_PREDICATE = `
  p.state = 'published'
  AND (
    (
      v.version_role IS NULL
      AND EXISTS (
        SELECT 1 FROM legacy_version_freshness_classifications_v4 f
        WHERE f.version_id = v.id AND f.freshness = 'current'
      )
      AND NOT EXISTS (
        SELECT 1 FROM case_catalog_publications_v1 c
        WHERE c.article_id = v.article_id AND c.state = 'published'
      )
    )
    OR
    (
      v.version_role = 'enrichment_full'
      AND EXISTS (
        SELECT 1
        FROM case_catalog_publications_v1 c
        JOIN article_content_versions_p3 anchor ON anchor.id = c.source_anchor_version_id
        WHERE c.article_id = v.article_id
          AND c.state = 'published'
          AND c.source_anchor_version_id = v.source_anchor_version_id
          AND anchor.source_content_hash = v.enrichment_source_content_hash
      )
    )
  )
`;

type EligibleSourceRow = {
  publication_id: string;
  article_id: string;
  publication_state: string;
  publication_version_id: string;
  publication_revision: string | number | null;
  publication_published_at: string | null;
  publication_withdrawn_at: string | null;
  publication_created_at: string;
  publication_updated_at: string | null;
  version_id: string;
  version_revision: string | number | null;
  slug: string;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: string;
  original_language: string;
  original_title: string | null;
  korean_title: string | null;
  original_published_at: string | null;
  cleaned_text: string | null;
  summary_json: unknown;
  source_metadata: unknown;
  case_key: string | null;
  version_created_at: string;
  fetched_at: string | null;
  summarized_at: string | null;
  content_hash: string;
  version_role: string | null;
  source_anchor_version_id: string | null;
  enrichment_source_content_hash: string | null;
  source_content_hash: string | null;
  review_state: string | null;
};

type EligibleTagRow = {
  article_id: string;
  tag_id: string;
  confidence: number | null;
  slug: string;
  name: string | null;
  normalized_name: string | null;
  type: string | null;
};

export const SOURCE_SQL = `
SELECT
  p.id AS publication_id,
  p.article_id AS article_id,
  p.state AS publication_state,
  p.version_id AS publication_version_id,
  p.revision AS publication_revision,
  p.published_at AS publication_published_at,
  p.withdrawn_at AS publication_withdrawn_at,
  p.created_at AS publication_created_at,
  p.updated_at AS publication_updated_at,
  v.id AS version_id,
  v.revision AS version_revision,
  v.slug,
  v.source_key,
  v.jurisdiction,
  v.institution_name,
  v.content_type,
  v.original_language,
  v.original_title,
  v.korean_title,
  v.original_published_at,
  v.cleaned_text,
  v.summary_json,
  v.source_metadata,
  v.case_key,
  v.created_at AS version_created_at,
  v.fetched_at,
  v.summarized_at,
  v.content_hash,
  v.version_role,
  v.source_anchor_version_id,
  v.enrichment_source_content_hash,
  v.source_content_hash,
  a.review_state
FROM article_publications_p3 p
JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id
LEFT JOIN articles a ON a.id = p.article_id
WHERE ${ELIGIBLE_PUBLISHED_PREDICATE}
ORDER BY p.article_id
`;

async function readRows<T>(
  database: SearchProjectionSyncDatabase,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await database.prepare(sql).bind(...params).all<T>();
  if (result.success === false || result.error) {
    throw new Error(`search_projection.read_failed:${result.error ?? "D1 query failed"}`);
  }
  return result.results ?? [];
}

async function readPaged<T>(
  database: SearchProjectionSyncDatabase,
  baseSql: string,
  pageSize = 500,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await readRows<T>(database, `${baseSql}\nLIMIT ? OFFSET ?`, [pageSize, offset]);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return rows;
}

function inPlaceholders(count: number) {
  if (!Number.isInteger(count) || count <= 0 || count > 80) throw new Error("search_projection.invalid_in_count");
  return Array.from({ length: count }, () => "?").join(",");
}

async function readEligibleSourcePage(
  database: SearchProjectionSyncDatabase,
  afterArticleId: string,
): Promise<EligibleSourceRow[]> {
  return readRows<EligibleSourceRow>(
    database,
    `${SOURCE_SQL.replace(/ORDER BY p\.article_id\s*$/u, "")}\nAND p.article_id > ?\nORDER BY p.article_id\nLIMIT ?`,
    [afterArticleId, SEARCH_PROJECTION_SYNC_PAGE_SIZE],
  );
}

export async function readTagsForArticleIds(
  database: SearchProjectionSyncDatabase,
  articleIds: readonly string[],
): Promise<EligibleTagRow[]> {
  if (articleIds.length === 0) return [];
  const placeholders = inPlaceholders(articleIds.length);
  return readRows<EligibleTagRow>(database, `
    SELECT at.article_id,at.tag_id,at.confidence,t.slug,t.name,t.normalized_name,t.type
    FROM article_tags at
    JOIN tags t ON t.id = at.tag_id
    WHERE at.article_id IN (${placeholders})
    ORDER BY at.article_id,at.tag_id
  `, articleIds);
}

type CurrentDocumentIdentityRow = {
  article_id: string;
  checksum: string | null;
  projection_version: number | string | null;
};

function currentIdentityDocument(
  articleId: string,
  row: CurrentDocumentIdentityRow | undefined,
  forceRepair: boolean,
): SearchProjectionDocument {
  const parsedVersion = row?.projection_version === null || row?.projection_version === undefined
    ? 0
    : Number(row.projection_version);
  const projectionVersion = Number.isFinite(parsedVersion) ? parsedVersion : 0;
  return {
    article_id: articleId,
    jurisdiction: null,
    source_key: null,
    language: null,
    content_type: null,
    publication_state: "published",
    review_state: null,
    original_published_at: null,
    display_title: null,
    case_numbers: null,
    search_text: null,
    tags_text: null,
    projection_version: forceRepair ? -1 : projectionVersion,
    checksum: forceRepair ? `repair:${articleId}` : (row?.checksum ?? ""),
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

async function readCurrentIdentitiesForArticleIds(
  database: SearchProjectionSyncDatabase,
  articleIds: readonly string[],
): Promise<SearchProjectionDocument[]> {
  if (articleIds.length === 0) return [];
  const placeholders = inPlaceholders(articleIds.length);
  const [documents, ftsCounts] = await Promise.all([
    readRows<CurrentDocumentIdentityRow>(database,
      `SELECT article_id,checksum,projection_version FROM search_documents WHERE article_id IN (${placeholders})`,
      articleIds,
    ),
    readRows<{ article_id: string; count: number | string }>(database,
      `SELECT article_id,COUNT(*) AS count FROM search_fts WHERE article_id IN (${placeholders}) GROUP BY article_id`,
      articleIds,
    ),
  ]);
  const documentById = new Map(documents.map((row) => [row.article_id, row]));
  const ftsCountById = new Map(ftsCounts.map((row) => [row.article_id, Number(row.count)]));
  const current: SearchProjectionDocument[] = [];
  for (const articleId of articleIds) {
    const document = documentById.get(articleId);
    const ftsCount = ftsCountById.get(articleId) ?? 0;
    if (!document && ftsCount === 0) continue;
    current.push(currentIdentityDocument(articleId, document, !document || ftsCount !== 1));
  }
  return current;
}

async function verifyProjectionPage(
  database: SearchProjectionSyncDatabase,
  projected: readonly SearchProjectionDocument[],
) {
  if (projected.length === 0) return;
  const articleIds = projected.map((row) => row.article_id);
  const placeholders = inPlaceholders(articleIds.length);
  const [documents, ftsRows] = await Promise.all([
    readRows<CurrentDocumentIdentityRow>(database,
      `SELECT article_id,checksum,projection_version FROM search_documents WHERE article_id IN (${placeholders}) ORDER BY article_id`,
      articleIds,
    ),
    readRows<{ article_id: string }>(database,
      `SELECT article_id FROM search_fts WHERE article_id IN (${placeholders}) ORDER BY article_id`,
      articleIds,
    ),
  ]);
  const verification = verifySearchProjection({
    projected,
    documents: documents.map((row) => ({
      article_id: row.article_id,
      checksum: row.checksum,
      projection_version: row.projection_version === null ? null : Number(row.projection_version),
    })),
    ftsArticleIds: ftsRows.map((row) => row.article_id),
  });
  if (!verification.ok) {
    const codes = [...new Set(verification.issues.map((issue) => issue.code))].slice(0, 5).join("|");
    throw new Error(`search_projection.page_verify_failed:${codes || "unknown"}`);
  }
}

function sameTag(left: SearchTagRow, right: SearchTagRow) {
  return left.slug === right.slug
    && (left.name ?? null) === (right.name ?? null)
    && (left.normalized_name ?? null) === (right.normalized_name ?? null)
    && (left.type ?? null) === (right.type ?? null);
}

export function buildSearchProjectionInputFromEligibleRows(
  sourceRows: readonly EligibleSourceRow[],
  tagRows: readonly EligibleTagRow[],
) {
  const publications: SearchPublicationP3Row[] = [];
  const versions: SearchVersionP3Row[] = [];
  const articles: SearchBaseArticleRow[] = [];
  for (const row of sourceRows) {
    publications.push({
      id: row.publication_id,
      article_id: row.article_id,
      state: row.publication_state,
      version_id: row.publication_version_id,
      revision: row.publication_revision,
      published_at: row.publication_published_at,
      withdrawn_at: row.publication_withdrawn_at,
      created_at: row.publication_created_at,
      updated_at: row.publication_updated_at,
    });
    versions.push({
      id: row.version_id,
      article_id: row.article_id,
      revision: row.version_revision,
      slug: row.slug,
      source_key: row.source_key,
      jurisdiction: row.jurisdiction,
      institution_name: row.institution_name,
      content_type: row.content_type,
      original_language: row.original_language,
      original_title: row.original_title,
      korean_title: row.korean_title,
      original_published_at: row.original_published_at,
      cleaned_text: row.cleaned_text,
      summary_json: row.summary_json,
      source_metadata: row.source_metadata,
      case_key: row.case_key,
      created_at: row.version_created_at,
      fetched_at: row.fetched_at,
      summarized_at: row.summarized_at,
      content_hash: row.content_hash,
      version_role: row.version_role,
      source_anchor_version_id: row.source_anchor_version_id,
      enrichment_source_content_hash: row.enrichment_source_content_hash,
      source_content_hash: row.source_content_hash,
    });
    articles.push({ id: row.article_id, review_state: row.review_state });
  }

  const tagsById = new Map<string, SearchTagRow>();
  const articleTags: SearchArticleTagRow[] = [];
  for (const row of tagRows) {
    const tag: SearchTagRow = {
      id: row.tag_id,
      slug: row.slug,
      name: row.name,
      normalized_name: row.normalized_name,
      type: row.type,
    };
    const existing = tagsById.get(row.tag_id);
    if (existing && !sameTag(existing, tag)) throw new Error(`search_projection.tag_conflict:${row.tag_id}`);
    if (!existing) tagsById.set(row.tag_id, tag);
    articleTags.push({ article_id: row.article_id, tag_id: row.tag_id, confidence: row.confidence });
  }
  return { publications, versions, articles, tags: [...tagsById.values()], articleTags };
}

export async function applySearchProjectionPlan(
  database: SearchProjectionSyncDatabase,
  plan: SearchProjectionPlan,
  batchSize = SEARCH_PROJECTION_SYNC_BATCH_SIZE,
) {
  if (!database.batch) throw new Error("search_projection.batch_unavailable");
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 100) throw new Error("search_projection.invalid_batch_size");
  const guardedSchema = await hasE2ETable(database,"e2e_search_generation_guards_v1");
  const metadataSchema = await hasE2ETable(database,"search_metadata_guards_v1");
  let batches = 0;
  const effectiveBatchSize = guardedSchema ? Math.min(batchSize,98) : batchSize;
  for (let index = 0; index < plan.statements.length; index += effectiveBatchSize) {
    const statements = plan.statements.slice(index, index + effectiveBatchSize);
    const prepared = statements.map((statement) => database.prepare(statement.sql).bind(...statement.params));
    if (guardedSchema) {
      const token=crypto.randomUUID();
      const allRows=statements.some(statement=>statement.params.length===0);
      const ids=[...new Set(statements.map(statement=>String(statement.params[0]??"")))];
      const predicate=allRows ? "1=1" : `article_id IN (${ids.map(()=>"?").join(",")})`;
      prepared.unshift(database.prepare(`INSERT INTO e2e_search_commit_guards_v1 (token,assertion)
        VALUES (?,CASE WHEN NOT EXISTS (SELECT 1 FROM e2e_search_generation_guards_v1 WHERE ${predicate}) ${metadataSchema ? `AND NOT EXISTS (SELECT 1 FROM search_metadata_guards_v1 WHERE ${predicate})` : ""} THEN 1 ELSE 0 END)`).bind(token,...(allRows ? [] : ids),...(metadataSchema && !allRows ? ids : [])));
      prepared.push(database.prepare("DELETE FROM e2e_search_commit_guards_v1 WHERE token=?").bind(token));
    }
    const results = await database.batch(prepared);
    if (!Array.isArray(results) || results.length !== prepared.length) {
      throw new Error("search_projection.batch_result_mismatch");
    }
    if (results.some((result) => result.success === false || result.error)) {
      throw new Error("search_projection.batch_failed");
    }
    batches += 1;
  }
  return batches;
}

export async function runNativeSearchProjectionSync(bindings: SearchProjectionSyncBindings) {
  const managedIds=new Set<string>();
  if (await hasE2ETable(bindings.WORLDCONS_CORE,"e2e_generation_heads_v1")) {
    for (const row of await e2eRows(bindings.WORLDCONS_CORE,"SELECT article_id FROM e2e_generation_heads_v1")) managedIds.add(String(row.article_id));
  }
  if(await hasE2ETable(bindings.WORLDCONS_CORE,"search_metadata_repairs_v1")) {
    for(const row of await e2eRows(bindings.WORLDCONS_CORE,"SELECT article_id FROM search_metadata_repairs_v1")) managedIds.add(String(row.article_id));
  }
  // Protected rows use current Core identity and the durable outbox, never this scan's legacy write plan.
  for(const id of managedIds)await syncSearchProjectionForArticle(bindings,id);
  const eligibleCountRows = await readRows<{ count: number | string }>(
    bindings.WORLDCONS_CORE,
    `SELECT COUNT(*) AS count FROM article_publications_p3 p JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id WHERE ${ELIGIBLE_PUBLISHED_PREDICATE}`,
  );
  const eligibleCount = Number(eligibleCountRows[0]?.count ?? 0);
  if (!Number.isFinite(eligibleCount) || eligibleCount < 0) throw new Error("search_projection.invalid_eligible_count");

  const desiredIds = new Set<string>();
  const changes = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  let statementCount = 0;
  let batchCount = 0;
  let afterArticleId = "";

  for (;;) {
    const sourceRows = await readEligibleSourcePage(bindings.WORLDCONS_CORE, afterArticleId);
    if (sourceRows.length === 0) break;
    const articleIds = sourceRows.map((row) => row.article_id);
    for (const articleId of articleIds) {
      if (desiredIds.has(articleId)) throw new Error(`search_projection.duplicate_eligible_article:${articleId}`);
      desiredIds.add(articleId);
    }
    const writableIds=articleIds.filter(id=>!managedIds.has(id));
    const tagRows = await readTagsForArticleIds(bindings.WORLDCONS_CORE, writableIds);
    const input = buildSearchProjectionInputFromEligibleRows(sourceRows.filter(row=>!managedIds.has(row.article_id)), tagRows);
    const built = buildSearchProjection(input);
    const current = await readCurrentIdentitiesForArticleIds(bindings.WORLDCONS_SEARCH, writableIds);
    const plan = planSearchProjectionIncrementalSync(current, built.documents, built.ftsDocuments);
    batchCount += await applySearchProjectionPlan(bindings.WORLDCONS_SEARCH, plan);
    statementCount += plan.statements.length;
    changes.added += plan.changes.added;
    changes.changed += plan.changes.changed;
    changes.unchanged += plan.changes.unchanged;
    await verifyProjectionPage(bindings.WORLDCONS_SEARCH, built.documents);
    afterArticleId = articleIds[articleIds.length - 1];
    if (sourceRows.length < SEARCH_PROJECTION_SYNC_PAGE_SIZE) break;
  }

  if (desiredIds.size !== eligibleCount) {
    throw new Error(`search_projection.source_changed_during_sync:${eligibleCount}:${desiredIds.size}`);
  }

  const [currentDocumentIds, currentFtsIds] = await Promise.all([
    readPaged<{ article_id: string }>(bindings.WORLDCONS_SEARCH, "SELECT article_id FROM search_documents ORDER BY article_id"),
    readPaged<{ article_id: string }>(bindings.WORLDCONS_SEARCH, "SELECT article_id FROM search_fts ORDER BY article_id"),
  ]);
  const staleIds = [...new Set([...currentDocumentIds, ...currentFtsIds].map((row) => row.article_id))]
    .filter((articleId) => !desiredIds.has(articleId) && !managedIds.has(articleId))
    .sort();
  const newlyManaged = await currentGenerations(bindings.WORLDCONS_CORE,staleIds);
  const removableIds = staleIds.filter(id=>!newlyManaged.has(id));
  if (removableIds.length > 0) {
    const removalPlan: SearchProjectionPlan = {
      scope: "worldcons_search",
      operation: "incremental",
      destructive: true,
      atomic: false,
      executionDeferred: true,
      noop: false,
      changes: { added: 0, changed: 0, removed: removableIds.length, unchanged: 0 },
      statements: removableIds.flatMap((articleId) => [
        { sql: "DELETE FROM search_fts WHERE article_id = ?", params: [articleId] },
        { sql: "DELETE FROM search_documents WHERE article_id = ?", params: [articleId] },
      ]),
    };
    batchCount += await applySearchProjectionPlan(bindings.WORLDCONS_SEARCH, removalPlan);
    statementCount += removalPlan.statements.length;
    changes.removed += removableIds.length;
  }

  const [documentCountRows, ftsCountRows] = await Promise.all([
    readRows<{ count: number | string }>(bindings.WORLDCONS_SEARCH, "SELECT COUNT(*) AS count FROM search_documents"),
    readRows<{ count: number | string; distinct_count: number | string }>(
      bindings.WORLDCONS_SEARCH,
      "SELECT COUNT(*) AS count,COUNT(DISTINCT article_id) AS distinct_count FROM search_fts",
    ),
  ]);
  const documentCount = Number(documentCountRows[0]?.count ?? -1);
  const ftsCount = Number(ftsCountRows[0]?.count ?? -1);
  const ftsDistinctCount = Number(ftsCountRows[0]?.distinct_count ?? -1);
  if (documentCount !== desiredIds.size || ftsCount !== desiredIds.size || ftsDistinctCount !== desiredIds.size) {
    throw new Error(`search_projection.final_count_mismatch:${desiredIds.size}:${documentCount}:${ftsCount}:${ftsDistinctCount}`);
  }

  return {
    kind: "search-projection-sync" as const,
    projected: desiredIds.size,
    changes,
    statementCount,
    batchCount,
    verified: true,
    documentCount,
    ftsCount,
  };
}

export async function readEligibleSourceForArticle(
  database: SearchProjectionSyncDatabase,
  articleId: string,
): Promise<EligibleSourceRow[]> {
  return readRows<EligibleSourceRow>(
    database,
    `${SOURCE_SQL.replace(/\nORDER BY p\.article_id\s*$/u, "")}\nAND p.article_id = ?\nLIMIT 1`,
    [articleId],
  );
}

export interface SyncSearchProjectionForArticleResult {
  articleId: string;
  desiredEligible: boolean;
  documentCount: number;
  ftsCount: number;
  changes: { added: number; changed: number; removed: number; unchanged: number };
  verified: true;
}

/**
 * Projects exactly one article/version into `worldcons_search`.
 *
 * This is the per-article primitive the staged `search` handler uses instead of
 * the full `runNativeSearchProjectionSync` scan (which reads the entire eligible
 * corpus and reconciles every article). It reuses the exact same gate2 eligible
 * predicate (`ELIGIBLE_PUBLISHED_PREDICATE`), the same pure projection builder,
 * the same incremental plan and the same page verification, then asserts the
 * per-article FTS/search integrity: the named article has exactly one
 * `search_documents` row and exactly one `search_fts` row when eligible, and
 * zero when it is no longer eligible (so a withdrawn/unpublished article cannot
 * leave a stale search identity behind).
 *
 * It never reads or writes any other article's projection rows.
 */
export async function syncSearchProjectionForArticle(bindings: SearchProjectionSyncBindings, articleId: string): Promise<SyncSearchProjectionForArticleResult> {
  if(!await metadataRepairReady(bindings.WORLDCONS_CORE,bindings.WORLDCONS_SEARCH))return syncArticleProjection(bindings,articleId);
  const current=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM search_metadata_repairs_v1 WHERE article_id=?",articleId))[0];
  if(!current || current.status==='verified')await invalidateSearchMetadata(bindings.WORLDCONS_CORE,articleId);
  const claim=await claimMetadataRepair(bindings.WORLDCONS_CORE,articleId);
  if(!claim)throw new Error('metadata.repair_busy_or_exhausted');
  try {
    const result=await syncArticleProjection(bindings,articleId,claim);
    await finishMetadataRepair(bindings.WORLDCONS_CORE,claim);
    const latest=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM search_metadata_repairs_v1 WHERE article_id=?",articleId))[0];
    if(latest?.status!=='verified'||Number(latest.revision)!==Number(claim.revision)||Number(latest.fencing_token)!==Number(claim.fencing_token))throw new Error('metadata.core_changed_during_repair');
    return result;
  } catch(error) {await finishMetadataRepair(bindings.WORLDCONS_CORE,claim,error);throw error;}
}

async function syncArticleProjection(
  bindings: SearchProjectionSyncBindings,
  articleId: string,
  metadataClaim?: import("../e2e/generation-state").GenerationRow,
): Promise<SyncSearchProjectionForArticleResult> {
  if (typeof articleId !== "string" || articleId.length === 0) {
    throw new Error("search_projection.invalid_article_id");
  }
  const managed=(await currentGenerations(bindings.WORLDCONS_CORE,[articleId])).get(articleId);
  if(managed) {
    const {consumeSearchRepair,desiredSearchProjection}=await import("../e2e/search-repair-consumer");
    const {inspectSearchProjection,searchIdentity}=await import("../e2e/search-generation-guard");
    const {readArticlePublicationSnapshotFromD1,transitionArticlePublicationInD1}=await import("../core-write/authority");
    let g=managed;
    if(Number(g.identity_current)!==1)throw new Error("search_projection.e2e_identity_changed");
    let outbox=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM e2e_search_repair_outbox_v1 WHERE generation_id=?",g.generation_id))[0];
    if(!outbox)throw new Error("search_projection.e2e_reservation_missing");
    let damaged=false;
    if(g.input_current) {
      const desired=await desiredSearchProjection(bindings.WORLDCONS_CORE,g);
      const receipt=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM e2e_search_apply_receipts_v1 WHERE generation_id=?",g.generation_id))[0];
      const storedMatches=receipt&&(await inspectSearchProjection(bindings.WORLDCONS_SEARCH,searchIdentity(g,Number(receipt.fencing_token)),desired.document,desired.fts)).matches;
      if(storedMatches)return {articleId,desiredEligible:desired.document!==null,documentCount:Number(desired.document!==null),ftsCount:Number(desired.fts!==null),changes:{added:0,changed:0,removed:0,unchanged:1},verified:true};
      damaged=outbox.status==="verified";
    }
    if(!g.input_current||damaged) {
      const snapshot=await readArticlePublicationSnapshotFromD1(bindings.WORLDCONS_CORE,articleId);if(!snapshot.ok)throw new Error("search_projection.e2e_snapshot_unavailable");
      const blocked=["needs_review","needs_triage","closed_private","rejected","blocked"].includes(String(g.review_state));
      const result=await transitionArticlePublicationInD1(bindings.WORLDCONS_CORE,{articleId,expectedVersionRevision:snapshot.data.versionRevision,expectedPublicationRevision:snapshot.data.publicationRevision,
        expectedLegacyUpdatedAt:snapshot.data.legacyUpdatedAt,idempotencyKey:"projection-refresh:"+await sha256Canonical({generationId:g.generation_id,tags:g.tag_snapshot,reviewState:g.review_state,integrityRepair:damaged}),
        targetState:blocked?"withdrawn":g.expected_publication_state as "published"|"withdrawn",versionId:String(g.expected_version_id),captureLegacy:false,repairProjection:damaged,
        actorType:"compatibility",actorId:"guarded-search-sync",reason:damaged?"Repair physical projection of the current approved snapshot":"Refresh metadata for the current approved snapshot"});
      if(!result.ok)throw new Error("search_projection.e2e_transition:"+result.error.code);
      g=(await currentGenerations(bindings.WORLDCONS_CORE,[articleId])).get(articleId)!;
      outbox=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM e2e_search_repair_outbox_v1 WHERE generation_id=?",g.generation_id))[0];
    }
    const applied=await consumeSearchRepair(bindings.WORLDCONS_CORE,bindings.WORLDCONS_SEARCH,{schemaVersion:1,type:"e2e-search-repair",outboxId:outbox.outbox_id});
    if(!["awaiting_verification","terminal"].includes(applied.status))throw new Error("search_projection.e2e_apply_not_ready");
    const desired=await desiredSearchProjection(bindings.WORLDCONS_CORE,g);
    const receipt=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT * FROM e2e_search_apply_receipts_v1 WHERE generation_id=?",g.generation_id))[0];
    if(!receipt||!(await inspectSearchProjection(bindings.WORLDCONS_SEARCH,searchIdentity(g,Number(receipt.fencing_token)),desired.document,desired.fts)).matches)throw new Error("search_projection.e2e_content_mismatch");
    return {articleId,desiredEligible:desired.document!==null,documentCount:Number(desired.document!==null),ftsCount:Number(desired.fts!==null),changes:{added:0,changed:1,removed:Number(desired.document===null),unchanged:0},verified:true};
  }
  const sourceRows = await readEligibleSourceForArticle(bindings.WORLDCONS_CORE, articleId);
  if(metadataClaim && sourceRows.some(row=>["needs_review","needs_triage","closed_private","rejected","blocked"].includes(String(row.review_state)))) {
    const {readArticlePublicationSnapshotFromD1,transitionArticlePublicationInD1}=await import("../core-write/authority");
    const snapshot=await readArticlePublicationSnapshotFromD1(bindings.WORLDCONS_CORE,articleId);
    if(!snapshot.ok)throw new Error("metadata.withdraw_snapshot_unavailable");
    const removed=await transitionArticlePublicationInD1(bindings.WORLDCONS_CORE,{articleId,
      expectedVersionRevision:snapshot.data.versionRevision,expectedPublicationRevision:snapshot.data.publicationRevision,expectedLegacyUpdatedAt:snapshot.data.legacyUpdatedAt,
      idempotencyKey:"metadata-withdraw:"+articleId+":"+metadataClaim.revision,targetState:"withdrawn",captureLegacy:false,versionId:sourceRows[0].version_id,
      actorType:"compatibility",actorId:"metadata-repair",reason:"Withdraw published snapshot after review metadata prohibits public access"});
    if(!removed.ok)throw new Error("metadata.withdraw_failed:"+removed.error.code);
    return syncArticleProjection(bindings,articleId,metadataClaim);
  }
  const desiredEligible = sourceRows.length > 0;
  const tagRows = desiredEligible ? await readTagsForArticleIds(bindings.WORLDCONS_CORE, [articleId]) : [];
  const input = buildSearchProjectionInputFromEligibleRows(sourceRows, tagRows);
  const built = buildSearchProjection(input);
  const current = await readCurrentIdentitiesForArticleIds(bindings.WORLDCONS_SEARCH, [articleId]);
  const plan = planSearchProjectionIncrementalSync(current, built.documents, built.ftsDocuments);
  if(metadataClaim)await applyMetadataProjection(bindings.WORLDCONS_SEARCH,metadataClaim,built.documents[0]??null,built.ftsDocuments[0]??null);
  else await applySearchProjectionPlan(bindings.WORLDCONS_SEARCH, plan);
  if (desiredEligible) await verifyProjectionPage(bindings.WORLDCONS_SEARCH, built.documents);

  const [documentCountRows, ftsCountRows] = await Promise.all([
    readRows<{ count: number | string }>(
      bindings.WORLDCONS_SEARCH,
      "SELECT COUNT(*) AS count FROM search_documents WHERE article_id = ?",
      [articleId],
    ),
    readRows<{ count: number | string; distinct_count: number | string }>(
      bindings.WORLDCONS_SEARCH,
      "SELECT COUNT(*) AS count,COUNT(DISTINCT article_id) AS distinct_count FROM search_fts WHERE article_id = ?",
      [articleId],
    ),
  ]);
  const documentCount = Number(documentCountRows[0]?.count ?? -1);
  const ftsCount = Number(ftsCountRows[0]?.count ?? -1);
  const expected = desiredEligible ? 1 : 0;
  if (documentCount !== expected || ftsCount !== expected) {
    throw new Error(`search_projection.article_count_mismatch:${articleId}:${expected}:${documentCount}:${ftsCount}`);
  }
  return {
    articleId,
    desiredEligible,
    documentCount,
    ftsCount,
    changes: plan.changes,
    verified: true,
  };
}
