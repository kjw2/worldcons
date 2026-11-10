import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transitionArticlePublicationInD1 } from "../lib/cloudflare/core-write/authority";
import { consumeSearchRepair } from "../lib/cloudflare/e2e/search-repair-consumer";
import { spainDateCorrectionEvidenceSha256 } from "../lib/ingest/spain-decision-date-correction";
import {
  evidenceFromOfficialDetail,
  evidenceFromOfficialPayload,
  type SpainOfficialDateEvidence,
} from "../lib/ingest/spain-decision-date-recovery";
import { applySpainDateOnlyRepublication } from "../lib/ingest/spain-date-only-apply";
import { OFFICIAL_DATE_ONLY_POLICY } from "../lib/ingest/spain-date-only-republication";
import { persistNativeStageRecord, type NativeCrawlerBindings } from "../workers/async-pipeline/src/native-crawler";
import { SqliteD1, articleId, input, approval } from "./helpers/e2e-core-fixture";

const NOW = "2026-11-10T00:00:00.000Z";
const HJ_ID = "32151";
const OFFICIAL_URL = `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${HJ_ID}`;
const CORRECTED = "2026-10-06T00:00:00.000Z";

const HEADING = {
  heading: "SENTENCIA 67/2026, de 6 de octubre",
  ecli: "ECLI:ES:TC:2026:67",
  date: "2026-10-06",
  type: "SENTENCIA",
  number: 67,
  year: 2026,
};

function longDate(date: string) {
  const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const [year, month, day] = date.split("-");
  return `${Number(day)} de ${months[Number(month) - 1]} de ${year}`;
}

function detailHtml(boe?: { number: string; date: string }) {
  const boeSpan = boe
    ? ` <span style="display: block; font-style: italic;"> (BOE num. ${boe.number}, de ${longDate(boe.date)}) </span>`
    : "";
  return `<!DOCTYPE html><html><body><ul class="resolucion-identifiers">
    <li id="resolucion-identifier"><h2> ${HEADING.heading}${boeSpan} </h2></li>
    <li id="resolucionECLI-identifier"><p><label class="ecli">${HEADING.ecli}</label></p></li>
  </ul></body></html>`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    TIPO_RESOLUCION: HEADING.type,
    NUMERO_RESOLUCION: HEADING.number,
    ANNO_RESOLUCION: HEADING.year,
    ECLI: HEADING.ecli,
    FECHA_REGISTRO: `${HEADING.date}T00:00:00`,
    FECHA_FIRMA: longDate(HEADING.date),
    ...overrides,
  };
}

function evidence(boe?: { number: string; date: string }): SpainOfficialDateEvidence {
  return evidenceFromOfficialDetail({
    hjId: HJ_ID,
    canonicalUrl: OFFICIAL_URL,
    html: detailHtml(boe),
    payload: payload(boe ? { FECHA_BOE: `${boe.date}T00:00:00` } : {}),
  });
}

function spainArticle(db: SqliteD1) {
  db.db.prepare(`UPDATE articles SET source_key='es-tribunal-constitucional',jurisdiction='Spain',
    institution_name='Tribunal Constitucional',original_url=?,canonical_url=?,original_title='SENTENCIA 67/2026',
    original_published_at=NULL,source_metadata=? WHERE id=?`).run(
    OFFICIAL_URL,
    OFFICIAL_URL,
    JSON.stringify({
      hjId: HJ_ID,
      caseNumber: "67/2026",
      collection: { strategy: "api", confidence: 1, publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false },
    }),
    articleId,
  );
}

function loadProtection(db: SqliteD1) {
  for (const file of ["0008_e2e_core_writer_guards.sql", "0009_e2e_source_ownership.sql"]) {
    db.db.exec(readFileSync(new URL(`../d1/worldcons_core/${file}`, import.meta.url), "utf8"));
  }
}

async function publishManaged(db: SqliteD1) {
  spainArticle(db);
  const result = await transitionArticlePublicationInD1(db, input(db, "spain-publish", { e2eApproval: approval }));
  assert.equal(result.ok, true, JSON.stringify(result));
  loadProtection(db);
  db.db.exec("UPDATE e2e_source_policies_v1 SET required=1");
  return result.data;
}

async function publishLegacy(db: SqliteD1) {
  spainArticle(db);
  const result = await transitionArticlePublicationInD1(db, input(db, "spain-legacy", { e2eApproval: undefined }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function simulateCoreOnlyRefresh(db: SqliteD1) {
  db.db.prepare("UPDATE articles SET original_published_at=?,updated_at=?,fetched_at=? WHERE id=?")
    .run(CORRECTED, NOW, NOW, articleId);
}

async function applyWithPlan(
  input: Omit<Parameters<typeof applySpainDateOnlyRepublication>[0], "apply" | "confirmPlanHash">,
) {
  const dryRun = await applySpainDateOnlyRepublication({ ...input, apply: false });
  assert.equal(dryRun.status, "planned", JSON.stringify(dryRun));
  if (dryRun.status !== "planned") return dryRun;
  return applySpainDateOnlyRepublication({ ...input, apply: true, confirmPlanHash: dryRun.planHash });
}

test("same-content native refresh updates Core only and leaves the published P3 version undated", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());
  const published = await publishLegacy(db);
  assert.equal(db.rows("article_content_versions_p3").length, 1);
  const text = "Official Spanish Constitutional Court decision 67/2026. ".repeat(60);
  const nativeHash = createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
  db.db.prepare("UPDATE articles SET cleaned_text=?,content_hash=?,original_published_at=NULL WHERE id=?")
    .run(text, nativeHash, articleId);
  const bindings = {
    WORLDCONS_CORE: db,
    WORLDCONS_RAW: { async put() {} },
  } as unknown as NativeCrawlerBindings;
  const result = await persistNativeStageRecord(
    {
      sourceKey: "es-tribunal-constitucional",
      url: OFFICIAL_URL,
      title: "SENTENCIA 67/2026",
      contentType: "decision",
      publishedAt: CORRECTED,
      metadata: { hjId: HJ_ID, collection: { publishable: true, sourceUrlVerified: true, sourceTextAvailable: true, strictSourceTextAvailable: true } },
    },
    text,
    bindings,
    { runId: "fixture:same-content", fetchedAt: NOW },
  );
  assert.equal(result.outcome, "unchanged");
  const article = db.rows("articles")[0];
  assert.equal(article.original_published_at, CORRECTED, "the crawler refreshes Core only");
  const version = db.rows("article_content_versions_p3")[0];
  assert.equal(version.original_published_at, null, "the immutable published version is unchanged");
  assert.equal(db.rows("article_publications_p3")[0].version_id, published.versionId);
});

test("managed P3 date repair creates a new immutable version, replays idempotently and refreshes Search", async (t) => {
  const core = new SqliteD1();
  const search = new SqliteD1("search");
  t.after(() => { core.close(); search.close(); });
  const published = await publishManaged(core);
  simulateCoreOnlyRefresh(core);
  const oldVersion = core.rows("article_content_versions_p3")[0];
  const oldPublication = core.rows("article_publications_p3")[0];

  const applied = await applyWithPlan({
    core,
    articleId,
    actorId: "operator:spain-date-canary",
    correlationId: "corr-spain-date-1",
    evidence: evidence(),
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  if (applied.status !== "applied") return;

  assert.equal(core.rows("article_content_versions_p3").length, 2, "a new immutable version is inserted");
  const versions = core.rows("article_content_versions_p3");
  const previous = versions.find((row) => row.id === published.versionId)!;
  const corrected = versions.find((row) => row.id === applied.versionId)!;
  assert.equal(previous.original_published_at, null, "the old version is preserved");
  assert.equal(previous.content_hash, oldVersion.content_hash);
  assert.equal(corrected.original_published_at, CORRECTED);
  assert.equal(corrected.parent_version_id, published.versionId);
  assert.equal(corrected.cleaned_text, oldVersion.cleaned_text);
  assert.equal(core.rows("articles")[0].original_published_at, CORRECTED);

  const publication = core.rows("article_publications_p3")[0];
  assert.equal(publication.version_id, applied.versionId);
  assert.equal(Number(publication.revision), Number(oldPublication.revision) + 1);
  assert.equal(core.rows("article_version_heads_p3")[0].current_version_id, applied.versionId);
  assert.equal(core.rows("article_revision_heads_v4")[0].current_version_id, applied.versionId);
  assert.equal(core.rows("legacy_version_freshness_classifications_v4").filter((row) => row.version_id === applied.versionId).length, 1);

  const proof = core.rows("e2e_approval_evidence_v1").find((row) => row.policy_version === OFFICIAL_DATE_ONLY_POLICY)!;
  assert.ok(proof, "the narrow date-only approval receipt is recorded");
  const document = JSON.parse(String(proof.evidence_document));
  assert.equal(document.schema, "worldcons.official-date-only-approval.v1");
  assert.equal(document.correctedOriginalPublishedAt, CORRECTED);
  assert.equal(document.previousVersionId, published.versionId);
  assert.equal(document.authorizationBasis, "managed_generation");
  assert.equal(document.checks.dateOnlyChange, true);
  assert.equal(core.rows("e2e_generations_v1").length, 2, "the E2E generation ledger advances");
  assert.equal(core.rows("e2e_generation_heads_v1")[0].generation_id, applied.generationId);

  const replayed = await applySpainDateOnlyRepublication({
    core,
    articleId,
    actorId: "operator:spain-date-canary",
    correlationId: "corr-spain-date-1",
    apply: true,
    evidence: evidence(),
  });
  assert.equal(replayed.status, "already_corrected");
  assert.equal(core.rows("article_content_versions_p3").length, 2, "replay never creates another version");
  assert.equal(core.rows("article_publications_p3")[0].revision, publication.revision);
  assert.equal(core.rows("e2e_search_repair_outbox_v1").length, 2, "only the original repair outbox remains");

  const message = { schemaVersion: 1 as const, type: "e2e-search-repair" as const, outboxId: applied.searchRepairOutboxId! };
  assert.equal((await consumeSearchRepair(core, search, message)).status, "awaiting_verification");
  const projected = search.rows("search_documents").find((row) => row.article_id === articleId)!;
  assert.equal(projected.original_published_at, CORRECTED, "Search receives the corrected official date");
  assert.equal(core.rows("e2e_search_repair_outbox_v1").filter((row) => row.status === "pending").length, 1);
});

test("official heading mismatch, JSON-only evidence and reversed BOE dates are rejected without writes", async (t) => {
  const cases: Array<{ name: string; supplied: SpainOfficialDateEvidence; code: string }> = [
    {
      name: "wrong heading number",
      supplied: evidenceFromOfficialDetail({
        hjId: HJ_ID,
        canonicalUrl: OFFICIAL_URL,
        html: detailHtml().replace("SENTENCIA 67/2026", "SENTENCIA 66/2026"),
        payload: payload({ NUMERO_RESOLUCION: 66 }),
      }),
      code: "official_identity_mismatch",
    },
    {
      name: "JSON-only listing date",
      supplied: evidenceFromOfficialPayload(HJ_ID, OFFICIAL_URL, payload()),
      code: "official_heading_unavailable",
    },
    {
      name: "reversed BOE listing",
      supplied: evidenceFromOfficialDetail({
        hjId: HJ_ID,
        canonicalUrl: OFFICIAL_URL,
        html: detailHtml({ number: "269", date: "2026-09-01" }),
        payload: payload({ FECHA_BOE: "2026-09-01T00:00:00" }),
      }),
      code: "official_date_mismatch",
    },
  ];
  for (const item of cases) {
    const core = new SqliteD1();
    t.after(() => core.close());
    await publishManaged(core);
    simulateCoreOnlyRefresh(core);
    const before = {
      versions: core.rows("article_content_versions_p3"),
      publication: core.rows("article_publications_p3"),
      generations: core.rows("e2e_generations_v1"),
      evidence: core.rows("e2e_approval_evidence_v1"),
    };
    const result = await applySpainDateOnlyRepublication({
      core,
      articleId,
      actorId: "operator:spain-date-canary",
      correlationId: `corr-${item.name}`,
      apply: true,
      evidence: item.supplied,
    });
    assert.equal(result.status, "rejected", item.name);
    if (result.status === "rejected") assert.equal(result.code, item.code, item.name);
    assert.deepEqual(core.rows("article_content_versions_p3"), before.versions, item.name);
    assert.deepEqual(core.rows("article_publications_p3"), before.publication, item.name);
    assert.deepEqual(core.rows("e2e_generations_v1"), before.generations, item.name);
    assert.deepEqual(core.rows("e2e_approval_evidence_v1"), before.evidence, item.name);
  }
});

test("protected approval failures leave Core and Search ledgers intact", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publishManaged(core);
  simulateCoreOnlyRefresh(core);
  core.db.exec("UPDATE e2e_generations_v1 SET expected_version_id='not-the-published-version'");
  const before = {
    versions: core.rows("article_content_versions_p3"),
    publication: core.rows("article_publications_p3"),
    generations: core.rows("e2e_generations_v1"),
    outbox: core.rows("e2e_search_repair_outbox_v1"),
    evidence: core.rows("e2e_approval_evidence_v1"),
  };
  const rejected = await applyWithPlan({
    core,
    articleId,
    actorId: "operator:spain-date-canary",
    correlationId: "corr-stale-owner",
    evidence: evidence(),
  });
  assert.equal(rejected.status, "failed");
  assert.deepEqual(core.rows("article_content_versions_p3"), before.versions);
  assert.deepEqual(core.rows("article_publications_p3"), before.publication);
  assert.deepEqual(core.rows("e2e_generations_v1"), before.generations);
  assert.deepEqual(core.rows("e2e_search_repair_outbox_v1"), before.outbox);
  assert.deepEqual(core.rows("e2e_approval_evidence_v1"), before.evidence);

  const rollbackCore = new SqliteD1();
  t.after(() => rollbackCore.close());
  await publishManaged(rollbackCore);
  simulateCoreOnlyRefresh(rollbackCore);
  const snapshot = {
    versions: rollbackCore.rows("article_content_versions_p3"),
    publication: rollbackCore.rows("article_publications_p3"),
    evidence: rollbackCore.rows("e2e_approval_evidence_v1"),
  };
  rollbackCore.failAtEnd = true;
  const failed = await applyWithPlan({
    core: rollbackCore,
    articleId,
    actorId: "operator:spain-date-canary",
    correlationId: "corr-batch-rollback",
    evidence: evidence(),
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(rollbackCore.rows("article_content_versions_p3"), snapshot.versions, "the failed batch leaves no version");
  assert.deepEqual(rollbackCore.rows("article_publications_p3"), snapshot.publication);
  assert.deepEqual(rollbackCore.rows("e2e_approval_evidence_v1"), snapshot.evidence, "the approval receipt is rolled back with the batch");
});

test("legacy published rows require an exact operator receipt and still produce a new immutable version", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  const published = await publishLegacy(core);
  simulateCoreOnlyRefresh(core);
  const official = evidence();
  const evidenceSha256 = await spainDateCorrectionEvidenceSha256(official);

  const dryRun = await applySpainDateOnlyRepublication({
    core,
    articleId,
    actorId: "operator:legacy-canary",
    correlationId: "corr-legacy-plan",
    apply: false,
    evidence: official,
  });
  assert.equal(dryRun.status, "planned");
  if (dryRun.status === "planned") {
    assert.equal(dryRun.authorizationBasis, "operator_authorization");
    assert.equal(dryRun.authorizationRequired, true);
    assert.equal(dryRun.operatorAuthorization?.evidenceSha256, evidenceSha256);
  }

  const missing = await applySpainDateOnlyRepublication({
    core,
    articleId,
    actorId: "operator:legacy-canary",
    correlationId: "corr-legacy-missing",
    apply: true,
    evidence: official,
  });
  assert.equal(missing.status, "approval_required");
  assert.equal(core.rows("article_content_versions_p3").length, 1);

  const wrong = await applySpainDateOnlyRepublication({
    core,
    articleId,
    actorId: "operator:legacy-canary",
    correlationId: "corr-legacy-wrong",
    apply: true,
    evidence: official,
    operatorAuthorization: {
      actorId: "operator:legacy-canary",
      approvedAt: NOW,
      articleId,
      currentVersionId: published.versionId,
      correctedOriginalPublishedAt: CORRECTED,
      evidenceSha256: "0".repeat(64),
    },
  });
  assert.equal(wrong.status, "rejected");
  assert.equal(core.rows("article_content_versions_p3").length, 1);

  const applied = await applyWithPlan({
    core,
    articleId,
    actorId: "operator:legacy-canary",
    correlationId: "corr-legacy-exact",
    evidence: official,
    operatorAuthorization: {
      actorId: "operator:legacy-canary",
      approvedAt: NOW,
      articleId,
      currentVersionId: published.versionId,
      correctedOriginalPublishedAt: CORRECTED,
      evidenceSha256,
      correlationId: "corr-legacy-exact",
    },
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(core.rows("article_content_versions_p3").length, 2);
  const proof = core.rows("e2e_approval_evidence_v1").find((row) => row.policy_version === OFFICIAL_DATE_ONLY_POLICY)!;
  const document = JSON.parse(String(proof.evidence_document));
  assert.equal(document.authorizationBasis, "operator_authorization");
  assert.equal(document.operatorActorId, "operator:legacy-canary");
  assert.equal(document.checks.operatorAuthorized, true);
});
