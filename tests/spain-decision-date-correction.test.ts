import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildSearchProjectionDocument } from "../lib/cloudflare/search-projection/documents";
import {
  buildSpainDateCorrectionPlan,
  buildSpainDateCorrectionStatements,
  renderSpainDateCorrectionSql,
  SPAIN_DATE_CORRECTION_POLICY,
  spainDateCorrectionEvidenceSha256,
  type SpainDateCorrectionAuthorization,
  type SpainDateCorrectionRow,
} from "../lib/ingest/spain-decision-date-correction";
import {
  evidenceFromOfficialPayload,
  type SpainOfficialDateEvidence,
} from "../lib/ingest/spain-decision-date-recovery";
import { latestSourceArchiveDate } from "../lib/seo/source-detail-pagination";
import { SPAIN_DATE_CORRECTION_READ_SQL } from "../scripts/correct-spain-decision-dates";

const NOW = "2026-11-07T00:00:00.000Z";

function versionRow(overrides: Partial<SpainDateCorrectionRow> & { article_id: string; hjId: string; number: number; year: number }): SpainDateCorrectionRow {
  const { article_id, hjId, number, year } = overrides;
  const canonicalUrl = `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${hjId}`;
  const row: SpainDateCorrectionRow = {
    article_id,
    article_source_key: "es-tribunal-constitucional",
    canonical_url: canonicalUrl,
    article_original_published_at: null,
    article_updated_at: "2026-11-01T00:00:00.000Z",
    article_content_hash: `core-hash-${number}`,
    publication_id: `publication-${number}`,
    publication_state: "published",
    publication_revision: 3,
    publication_version_id: `version-${number}`,
    version_id: `version-${number}`,
    version_revision: 2,
    version_content_hash: `version-hash-${number}`,
    version_original_published_at: null,
    version_created_at: "2026-10-20T00:00:00.000Z",
    version_slug: `sentencia-${number}-${year}`,
    version_source_key: "es-tribunal-constitucional",
    version_jurisdiction: "Spain",
    version_institution_name: "Tribunal Constitucional",
    version_content_type: "decision",
    version_original_url: canonicalUrl,
    version_canonical_url: canonicalUrl,
    version_original_language: "es",
    version_original_title: `SENTENCIA ${number}/${year}`,
    version_korean_title: `?ㅽ럹???뚮쾿?ы뙋??${year}??${number}???먭껐`,
    version_discovered_at: "2026-10-18T00:00:00.000Z",
    version_fetched_at: "2026-10-19T00:00:00.000Z",
    version_summarized_at: "2026-10-20T00:00:00.000Z",
    version_cleaned_text: `Official Spanish Constitutional Court decision ${number}/${year}. `.repeat(60),
    version_summary_json: JSON.stringify({ summary: { coreSummary: [`SENTENCIA ${number}/${year}`] } }),
    version_source_metadata: JSON.stringify({
      hjId,
      collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true },
    }),
    version_error_metadata: "{}",
    version_case_key: `${number}${year}`,
    p3_head_version_id: `version-${number}`,
    p3_head_revision: 2,
    v4_head_version_id: `version-${number}`,
    v4_head_revision: 2,
    has_generation: 0,
    source_policy_required: 0,
    audit_ledger_revision: 4,
    audit_entry_hash: `audit-hash-${number}`,
  };
  return { ...row, ...overrides };
}

const PAYLOADS: Record<string, Record<string, unknown>> = {
  "32150": { TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 65, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "2026-10-05T00:00:00" },
  "32151": { TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 66, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "2026-10-06", FECHA_FIRMA: "de 6 de octubre de 2026" },
  "32152": { TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 67, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "19/10/2026 0:00:00" },
};

function evidenceFor(hjId: string, canonicalUrl: string): SpainOfficialDateEvidence {
  const payload = PAYLOADS[hjId];
  if (!payload) return { hjId, canonicalUrl, fetched: false, ok: false, reason: "Official HJ JSON is unavailable.", checks: [], warnings: [] };
  return evidenceFromOfficialPayload(hjId, canonicalUrl, payload);
}

async function authorizationFor(plan: Awaited<ReturnType<typeof buildSpainDateCorrectionPlan>>, actorId = "operator:date-correction"): Promise<SpainDateCorrectionAuthorization> {
  const entries = [];
  for (const row of plan.rows) {
    if (row.status !== "repairable" || !row.newVersion || !row.evidenceSha256) continue;
    entries.push({
      articleId: row.articleId,
      currentVersionId: row.guard.versionId,
      correctedOriginalPublishedAt: row.correctedOriginalPublishedAt!,
      evidenceSha256: row.evidenceSha256,
    });
  }
  return {
    policyVersion: SPAIN_DATE_CORRECTION_POLICY,
    actorId,
    approvedAt: NOW,
    entries,
  };
}

test("verified FECHA_REGISTRO creates SENTENCIA 65-67/2026 immutable correction plans, never using createdAt", async () => {
  const rows = [
    versionRow({ article_id: "es-65", hjId: "32150", number: 65, year: 2026 }),
    versionRow({ article_id: "es-66", hjId: "32151", number: 66, year: 2026 }),
    versionRow({ article_id: "es-67", hjId: "32152", number: 67, year: 2026 }),
  ];
  const fetched: string[] = [];
  const dryRun = await buildSpainDateCorrectionPlan({
    rows,
    now: NOW,
    maxOfficialFetches: 10,
    fetchEvidence: async (hjId, canonicalUrl) => {
      fetched.push(hjId);
      return evidenceFor(hjId, canonicalUrl);
    },
  });

  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.writes, 0);
  assert.equal(dryRun.applySupported, true);
  assert.equal(dryRun.applyReady, false, "an unauthorized plan is never apply-ready");
  assert.equal(dryRun.summary.total, 3);
  assert.equal(dryRun.summary.repairable, 3);
  assert.equal(dryRun.summary.authorized, 0);
  assert.deepEqual(fetched.sort(), ["32150", "32151", "32152"]);
  assert.deepEqual(
    dryRun.rows.map((row) => row.correctedOriginalPublishedAt),
    ["2026-10-05T00:00:00.000Z", "2026-10-06T00:00:00.000Z", "2026-10-19T00:00:00.000Z"],
  );
  for (const row of dryRun.rows) {
    assert.equal(row.status, "repairable");
    assert.equal(row.action, "create_version_and_republish");
    assert.equal(row.coreUpdateRequired, true);
    assert.equal(row.newVersion?.parentVersionId, row.guard.versionId);
    assert.notEqual(row.newVersion?.versionId, row.guard.versionId, "correction must create a new immutable version");
    assert.notEqual(row.correctedOriginalPublishedAt, row.newVersion?.versionId);
    assert.notEqual(row.correctedOriginalPublishedAt, undefined);
    assert.doesNotMatch(String(row.correctedOriginalPublishedAt), /2026-10-20|2026-11-01/u,
      "createdAt/updatedAt must never become the court decision date");
    assert.equal(row.rollback?.previousVersionId, row.guard.versionId);
    assert.equal(row.rollback?.neverDelete, true);
    assert.equal(row.evidence?.checks[0].source, "FECHA_REGISTRO");
  }

  const replay = await buildSpainDateCorrectionPlan({
    rows,
    now: NOW,
    maxOfficialFetches: 10,
    fetchEvidence: async (hjId, canonicalUrl) => evidenceFor(hjId, canonicalUrl),
  });
  assert.equal(replay.planHash, dryRun.planHash, "the same official evidence must produce the same plan");
  assert.deepEqual(
    replay.rows.map((row) => row.newVersion?.versionId),
    dryRun.rows.map((row) => row.newVersion?.versionId),
    "version ids are deterministic for idempotent resume",
  );

  const authorization = await authorizationFor(dryRun);
  const authorized = await buildSpainDateCorrectionPlan({
    rows,
    now: NOW,
    maxOfficialFetches: 10,
    authorization,
    fetchEvidence: async (hjId, canonicalUrl) => evidenceFor(hjId, canonicalUrl),
  });
  assert.equal(authorized.applyReady, true);
  assert.equal(authorized.summary.authorized, 3);
  assert.ok(authorized.rows.every((row) => row.authorizationSatisfied));

  const statements = await buildSpainDateCorrectionStatements(authorized.rows[0], {
    actorId: authorization.actorId,
    now: NOW,
  });
  const sql = statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /UPDATE articles SET original_published_at=/);
  assert.match(sql, /INSERT OR IGNORE INTO article_content_versions_p3/);
  assert.doesNotMatch(sql, /UPDATE article_content_versions_p3/u, "immutable P3 versions must never be updated in place");
  assert.doesNotMatch(sql, /DELETE FROM article_content_versions_p3/u);
  assert.match(sql, /FROM article_content_versions_p3\s+WHERE id=\? AND article_id=\? AND original_published_at IS NULL/u);
  assert.match(sql, /UPDATE article_publications_p3 SET version_id=/);
  assert.match(sql, /state='published' AND version_id=\? AND CAST\(revision AS INTEGER\)=CAST\(\? AS INTEGER\)/);
  assert.match(sql, /INSERT OR IGNORE INTO legacy_version_freshness_classifications_v4/);
  assert.match(sql, /article_publication_history_p3/);
  assert.match(sql, /INSERT OR IGNORE INTO article_cache_outbox_p3/);
  assert.match(sql, /article_audit_ledger_p3/);
  assert.match(sql, /INSERT OR IGNORE INTO article_publication_requests_p3/);
  assert.ok(statements.some((statement) => statement.id === "publications.update"));
  assert.equal(
    authorized.rows[0].idempotencyKey,
    `${SPAIN_DATE_CORRECTION_POLICY}:es-65:version-65:2026-10-05`,
    "the request ledger key is stable for resume",
  );

  const rendered = renderSpainDateCorrectionSql(statements);
  assert.match(rendered, /'2026-10-05T00:00:00\.000Z'/);
  assert.doesNotMatch(rendered, /\?/u, "the operator SQL file must be fully literalized");
  assert.match(rendered, /'worldcons\.spain-fecha-registro-correction\.v1'/);
});

test("correction fails closed for invalid, missing, conflicting, protected, and non-published rows", async () => {
  const rows: SpainDateCorrectionRow[] = [
    versionRow({ article_id: "already", hjId: "32200", number: 70, year: 2026, version_original_published_at: "2026-10-05T00:00:00.000Z" }),
    versionRow({ article_id: "missing", hjId: "32153", number: 71, year: 2026 }),
    versionRow({ article_id: "invalid", hjId: "32154", number: 72, year: 2026 }),
    versionRow({ article_id: "mismatch", hjId: "32155", number: 73, year: 2026 }),
    versionRow({ article_id: "conflict", hjId: "32150", number: 74, year: 2026, article_original_published_at: "2026-07-21T00:00:00.000Z" }),
    versionRow({ article_id: "protected", hjId: "32151", number: 75, year: 2026, has_generation: 1 }),
    versionRow({ article_id: "unpublished", hjId: "32152", number: 76, year: 2026, publication_state: "withdrawn" }),
    versionRow({
      article_id: "identity", hjId: "32150", number: 77, year: 2026,
      version_source_metadata: JSON.stringify({ hjId: "99999", collection: { publishable: true } }),
    }),
    versionRow({
      article_id: "nonofficial", hjId: "32156", number: 78, year: 2026,
      canonical_url: "https://evil.example/HJ/es/Resolucion/Show/32156",
      version_canonical_url: "https://evil.example/HJ/es/Resolucion/Show/32156",
      version_original_url: "https://evil.example/HJ/es/Resolucion/Show/32156",
    }),
  ];
  const fetched: string[] = [];
  const plan = await buildSpainDateCorrectionPlan({
    rows,
    now: NOW,
    maxOfficialFetches: 20,
    fetchEvidence: async (hjId, canonicalUrl) => {
      fetched.push(hjId);
      if (hjId === "32153") return evidenceFromOfficialPayload(hjId, canonicalUrl, { TIPO_RESOLUCION: "SENTENCIA" });
      if (hjId === "32154") return evidenceFromOfficialPayload(hjId, canonicalUrl, { FECHA_REGISTRO: "31/02/2026 0:00:00" });
      if (hjId === "32155") return evidenceFromOfficialPayload(hjId, canonicalUrl, { FECHA_REGISTRO: "2026-10-05T00:00:00", FECHA_FIRMA: "de 6 de octubre de 2026" });
      return evidenceFor(hjId, canonicalUrl);
    },
  });
  const status = Object.fromEntries(plan.rows.map((row) => [row.articleId, row.status]));
  assert.equal(status.already, "already_corrected");
  assert.equal(status.missing, "source_date_missing");
  assert.equal(status.invalid, "source_date_invalid");
  assert.equal(status.mismatch, "source_date_invalid");
  assert.equal(status.conflict, "conflict");
  assert.equal(status.protected, "approval_required");
  assert.equal(status.unpublished, "not_published");
  assert.equal(status.identity, "conflict");
  assert.equal(status.nonofficial, "hj_id_missing");
  assert.equal(plan.summary.repairable, 0);
  assert.equal(plan.applyReady, false);
  assert.ok(!fetched.includes("32200"), "already dated rows never trigger an official fetch");
  assert.ok(!fetched.includes("32152"), "non-published rows are rejected before official fetch");
  assert.ok(!fetched.includes("99999"), "metadata cannot redirect the official fetch away from the canonical HJ id");
  assert.ok(!fetched.includes("32156"), "non-official canonical URLs are rejected before fetch");
  assert.ok(plan.rows.every((row) => row.action === "none"));
});

test("evidence hash and authorization are bound to the exact article, version and corrected date", async () => {
  const row = versionRow({ article_id: "es-65", hjId: "32150", number: 65, year: 2026 });
  const evidence = evidenceFor("32150", row.canonical_url!);
  const evidenceHash = await spainDateCorrectionEvidenceSha256(evidence);
  assert.match(evidenceHash, /^[0-9a-f]{64}$/u);

  const staleAuthorization: SpainDateCorrectionAuthorization = {
    policyVersion: SPAIN_DATE_CORRECTION_POLICY,
    actorId: "operator:one",
    approvedAt: NOW,
    entries: [{ articleId: "es-65", currentVersionId: "version-65", correctedOriginalPublishedAt: "2026-10-05T00:00:00.000Z", evidenceSha256: "0".repeat(64) }],
  };
  const stale = await buildSpainDateCorrectionPlan({
    rows: [row], now: NOW, authorization: staleAuthorization,
    fetchEvidence: async (hjId, canonicalUrl) => evidenceFor(hjId, canonicalUrl),
  });
  assert.equal(stale.rows[0].status, "repairable");
  assert.equal(stale.rows[0].authorizationSatisfied, false);
  assert.equal(stale.applyReady, false);

  const exactAuthorization: SpainDateCorrectionAuthorization = {
    ...staleAuthorization,
    entries: [{ articleId: "es-65", currentVersionId: "version-65", correctedOriginalPublishedAt: "2026-10-05T00:00:00.000Z", evidenceSha256: evidenceHash }],
  };
  const exact = await buildSpainDateCorrectionPlan({
    rows: [row], now: NOW, authorization: exactAuthorization,
    fetchEvidence: async (hjId, canonicalUrl) => evidenceFor(hjId, canonicalUrl),
  });
  assert.equal(exact.rows[0].authorizationSatisfied, true);
  assert.equal(exact.applyReady, true);
});

test("corrected decision date reaches search documents without leaking createdAt as the court date", () => {
  const document = buildSearchProjectionDocument({
    publication: {
      id: "publication-65",
      article_id: "es-65",
      state: "published",
      version_id: "corrected-version-65",
      revision: 4,
      published_at: "2026-11-07T00:00:00.000Z",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-11-07T00:00:00.000Z",
    },
    version: {
      id: "corrected-version-65",
      article_id: "es-65",
      revision: 3,
      slug: "sentencia-65-2026",
      source_key: "es-tribunal-constitucional",
      jurisdiction: "Spain",
      institution_name: "Tribunal Constitucional",
      content_type: "decision",
      original_language: "es",
      original_title: "SENTENCIA 65/2026",
      korean_title: "?ㅽ럹???뚮쾿?ы뙋??2026??65???먭껐",
      original_published_at: "2026-10-05T00:00:00.000Z",
      cleaned_text: "Official decision text.",
      summary_json: {},
      source_metadata: {},
      created_at: "2026-10-20T00:00:00.000Z",
      fetched_at: "2026-10-19T00:00:00.000Z",
      summarized_at: "2026-10-20T00:00:00.000Z",
    },
    reviewState: null,
    tags: [],
  });
  assert.equal(document.original_published_at, "2026-10-05T00:00:00.000Z");
  assert.notEqual(document.original_published_at, "2026-10-20T00:00:00.000Z");
  assert.equal(document.updated_at, "2026-11-07T00:00:00.000Z");
});

test("source archive summary scans the page for the newest decision date and ignores createdAt", () => {
  const latest = latestSourceArchiveDate([
    { originalPublishedAt: null, summarizedAt: "2026-11-05T00:00:00.000Z" },
    { originalPublishedAt: "2026-10-05T00:00:00.000Z", summarizedAt: "2026-10-20T00:00:00.000Z" },
    { originalPublishedAt: "2026-10-19T00:00:00.000Z", summarizedAt: null },
  ]);
  assert.equal(latest, "2026-10-19T00:00:00.000Z");
  assert.equal(
    latestSourceArchiveDate([
      { originalPublishedAt: null, summarizedAt: null, createdAt: "2026-11-07T00:00:00.000Z" } as never,
    ]),
    null,
    "createdAt is never a source archive decision date",
  );
  assert.equal(latestSourceArchiveDate([]), null);
});

test("the correction read query is source-scoped, read-only, and includes published P3 evidence", () => {
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /^SELECT\s/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /a\.source_key='es-tribunal-constitucional'/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /p\.state='published'/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /JOIN article_content_versions_p3 v ON v\.id=p\.version_id/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /version_original_published_at/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /has_generation/u);
  assert.match(SPAIN_DATE_CORRECTION_READ_SQL, /source_policy_required/u);
  assert.doesNotMatch(SPAIN_DATE_CORRECTION_READ_SQL, /\b(?:UPDATE|INSERT|DELETE|DROP|ALTER)\b/iu);
});
test("the literal/parameter SQL applies as an atomic, resumable batch without mutating the old immutable version", async () => {
  const row = versionRow({ article_id: "es-65", hjId: "32150", number: 65, year: 2026 });
  const evidence = evidenceFor("32150", row.canonical_url!);
  const evidenceHash = await spainDateCorrectionEvidenceSha256(evidence);
  const authorization: SpainDateCorrectionAuthorization = {
    policyVersion: SPAIN_DATE_CORRECTION_POLICY,
    actorId: "operator:sqlite",
    approvedAt: NOW,
    entries: [{
      articleId: "es-65",
      currentVersionId: "version-65",
      correctedOriginalPublishedAt: "2026-10-05T00:00:00.000Z",
      evidenceSha256: evidenceHash,
    }],
  };
  const plan = await buildSpainDateCorrectionPlan({
    rows: [row], now: NOW, authorization,
    fetchEvidence: async (hjId, canonicalUrl) => evidenceFor(hjId, canonicalUrl),
  });
  assert.equal(plan.applyReady, true);
  const statements = await buildSpainDateCorrectionStatements(plan.rows[0], { actorId: authorization.actorId, now: NOW });

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE articles (id TEXT PRIMARY KEY, canonical_url TEXT, original_published_at TEXT, updated_at TEXT, content_hash TEXT);
    CREATE TABLE article_content_versions_p3 (id TEXT PRIMARY KEY, article_id TEXT NOT NULL, revision TEXT NOT NULL, parent_version_id TEXT,
      content_hash TEXT NOT NULL, provenance_actor_type TEXT, provenance_actor_id TEXT, model_ref TEXT, prompt_ref TEXT, slug TEXT, source_key TEXT,
      jurisdiction TEXT, institution_name TEXT, content_type TEXT, original_url TEXT, canonical_url TEXT, original_language TEXT, original_title TEXT,
      korean_title TEXT, original_published_at TEXT, discovered_at TEXT, fetched_at TEXT, summarized_at TEXT, cleaned_text TEXT, summary_json TEXT,
      source_metadata TEXT, error_metadata TEXT, created_at TEXT, case_key TEXT, version_document_schema TEXT, version_role TEXT,
      case_metadata_snapshot TEXT, case_identifiers_snapshot TEXT, authority_evidence_hash TEXT, source_snapshot_id TEXT, source_snapshot_hash TEXT,
      source_content_hash TEXT, source_anchor_version_id TEXT, enrichment_source_content_hash TEXT, raw_text_storage_ref TEXT, raw_text_blob_hash TEXT,
      raw_text_blob_size TEXT, raw_text_externalized_at TEXT, raw_text_blob_contract_version TEXT, UNIQUE(article_id, content_hash), UNIQUE(article_id, revision));
    CREATE TABLE article_publications_p3 (id TEXT PRIMARY KEY, article_id TEXT UNIQUE, state TEXT, version_id TEXT, revision TEXT,
      decided_by_type TEXT, decided_by_id TEXT, reason TEXT, published_at TEXT, withdrawn_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE article_version_heads_p3 (article_id TEXT PRIMARY KEY, current_version_id TEXT, current_revision TEXT, updated_at TEXT);
    CREATE TABLE article_revision_heads_v4 (article_id TEXT PRIMARY KEY, current_version_id TEXT, current_revision TEXT, updated_at TEXT);
    CREATE TABLE legacy_version_freshness_classifications_v4 (version_id TEXT PRIMARY KEY, article_id TEXT, freshness TEXT, freshness_basis TEXT,
      source_anchor_version_id TEXT, source_content_hash TEXT, evidence TEXT, classified_at TEXT, classified_by TEXT);
    CREATE TABLE article_publication_history_p3 (id TEXT PRIMARY KEY, publication_id TEXT, article_id TEXT, publication_revision TEXT,
      from_state TEXT, to_state TEXT, from_version_id TEXT, to_version_id TEXT, idempotency_key TEXT, actor_type TEXT, actor_id TEXT, reason TEXT,
      request_id TEXT, correlation_id TEXT, occurred_at TEXT, UNIQUE(article_id, idempotency_key));
    CREATE TABLE article_cache_outbox_p3 (id TEXT PRIMARY KEY, event_key TEXT UNIQUE, event_type TEXT, article_id TEXT, publication_id TEXT,
      publication_revision TEXT, version_id TEXT, publication_state TEXT, article_slug TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER,
      available_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(publication_id, publication_revision));
    CREATE TABLE article_audit_ledger_p3 (id TEXT PRIMARY KEY, article_id TEXT, ledger_revision TEXT, event_type TEXT, article_version_id TEXT,
      publication_id TEXT, publication_revision TEXT, actor_type TEXT, actor_id TEXT, reason TEXT, request_id TEXT, correlation_id TEXT,
      safe_metadata TEXT, previous_entry_hash TEXT, entry_hash TEXT UNIQUE, occurred_at TEXT, UNIQUE(article_id, ledger_revision));
    CREATE TABLE article_publication_requests_p3 (id TEXT PRIMARY KEY, article_id TEXT, idempotency_key TEXT, publication_id TEXT,
      publication_revision TEXT, version_id TEXT, version_revision TEXT, state TEXT, version_created INTEGER, publication_applied INTEGER,
      created_at TEXT, UNIQUE(article_id, idempotency_key));
  `);
  sqlite.prepare("INSERT INTO articles (id,canonical_url,original_published_at,updated_at,content_hash) VALUES (?,?,?,?,?)")
    .run(row.article_id, row.canonical_url!, null, row.article_updated_at!, row.article_content_hash!);
  sqlite.prepare(`INSERT INTO article_content_versions_p3 (id,article_id,revision,parent_version_id,content_hash,provenance_actor_type,
    provenance_actor_id,model_ref,prompt_ref,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,
    original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,cleaned_text,summary_json,source_metadata,error_metadata,
    created_at,case_key,version_document_schema,version_role,case_metadata_snapshot,case_identifiers_snapshot,authority_evidence_hash,source_snapshot_id,
    source_snapshot_hash,source_content_hash,source_anchor_version_id,enrichment_source_content_hash,raw_text_storage_ref,raw_text_blob_hash,
    raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.version_id!, row.article_id, row.version_revision as number, null, row.version_content_hash!, "llm", "gemini", null, null,
    row.version_slug!, row.version_source_key!, row.version_jurisdiction!, row.version_institution_name!, row.version_content_type!,
    row.version_original_url!, row.version_canonical_url!, row.version_original_language!, row.version_original_title!, row.version_korean_title!,
    null, row.version_discovered_at!, row.version_fetched_at!, row.version_summarized_at!, row.version_cleaned_text!, row.version_summary_json!,
    row.version_source_metadata!, row.version_error_metadata!, row.version_created_at!, row.version_case_key!, "p3.article.v1", null, null, null,
    null, null, null, null, null, null, null, null, null, null, null,
  );
  sqlite.prepare("INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,decided_by_id,reason,published_at,withdrawn_at,created_at,updated_at) VALUES (?,?, 'published',?,?,'compatibility',NULL,'initial',?,NULL,?,?)")
    .run(row.publication_id!, row.article_id, row.version_id!, String(row.publication_revision ?? 3), row.version_created_at!, row.version_created_at!, row.version_created_at!);
  sqlite.prepare("INSERT INTO article_version_heads_p3 VALUES (?,?,?,?)").run(row.article_id, row.version_id!, String(row.version_revision), row.version_created_at!);
  sqlite.prepare("INSERT INTO article_revision_heads_v4 VALUES (?,?,?,?)").run(row.article_id, row.version_id!, String(row.version_revision), row.version_created_at!);

  for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.params);

  const newVersion = plan.rows[0].newVersion!;
  const oldRow = sqlite.prepare("SELECT original_published_at,content_hash FROM article_content_versions_p3 WHERE id=?").get(row.version_id!) as Record<string, unknown>;
  assert.equal(oldRow.original_published_at, null, "the old immutable version is never updated");
  assert.equal(oldRow.content_hash, row.version_content_hash);
  const correctedRow = sqlite.prepare("SELECT original_published_at,content_hash FROM article_content_versions_p3 WHERE id=?").get(newVersion.versionId) as Record<string, unknown>;
  assert.equal(correctedRow.original_published_at, "2026-10-05T00:00:00.000Z");
  assert.equal(correctedRow.content_hash, newVersion.contentHash);
  const article = sqlite.prepare("SELECT original_published_at FROM articles WHERE id=?").get(row.article_id) as Record<string, unknown>;
  assert.equal(article.original_published_at, "2026-10-05T00:00:00.000Z");
  const head = sqlite.prepare("SELECT current_version_id,current_revision FROM article_version_heads_p3 WHERE article_id=?").get(row.article_id) as Record<string, unknown>;
  assert.equal(head.current_version_id, newVersion.versionId, "head must move before publication");
  const publication = sqlite.prepare("SELECT version_id,revision FROM article_publications_p3 WHERE article_id=?").get(row.article_id) as Record<string, unknown>;
  assert.equal(publication.version_id, newVersion.versionId);
  assert.equal(publication.revision, "4");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM legacy_version_freshness_classifications_v4 WHERE version_id=?").get(newVersion.versionId) as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_publication_history_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_cache_outbox_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_publication_requests_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_audit_ledger_p3").get() as { count: number }).count, 2);

  for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.params);
  const replayPublication = sqlite.prepare("SELECT version_id,revision FROM article_publications_p3 WHERE article_id=?").get(row.article_id) as Record<string, unknown>;
  assert.deepEqual({ ...replayPublication }, { version_id: newVersion.versionId, revision: "4" }, "a resume replay is idempotent");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_content_versions_p3").get() as { count: number }).count, 2);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_publication_history_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_cache_outbox_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_publication_requests_p3").get() as { count: number }).count, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM article_audit_ledger_p3").get() as { count: number }).count, 2);
  sqlite.close();
});
