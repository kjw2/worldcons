import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SearchProjectionError,
  buildSearchProjection,
  selectPublishedSearchProjectionSources,
  type SearchCatalogPublicationV1Row,
  type SearchLegacyFreshnessRow,
  type SearchProjectionSourceInput,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import {
  SEMANTIC_PROVENANCE_AUDIT_SQL,
  parseSemanticProvenanceAuditRow,
} from "../lib/cloudflare/search-vector";

const rootDir = process.cwd();
const MIGRATION_NAME = "20260926120000_m7_7a_semantic_authority_projection.sql";
const migrationSql = fs.readFileSync(path.join(rootDir, "supabase/migrations", MIGRATION_NAME), "utf8");
const gate2Sql = fs.readFileSync(
  path.join(rootDir, "supabase/migrations/20260903130000_constitutional_case_catalog_gate2.sql"),
  "utf8",
);
const sourceSql = fs.readFileSync(path.join(rootDir, "lib/cloudflare/search-projection/source.ts"), "utf8");
const auditScript = fs.readFileSync(path.join(rootDir, "scripts/semantic-provenance-audit.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The `create or replace view public_article_projection_p3 ...;` statement text. */
function projectionViewStatement(sql: string): string {
  const start = sql.indexOf("create or replace view public_article_projection_p3");
  assert.ok(start >= 0, "public_article_projection_p3 definition must exist");
  const end = sql.indexOf(";", start);
  assert.ok(end > start, "public_article_projection_p3 definition must terminate");
  return sql.slice(start, end);
}

/** Splits a SQL select list on top-level commas, respecting nested parentheses. */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/** The ordered top-level select list of the projection view. */
function projectionSelectList(statement: string): string[] {
  const selectStart = statement.indexOf("select") + "select".length;
  const fromStart = statement.indexOf("from article_publications_p3 p");
  assert.ok(fromStart > selectStart, "the projection view must select from article_publications_p3");
  return splitTopLevel(statement.slice(selectStart, fromStart));
}

/** The `where ...` predicate of the projection view, whitespace-normalized. */
function projectionPredicate(statement: string): string {
  const whereStart = statement.indexOf("where p.state='published'");
  assert.ok(whereStart >= 0, "the projection view must filter on published state");
  return statement
    .slice(whereStart)
    .replace(/\s+/gu, " ")
    .trim();
}

function columnAlias(expression: string): string {
  const asIndex = expression.toLowerCase().lastIndexOf(" as ");
  if (asIndex >= 0) return expression.slice(asIndex + 4).trim();
  const dotIndex = expression.lastIndexOf(".");
  return dotIndex >= 0 ? expression.slice(dotIndex + 1).trim() : expression;
}

test("M7.7-A migration preserves the gate2 column list/order and changes only embedding authority", () => {
  const gate2Columns = projectionSelectList(projectionViewStatement(gate2Sql));
  const m77aColumns = projectionSelectList(projectionViewStatement(migrationSql));

  assert.deepEqual(m77aColumns.map(columnAlias), gate2Columns.map(columnAlias));

  const embeddingIndex = gate2Columns.findIndex((column) => columnAlias(column) === "embedding");
  assert.ok(embeddingIndex >= 0);
  assert.equal(gate2Columns[embeddingIndex].replace(/\s+/gu, " "), "v.embedding");
  assert.equal(m77aColumns[embeddingIndex].replace(/\s+/gu, " "), "coalesce(e.embedding,v.embedding) as embedding");

  for (let index = 0; index < gate2Columns.length; index += 1) {
    if (index === embeddingIndex) continue;
    assert.equal(
      m77aColumns[index].replace(/\s+/gu, " "),
      gate2Columns[index].replace(/\s+/gu, " "),
      `column ${index} must be byte-identical to gate2`,
    );
  }
});

test("M7.7-A migration preserves the gate2 eligibility predicate exactly", () => {
  assert.equal(
    projectionPredicate(projectionViewStatement(migrationSql)),
    projectionPredicate(projectionViewStatement(gate2Sql)),
    "the published/freshness/catalog predicate must not drift",
  );
  assert.match(migrationSql, /legacy_version_freshness_classifications_v4 l/);
  assert.match(migrationSql, /l\.freshness='current'/);
  assert.match(migrationSql, /case_catalog_publications_v1 c/);
  assert.match(migrationSql, /c\.source_anchor_version_id=v\.source_anchor_version_id/);
  assert.match(migrationSql, /anchor\.source_content_hash=v\.enrichment_source_content_hash/);
});

test("M7.7-A migration joins the current provenance-locked Gemini artifact", () => {
  assert.match(migrationSql, /left join article_embedding_artifacts e/u);
  assert.match(migrationSql, /e\.article_version_id=v\.id/u);
  assert.match(migrationSql, /e\.article_id=v\.article_id/u);
  assert.match(migrationSql, /e\.content_hash=v\.content_hash/u);
  assert.match(migrationSql, /e\.provider='gemini'/u);
  assert.match(migrationSql, /e\.model='gemini-embedding-001'/u);
  assert.match(migrationSql, /e\.dimensions=1536/u);
  assert.match(migrationSql, /with \(security_barrier = true\)/u);
});

test("M7.7-A migration fails closed on view column drift and reloads PostgREST", () => {
  assert.match(migrationSql, /M77A_PROJECTION_VIEW_MISSING/u);
  assert.match(migrationSql, /M77A_PROJECTION_VIEW_COLUMN_DRIFT/u);
  assert.match(migrationSql, /pg_attribute/u);
  assert.match(migrationSql, /a\.attname order by a\.attnum/u);
  assert.match(migrationSql, /notify pgrst, 'reload schema';/u);
  assert.match(migrationSql, /grant select on public_article_projection_p3 to anon/u);
  assert.match(migrationSql, /grant select on public_article_projection_p3 to authenticated/u);
  assert.match(migrationSql, /grant select on public_article_projection_p3 to service_role/u);
  assert.match(migrationSql, /^begin;/u);
  assert.match(migrationSql, /commit;\s*$/u);
  assert.ok(
    fs.existsSync(path.join(rootDir, "supabase/migrations", MIGRATION_NAME)),
    "exactly one new timestamped M7.7-A migration must exist",
  );
});

const ARTICLE_A = "11111111-0000-0000-0000-000000000001";
const ARTICLE_B = "22222222-0000-0000-0000-000000000002";
const VERSION_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const VERSION_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const VERSION_ANCHOR = "aaaaaaaa-0000-0000-0000-0000000000a1";
const PUB_A = "cccccccc-0000-0000-0000-00000000000c";
const PUB_B = "dddddddd-0000-0000-0000-00000000000d";
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

function publication(overrides: Partial<SearchPublicationP3Row> = {}): SearchPublicationP3Row {
  return {
    id: PUB_A,
    article_id: ARTICLE_A,
    state: "published",
    version_id: VERSION_A,
    revision: "1",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function version(overrides: Partial<SearchVersionP3Row> = {}): SearchVersionP3Row {
  return {
    id: VERSION_A,
    article_id: ARTICLE_A,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "Bundesverfassungsgericht",
    content_type: "decision",
    original_language: "de",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-01-01T00:00:00.000Z",
    cleaned_text: "cleaned body text",
    summary_json: null,
    source_metadata: null,
    case_key: "1bvr265618",
    created_at: "2026-01-02T00:00:00.000Z",
    content_hash: HASH_A,
    source_content_hash: HASH_A,
    version_role: null,
    source_anchor_version_id: null,
    enrichment_source_content_hash: null,
    ...overrides,
  };
}

function eligibility(
  overrides: Partial<{
    legacyFreshnessClassifications: SearchLegacyFreshnessRow[];
    catalogPublications: SearchCatalogPublicationV1Row[];
  }> = {},
): Pick<SearchProjectionSourceInput, "gate2Eligibility"> {
  return {
    gate2Eligibility: {
      legacyFreshnessClassifications: overrides.legacyFreshnessClassifications ?? [],
      catalogPublications: overrides.catalogPublications ?? [],
    },
  };
}

function selectedArticleIds(input: SearchProjectionSourceInput): string[] {
  return selectPublishedSearchProjectionSources(input).map((entry) => entry.version.article_id);
}

test("source selection keeps the historical published-only selection without gate2 eligibility", () => {
  const selected = selectedArticleIds({ publications: [publication()], versions: [version()] });
  assert.deepEqual(selected, [ARTICLE_A]);
  assert.match(sourceSql, /gate2Eligibility/u, "source.ts must document/implement gate2 eligibility");
  assert.doesNotMatch(sourceSql, /Exactly mirrors/u, "the unconditional parity claim must be removed");
});

test("gate2 legacy eligibility requires a current freshness classification and no published catalog", () => {
  const current: SearchLegacyFreshnessRow[] = [{ version_id: VERSION_A, freshness: "current" }];

  assert.deepEqual(
    selectedArticleIds({ publications: [publication()], versions: [version()], ...eligibility({ legacyFreshnessClassifications: current }) }),
    [ARTICLE_A],
  );
  assert.deepEqual(
    selectedArticleIds({ publications: [publication()], versions: [version()], ...eligibility() }),
    [],
    "a legacy version without a current classification must not be eligible",
  );
  assert.deepEqual(
    selectedArticleIds({
      publications: [publication()],
      versions: [version()],
      ...eligibility({
        legacyFreshnessClassifications: [{ version_id: VERSION_A, freshness: "stale" }],
      }),
    }),
    [],
    "a stale classification must not be eligible",
  );
  assert.deepEqual(
    selectedArticleIds({
      publications: [publication()],
      versions: [version()],
      ...eligibility({
        legacyFreshnessClassifications: current,
        catalogPublications: [{ id: "cccccccc-0000-0000-0000-0000000000c1", article_id: ARTICLE_A, state: "published", source_anchor_version_id: VERSION_A }],
      }),
    }),
    [],
    "a legacy version superseded by a published catalog publication must not be eligible",
  );
});

test("gate2 enrichment_full eligibility requires the matching anchor id and source hash", () => {
  const anchor = version({
    id: VERSION_ANCHOR,
    version_role: "authoritative_source",
    source_anchor_version_id: VERSION_ANCHOR,
    source_content_hash: HASH_A,
  });
  const enrichment = version({
    version_role: "enrichment_full",
    source_anchor_version_id: VERSION_ANCHOR,
    enrichment_source_content_hash: HASH_A,
  });
  const catalog: SearchCatalogPublicationV1Row[] = [
    { id: "cccccccc-0000-0000-0000-0000000000c1", article_id: ARTICLE_A, state: "published", source_anchor_version_id: VERSION_ANCHOR },
  ];

  assert.deepEqual(
    selectedArticleIds({
      publications: [publication()],
      versions: [enrichment, anchor],
      ...eligibility({ catalogPublications: catalog }),
    }),
    [ARTICLE_A],
  );

  const staleHash = version({
    id: VERSION_B,
    article_id: ARTICLE_B,
    version_role: "enrichment_full",
    source_anchor_version_id: VERSION_ANCHOR,
    enrichment_source_content_hash: HASH_B,
  });
  assert.deepEqual(
    selectedArticleIds({
      publications: [publication({ id: PUB_B, article_id: ARTICLE_B, version_id: VERSION_B })],
      versions: [staleHash, anchor],
      ...eligibility({
        catalogPublications: [
          { id: "cccccccc-0000-0000-0000-0000000000c2", article_id: ARTICLE_B, state: "published", source_anchor_version_id: VERSION_ANCHOR },
        ],
      }),
    }),
    [],
    "an anchor hash mismatch must fail closed",
  );

  assert.deepEqual(
    selectedArticleIds({
      publications: [publication()],
      versions: [enrichment],
      ...eligibility({ catalogPublications: catalog }),
    }),
    [],
    "a missing anchor version must fail closed",
  );

  assert.deepEqual(
    selectedArticleIds({
      publications: [publication()],
      versions: [
        version({ version_role: "authoritative_source", source_anchor_version_id: VERSION_A, source_content_hash: HASH_A }),
        anchor,
      ],
      ...eligibility({ catalogPublications: catalog }),
    }),
    [],
    "authoritative_source rows are not part of public_article_projection_p3",
  );
});

test("gate2 eligibility rejects an ambiguous published catalog publication and wires through the builder", () => {
  assert.throws(
    () =>
      selectPublishedSearchProjectionSources({
        publications: [publication()],
        versions: [version()],
        ...eligibility({
          legacyFreshnessClassifications: [{ version_id: VERSION_A, freshness: "current" }],
          catalogPublications: [
            { id: "cccccccc-0000-0000-0000-0000000000c1", article_id: ARTICLE_A, state: "published", source_anchor_version_id: VERSION_A },
            { id: "cccccccc-0000-0000-0000-0000000000c2", article_id: ARTICLE_A, state: "published", source_anchor_version_id: VERSION_A },
          ],
        }),
      }),
    (error: unknown) =>
      error instanceof SearchProjectionError && error.code === "duplicate_published_catalog_publication",
  );

  const built = buildSearchProjection({
    publications: [publication()],
    versions: [version()],
    ...eligibility(),
  });
  assert.deepEqual(built.documents, [], "the builder must honor gate2 eligibility");
});

test("semantic provenance audit SQL selects counts only and never a vector, text, URL or id", () => {
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /count\(\*\)/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /public\.article_publications_p3/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /public\.article_embedding_artifacts/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /public\.public_article_projection_p3 where embedding is null/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /e\.provider = 'gemini'/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /e\.model = 'gemini-embedding-001'/u);
  assert.match(SEMANTIC_PROVENANCE_AUDIT_SQL, /e\.dimensions = 1536/u);
  assert.doesNotMatch(SEMANTIC_PROVENANCE_AUDIT_SQL, /select \*/iu);
  assert.doesNotMatch(SEMANTIC_PROVENANCE_AUDIT_SQL, /::text/u);
  assert.doesNotMatch(SEMANTIC_PROVENANCE_AUDIT_SQL, /raw_text|cleaned_text|canonical_url/u);
  assert.doesNotMatch(SEMANTIC_PROVENANCE_AUDIT_SQL, /embedding::/u);
});

test("semantic provenance audit parser reports counts only and fails closed on malformed input", () => {
  const row: Record<string, unknown> = {
    current_published_rows: 10,
    projection_rows: 9,
    projection_embedding_null_count: "4",
    artifact_backed_current_published_rows: 6,
    legacy_version_embedding_only_count: 4,
    artifact_provider_mismatch_count: 1,
    artifact_model_mismatch_count: 0,
    artifact_dimensions_mismatch_count: 2,
    artifact_content_hash_mismatch_count: 3,
    artifact_version_mismatch_count: 5,
  };
  const report = parseSemanticProvenanceAuditRow(row);
  assert.equal(report.version, 1);
  assert.equal(report.counts.projection_embedding_null_count, 4);
  assert.equal(report.totalMismatchCount, 11);
  assert.equal(JSON.stringify(report).includes("embedding\""), false, "no vector value may be present");

  assert.throws(() => parseSemanticProvenanceAuditRow({ ...row, current_published_rows: undefined }), /non-count|missing/u);
  assert.throws(() => parseSemanticProvenanceAuditRow({ ...row, current_published_rows: -1 }), /non-count/u);
  assert.throws(() => parseSemanticProvenanceAuditRow({ ...row, current_published_rows: 1.5 }), /non-count/u);
  assert.throws(() => parseSemanticProvenanceAuditRow(({ ...row, projection_rows: undefined }) as Record<string, unknown>), /non-count|missing/u);
});

test("semantic provenance audit script is read-only with no apply flag", () => {
  assert.match(auditScript, /createSupabaseLinkedQueryRunner/u);
  assert.match(auditScript, /--dry-run/u);
  assert.match(auditScript, /--apply is not available/u);
  assert.match(auditScript, /read-only by construction/u);
  assert.doesNotMatch(auditScript, /\.insert\(|\.update\(|\.delete\(|d1 execute/u);
  assert.doesNotMatch(auditScript, /fetch\(/u);
  assert.equal(packageJson.scripts["audit:semantic-provenance"], "tsx scripts/semantic-provenance-audit.ts");
});
