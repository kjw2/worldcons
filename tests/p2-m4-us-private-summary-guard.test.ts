import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SqliteD1 } from "./helpers/e2e-core-fixture";
import { validSummary } from "./helpers/e2e-m4-summary";
import { runD1AdminReviewAction } from "../lib/admin/d1-review";
import { readHumanReviewSnapshot } from "../lib/cloudflare/e2e/manual-approval";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../lib/cloudflare/d1/runtime-binding";
import { canSummarizeArticle } from "../lib/ingest/publishability";
import { runD1SummarizeArticle } from "../lib/cloudflare/summary/d1-summary-drain";
import { parseOperatorCanaryEvent } from "../lib/cloudflare/ingest-stages/canary-workflow-payload";
import { runD1PrivateUsSummary, type UsPrivateSummaryRawBucket } from "../lib/cloudflare/summary/us-private-summary";

const US_URL = "https://www.supremecourt.gov/opinions/26pdf/26a476_k537.pdf";
const US_ID = "d8dc4ebc-7193-4a2d-8bcf-21e9cbbe4127";
const US_SHA = "7883149526371c5543f77a310dfcfead3834a7247654b02190abd5eec6ecaa94";

function core(): SqliteD1 {
  const db = new SqliteD1();
  for (const file of ["0008_e2e_core_writer_guards.sql", "0009_e2e_source_ownership.sql"]) {
    db.db.exec(readFileSync(new URL(`../d1/worldcons_core/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

/**
 * Seeds the genuine new Production US SCOTUS 2026-term case `26A476
 * FCC v. Brown` exactly as the M8 collector persisted it:
 *
 *   - `status='metadata_only'`
 *   - `review_state='needs_triage'`
 *   - `summary_json=NULL`, `korean_title` absent
 *   - `translation_status='not_required'`
 *   - `cleaned_text` present (7979 chars), verified official PDF provenance
 *   - `collection.publishable=false`, `review.required=true`
 *     (`scotus_pdf_human_review_required`)
 *   - verified R2 original PDF + SHA-256
 *   - NO human approval ledger row
 */
function seedNewUsCase(db: SqliteD1) {
  const metadata = {
    officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${US_SHA}.pdf`, sha256: US_SHA, docketVerified: true },
    collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "official-pdf" },
    review: { required: true, reason: "scotus_pdf_human_review_required" },
  };
  db.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,discovered_at,fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(US_ID, "us-scotus", "United States", "Supreme Court of the United States", "opinion",
      US_URL, US_URL, "en", "FCC v. Brown", null,
      "2026-10-14T21:00:00Z", "2026-10-14T21:00:25Z", null,
      "metadata_only", "us-26a476", "official opinion text ".repeat(400), null,
      JSON.stringify(metadata), "2026-10-14T21:00:00Z", "2026-10-14T21:00:25Z",
      "metadata_only", "not_ready", "needs_review", "active", "not_required", "needs_triage");
}

function articleRow(db: SqliteD1) {
  return db.rows("articles").find((row) => (row as { id: string }).id === US_ID) as Record<string, unknown>;
}

test("genuine new US 26A476 (metadata_only, summary_json NULL, publishable=false, review.required=true, no ledger) cannot be published or made public-eligible by any unreviewed admin action", async (t) => {
  const db = core();
  t.after(() => { db.close(); setRuntimeD1Bindings({}); });
  setRuntimeD1Bindings({ worldcons_core: db as unknown as D1RuntimeDatabase });
  seedNewUsCase(db);

  const before = articleRow(db);
  assert.equal(before.status, "metadata_only");
  assert.equal(before.summary_json, null);
  assert.equal(before.review_state, "needs_triage");
  const beforeMetadata = JSON.parse(String(before.source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(beforeMetadata.collection.publishable, false);
  assert.equal(beforeMetadata.review.required, true);

  // (1) `publish-reviewed` with a real operator identity and the exact preview
  //     hash is STILL refused, because there is no summary. This is the exact
  //     blocker: a genuine metadata_only US case cannot be human-published until
  //     a valid summary/title exists.
  const preview = await readHumanReviewSnapshot(db, { articleId: US_ID });
  const publishAttempt = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "no summary yet", provider: undefined, model: undefined, expectedApprovalSnapshotHash: preview.identity.approvalSnapshotHash },
    "reviewer:human",
  );
  assert.equal(publishAttempt.status, "skipped", "publish-reviewed without a summary is an honest skip, never a publication");

  // (2) The pre-summary `approve-and-summarize` bypass is CLOSED: for a protected
  //     source (US is ALWAYS protected) it refuses and writes NOTHING. It must not
  //     flip `collection.publishable` to true, must not clear `review.required`,
  //     and must not queue a summary for an unreviewed hold.
  const approveAttempt = await runD1AdminReviewAction(
    { action: "approve-and-summarize", articleId: US_ID, slug: undefined, note: "bypass attempt", provider: undefined, model: undefined, expectedApprovalSnapshotHash: undefined },
    "reviewer:human",
  );
  assert.equal(approveAttempt.status, "skipped", "approve-and-summarize on a protected private hold must be refused");

  const after = articleRow(db);
  const afterMetadata = JSON.parse(String(after.source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(after.status, "metadata_only", "the row status is untouched");
  assert.equal(after.summary_json, null, "no summary is fabricated");
  assert.equal(after.review_state, "needs_triage", "the private review state is retained");
  assert.equal(afterMetadata.collection.publishable, false, "publishable is NEVER flipped by an unreviewed action");
  assert.equal(afterMetadata.review.required, true, "the private review hold is retained");

  // No public artifact and no human approval evidence was created anywhere.
  assert.equal(db.rows("article_publications_p3").length, 0, "no P3 publication");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0, "no human approval receipt");
});

test("exact blocker: a genuine metadata_only US 26A476 cannot be privately summarized to a human-reviewable summary through any existing automatic path without changing publishable=false / review.required=true", async (t) => {
  const db = core();
  t.after(() => { db.close(); setRuntimeD1Bindings({}); });
  setRuntimeD1Bindings({ worldcons_core: db as unknown as D1RuntimeDatabase });
  seedNewUsCase(db);

  const row = articleRow(db);
  // (a) The shared summary eligibility predicate requires
  //     `collection.publishable === true`. A US private hold is false, so the
  //     row is never a summary candidate.
  assert.equal(
    canSummarizeArticle({ status: String(row.status), cleaned_text: String(row.cleaned_text), source_metadata: row.source_metadata }),
    false,
    "a US metadata_only private-hold row is not summarizable by the existing eligibility gate",
  );

  // (b) The real per-article summarizer therefore SKIPS it (no provider call, no
  //     summary written). This is the exact blocker: there is no private-hold
  //     summary path.
  const summarize = await runD1SummarizeArticle({ articleId: US_ID, apiKeys: ["test-key"] });
  assert.equal((summarize.result as { status?: string }).status, "skipped");
  assert.equal(articleRow(db).summary_json, null, "no summary is produced for a private-hold US row");

  // (c) The only branch that could flip `publishable` before a summary is
  //     `approve-and-summarize`; it is now fail-closed for protected sources, so
  //     the row remains unsummarizable and unpublishable. The blocker is REAL,
  //     not merely documented.
  const approveAttempt = await runD1AdminReviewAction(
    { action: "approve-and-summarize", articleId: US_ID, slug: undefined, note: "attempt", provider: undefined, model: undefined, expectedApprovalSnapshotHash: undefined },
    "reviewer:human",
  );
  assert.equal(approveAttempt.status, "skipped");
  const metadata = JSON.parse(String(articleRow(db).source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(metadata.collection.publishable, false);
  assert.equal(metadata.review.required, true);
  assert.equal(articleRow(db).status, "metadata_only");
  assert.equal(db.rows("article_publications_p3").length, 0);
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0);
});

test("even a hypothetical privately-produced US summary (publishable=false retained) cannot be published without an exact snapshot-bound human preview, and a real human preview then publishes through the protected path", async (t) => {
  const db = core();
  t.after(() => { db.close(); setRuntimeD1Bindings({}); });
  setRuntimeD1Bindings({ worldcons_core: db as unknown as D1RuntimeDatabase });
  seedNewUsCase(db);

  // Model the *only* legitimate private transform the controller explicitly
  // permits: a schema-valid Korean summary that leaves the private hold intact
  // (`publishable=false`, `review.required=true`). This proves the hold is what
  // gates publication, not the summary's existence.
  db.db.prepare("UPDATE articles SET status='summarized',summarized_at=?,summary_json=?,korean_title=?,translation_status='translated',translated_at=?,review_state='needs_review',lifecycle_collection_state='source_text_ready',lifecycle_processing_state='complete',lifecycle_review_state='unreviewed',lifecycle_attention_state='clear' WHERE id=?")
    .run("2026-10-14T22:00:00Z", JSON.stringify(validSummary), validSummary.koreanTitle, "2026-10-14T22:00:00Z", US_ID);
  const privateRow = articleRow(db);
  const privateMetadata = JSON.parse(String(privateRow.source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(privateMetadata.collection.publishable, false, "private summarization never flips publishable");
  assert.equal(privateMetadata.review.required, true, "private summarization retains the review hold");
  assert.equal(db.rows("article_publications_p3").length, 0, "private summarization never publishes");

  // A stale/nonexistent preview hash is refused and writes nothing.
  const stale = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "stale", provider: undefined, model: undefined, expectedApprovalSnapshotHash: "0".repeat(64) },
    "reviewer:human",
  ).then(() => null, (error: unknown) => error);
  assert.ok(stale instanceof Error, "a stale preview must be refused");
  assert.equal(db.rows("article_publications_p3").length, 0);
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0);

  // The real human flow: exact current preview hash + session identity publishes
  // through the protected path and records exactly one immutable receipt.
  const preview = await readHumanReviewSnapshot(db, { articleId: US_ID });
  const result = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "Reviewed exact official SCOTUS PDF and Korean summary.", provider: undefined, model: undefined, expectedApprovalSnapshotHash: preview.identity.approvalSnapshotHash },
    "reviewer:human",
  );
  assert.equal(result.status, "published");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 1, "exactly one human receipt");
  assert.equal((db.rows("article_publications_p3")[0] as { state: string }).state, "published");
  const publishedMetadata = JSON.parse(String(articleRow(db).source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(publishedMetadata.collection.publishable, true);
  assert.equal(publishedMetadata.review.required, false, "review.required is cleared ONLY in the authenticated human publish path");
});

test("static guard: the approve-and-summarize branch consults protectedSourceRequired before it may touch publishable", () => {
  const source = readFileSync(new URL("../lib/admin/d1-review.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf('if(input.action==="approve-and-summarize")'), source.indexOf('if(input.action==="publish-reviewed")'));
  assert.ok(branch.length > 0, "the approve-and-summarize branch exists");
  assert.match(branch, /protectedSourceRequired/, "the pre-summary branch must fail closed for protected sources before any publishable write");
  const guardIndex = branch.indexOf("protectedSourceRequired");
  const publishableIndex = branch.indexOf("publishable:true");
  assert.ok(guardIndex >= 0 && (publishableIndex === -1 || guardIndex < publishableIndex), "the protected-source guard precedes any publishable write");
});

const R2_BUCKET_OK: UsPrivateSummaryRawBucket = {
  async head() { return { size: 128 }; },
};

/** A variety of stubbed SummaryJson values; production uses the real Gemini provider. */
function stubSummary(overrides: Record<string, unknown> = {}) {
  return { ...validSummary, ...overrides } as never;
}

function privateSummarySetup(t: { after(fn: () => void): void }) {
  const db = core();
  t.after(() => { db.close(); setRuntimeD1Bindings({}); });
  setRuntimeD1Bindings({ worldcons_core: db as unknown as D1RuntimeDatabase });
  seedNewUsCase(db);
  return db;
}

test("prepare-us-private-summary-one envelope is us-scotus-only, UUID-validated, and carries no candidate/prompt/dispatch/approval field", () => {
  const ok = parseOperatorCanaryEvent({ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.value : null, {
    payloadKind: "prepare-us-private-summary-one", mode: "prepare-us-private-summary-one",
    sourceKey: "us-scotus", articleId: US_ID, operatorId: "cloudflare-workflow-operator",
  });
  const rejections: Array<[unknown, RegExp]> = [
    [{ mode: "prepare-us-private-summary-one", sourceKey: "de-bverfg", articleId: US_ID }, /prepare_us_private_summary_source_not_allowed/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: "not-a-uuid" }, /prepare_us_private_summary_article_id_invalid/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus" }, /prepare_us_private_summary_article_id_invalid/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, candidateUrl: US_URL }, /unknown_key:candidateUrl/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, docket: "26A476" }, /unknown_key:docket/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, prompt: "summarize this" }, /unknown_key:prompt/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, dispatch: true }, /unknown_key:dispatch/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, approve: true }, /unknown_key:approve/],
    [{ mode: "prepare-us-private-summary-one", sourceKey: "us-scotus", articleId: US_ID, rangeDays: 30 }, /unknown_key:rangeDays/],
  ];
  for (const [payload, pattern] of rejections) {
    const result = parseOperatorCanaryEvent(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }
});

test("private US summary success: a genuine new case is privately summarized with a real SummarySchema + Korean title, preserving the hold, with no P3/Search/receipt", async (t) => {
  const db = privateSummarySetup(t);
  let providerCalls = 0;
  const result = await runD1PrivateUsSummary({
    articleId: US_ID,
    apiKeys: ["test-key"],
    rawBucket: R2_BUCKET_OK,
    summarize: async () => { providerCalls += 1; return stubSummary() as never; },
  });
  assert.equal(result.status, "summarized", JSON.stringify(result));
  assert.equal(providerCalls, 1, "exactly one provider call");
  assert.equal(result.publicationUntouched, true);
  assert.equal(result.searchUntouched, true);
  assert.equal(result.reviewHoldPreserved, true);

  const row = articleRow(db);
  assert.equal(row.status, "summarized");
  assert.notEqual(row.summary_json, null, "summary_json is persisted");
  const parsed = JSON.parse(String(row.summary_json)) as { koreanTitle: string };
  assert.equal(parsed.koreanTitle, validSummary.koreanTitle);
  assert.equal(row.korean_title, validSummary.koreanTitle, "korean_title is persisted");
  assert.match(String(row.korean_title), /[가-힣]/, "the Korean title carries Hangul");
  assert.equal(row.translation_status, "translated");
  assert.equal(row.review_state, "needs_review", "review_state remains needs_review");

  // The private hold is preserved by the write.
  const metadata = JSON.parse(String(row.source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(metadata.collection.publishable, false, "publishable is NEVER flipped by private summarization");
  assert.equal(metadata.review.required, true, "review.required is NEVER cleared by private summarization");

  // No public artifact, Search staging, or human receipt was created.
  assert.equal(db.rows("article_publications_p3").length, 0, "no P3 publication");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0, "no human approval receipt");
  assert.equal(db.rows("article_cache_outbox_p3").length, 0, "no public cache outbox event");
  assert.equal(db.rows("case_catalog_publications_v1").length, 0, "no Case Catalog publication");

  // Lifecycle is human-reviewable while review.required still gates publication.
  const lifecycle = row as { lifecycle_collection_state: string; lifecycle_processing_state: string; lifecycle_review_state: string };
  assert.equal(lifecycle.lifecycle_collection_state, "source_text_ready");
  assert.equal(lifecycle.lifecycle_processing_state, "complete");
  assert.equal(lifecycle.lifecycle_review_state, "needs_review", "lifecycle review axis remains needs_review");
});

test("private US summary: an exact snapshot human preview is now possible, but private processing alone never publishes or records a receipt", async (t) => {
  const db = privateSummarySetup(t);
  await runD1PrivateUsSummary({
    articleId: US_ID,
    apiKeys: ["test-key"],
    rawBucket: R2_BUCKET_OK,
    summarize: async () => stubSummary() as never,
  });

  // The private summary makes the exact preview computable (a summary exists and
  // has a Korean title), so a human can now review it. But private processing
  // itself must never publish or record a receipt.
  const preview = await readHumanReviewSnapshot(db, { articleId: US_ID });
  assert.equal(preview.identity.approvalSnapshotHash.length, 64, "an exact review snapshot can be computed");

  // A stale/nonexistent preview hash is refused and writes nothing. (The real
  // human path requires the exact hash AND operator identity; it is not reachable
  // from private processing.)
  const stale = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "stale", provider: undefined, model: undefined, expectedApprovalSnapshotHash: "0".repeat(64) },
    "reviewer:human",
  ).then(() => null, (error: unknown) => error);
  assert.ok(stale instanceof Error, "a stale preview is refused");
  assert.equal(db.rows("article_publications_p3").length, 0, "no P3 publication");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0, "no human receipt");
  const metadata = JSON.parse(String(articleRow(db).source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(metadata.collection.publishable, false);
  assert.equal(metadata.review.required, true);
});

test("private US summary is idempotent: a repeated call is a no-op with no second provider call and no extra write", async (t) => {
  const db = privateSummarySetup(t);
  let providerCalls = 0;
  const first = await runD1PrivateUsSummary({
    articleId: US_ID, apiKeys: ["test-key"], rawBucket: R2_BUCKET_OK,
    summarize: async () => { providerCalls += 1; return stubSummary() as never; },
  });
  assert.equal(first.status, "summarized");
  const afterFirst = JSON.stringify(articleRow(db));
  const second = await runD1PrivateUsSummary({
    articleId: US_ID, apiKeys: ["test-key"], rawBucket: R2_BUCKET_OK,
    summarize: async () => { providerCalls += 1; return stubSummary({ koreanTitle: "다른 제목" }) as never; },
  });
  assert.equal(second.status, "already_summarized", "a repeated call converges to the durable private summary");
  assert.equal(providerCalls, 1, "the second call performs no provider work");
  assert.equal(JSON.stringify(articleRow(db)), afterFirst, "the second call writes nothing new");
  assert.equal(db.rows("article_publications_p3").length, 0);
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0);
});

test("private US summary stale CAS: a concurrent change between read and claim is refused with no provider call or overwrite", async (t) => {
  const db = privateSummarySetup(t);
  // Mutate the row's updated_at after the module reads it by intercepting the
  // claim UPDATE's first execution via a wrapping binding.
  const base = db as unknown as D1RuntimeDatabase;
  let mutateBeforeClaim = true;
  const wrapped: D1RuntimeDatabase = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      if (sql.includes("SET status='summarizing'") && mutateBeforeClaim) {
        mutateBeforeClaim = false;
        db.db.prepare("UPDATE articles SET updated_at=? WHERE id=?").run("2026-10-15T23:59:59.000Z", US_ID);
      }
      return statement;
    },
    batch: base.batch ? base.batch.bind(base) : undefined,
  };
  setRuntimeD1Bindings({ worldcons_core: wrapped });
  let providerCalls = 0;
  await assert.rejects(
    runD1PrivateUsSummary({
      articleId: US_ID, apiKeys: ["test-key"], rawBucket: R2_BUCKET_OK,
      summarize: async () => { providerCalls += 1; return stubSummary() as never; },
    }),
    /us_private_summary\.claim_cas_conflict/,
  );
  assert.equal(providerCalls, 0, "a stale CAS must never launch a provider call");
  assert.equal(articleRow(db).summary_json, null, "no summary is written on a stale CAS");
  assert.equal(articleRow(db).status, "metadata_only", "the private hold status is untouched");
});

test("private US summary fails closed on bad source, wrong status/hold, missing provenance/R2, existing P3 or receipt, and no creds", async (t) => {
  const db = privateSummarySetup(t);
  let providers = 0;
  const summarize = async () => { providers += 1; return stubSummary() as never; };

  // Bad article id.
  assert.equal((await runD1PrivateUsSummary({ articleId: "not-a-uuid", apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // Unknown article.
  assert.equal((await runD1PrivateUsSummary({ articleId: "00000000-0000-4000-8000-000000000000", apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // No creds.
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: [], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  assert.equal(providers, 0);

  // Source mismatch: re-point the source key.
  db.db.prepare("UPDATE articles SET source_key='de-bverfg' WHERE id=?").run(US_ID);
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  db.db.prepare("UPDATE articles SET source_key='us-scotus' WHERE id=?").run(US_ID);

  // Released hold (publishable=true) must fail closed.
  db.db.prepare("UPDATE articles SET source_metadata=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(String(articleRow(db).source_metadata)), collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" } }), US_ID);
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // Restore the private hold.
  seedReset(db);

  // Missing official PDF provenance.
  const noPdf = JSON.parse(String(articleRow(db).source_metadata));
  delete (noPdf as { officialPdf?: unknown }).officialPdf;
  db.db.prepare("UPDATE articles SET source_metadata=? WHERE id=?").run(JSON.stringify(noPdf), US_ID);
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // Forged non-official host.
  db.db.prepare("UPDATE articles SET source_metadata=? WHERE id=?").run(JSON.stringify({ ...noPdf, officialPdf: { url: "https://evil.example/x.pdf", r2Key: `artifacts/scotus_pdf/${US_SHA}.pdf`, sha256: US_SHA, docketVerified: true } }), US_ID);
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // R2 key/sha mismatch.
  seedReset(db);
  db.db.prepare("UPDATE articles SET source_metadata=? WHERE id=?").run(JSON.stringify({ officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${"a".repeat(64)}.pdf`, sha256: US_SHA, docketVerified: true }, collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" }, review: { required: true } }), US_ID);
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  // R2 object missing with a real bucket probe.
  seedReset(db);
  const missingBucket: UsPrivateSummaryRawBucket = { async head() { return null; } };
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: missingBucket, summarize })).status, "blocked");
  assert.equal(providers, 0, "no provider call for any fail-closed precondition");

  // Pre-existing P3 publication.
  seedReset(db);
  db.db.prepare("INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("pub-x", US_ID, "published", "v", 1, "human", "legacy", "now", "now");
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  db.db.prepare("DELETE FROM article_publications_p3").run();

  // Pre-existing human receipt.
  db.db.prepare("INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("k", US_ID, "h", "s", "worldcons.human-reviewed-publication.v1", "e", "r", "x", "c", "p", "{}", "now");
  assert.equal((await runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], rawBucket: R2_BUCKET_OK, summarize })).status, "blocked");
  assert.equal(providers, 0);
});

test("private US summary R2 provenance is strict: an absent binding, a missing/empty/oversized object, a non-PDF body, or a hash mismatch all fail closed with no provider call", async (t) => {
  const db = privateSummarySetup(t);
  let providers = 0;
  const summarize = async () => { providers += 1; return stubSummary() as never; };
  const run = (rawBucket?: UsPrivateSummaryRawBucket) =>
    runD1PrivateUsSummary({ articleId: US_ID, apiKeys: ["k"], ...(rawBucket ? { rawBucket } : {}), summarize });

  // An absent R2 binding is NOT valid provenance in Production.
  assert.equal((await run(undefined)).status, "blocked", "absent R2 binding fails closed");
  assert.equal((await run({} as UsPrivateSummaryRawBucket)).status, "blocked", "a binding with no head/get fails closed");

  // Head reports empty / oversized / missing.
  assert.equal((await run({ async head() { return { size: 0 }; } })).status, "blocked");
  assert.equal((await run({ async head() { return { size: 9 * 1024 * 1024 }; } })).status, "blocked");
  assert.equal((await run({ async head() { return null; } })).status, "blocked");

  // A get body that is not a PDF signature fails closed.
  const notPdf = new TextEncoder().encode("<html>not a pdf</html>");
  assert.equal((await run({ async get() { return { arrayBuffer: async () => notPdf.buffer as ArrayBuffer }; } })).status, "blocked");

  // A valid `%PDF-` body whose hash does not match the stored sha256 fails closed.
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
  assert.equal((await run({ async get() { return { arrayBuffer: async () => pdfBytes.buffer as ArrayBuffer }; } })).status, "blocked");

  // A valid `%PDF-` body whose hash MATCHES the stored sha256 succeeds, and no
  // provider call happens for any of the fail-closed cases above.
  assert.equal(providers, 0, "no provider call for any R2 provenance failure");
  const sha = createHash("sha256").update(pdfBytes).digest("hex");
  const metadata = JSON.parse(String(articleRow(db).source_metadata));
  metadata.officialPdf = { url: US_URL, r2Key: `artifacts/scotus_pdf/${sha}.pdf`, sha256: sha, docketVerified: true };
  db.db.prepare("UPDATE articles SET source_metadata=? WHERE id=?").run(JSON.stringify(metadata), US_ID);
  const ok = await run({ async get() { return { arrayBuffer: async () => pdfBytes.buffer as ArrayBuffer }; } });
  assert.equal(ok.status, "summarized", JSON.stringify(ok));
  assert.equal(providers, 1, "exactly one provider call once provenance is verified");
});

test("private US summary provider failure rolls the claim back to the exact private hold", async (t) => {
  const db = privateSummarySetup(t);
  const before = JSON.stringify(articleRow(db));
  const result = await runD1PrivateUsSummary({
    articleId: US_ID, apiKeys: ["test-key"], rawBucket: R2_BUCKET_OK,
    summarize: async () => { throw new Error("Gemini 500 model_error"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, true);
  const row = articleRow(db);
  assert.equal(row.status, "metadata_only", "the claim is rolled back to the private hold");
  assert.equal(row.summary_json, null, "no summary is persisted on provider failure");
  const metadata = JSON.parse(String(row.source_metadata)) as { collection: { publishable: boolean }; review: { required: boolean } };
  assert.equal(metadata.collection.publishable, false);
  assert.equal(metadata.review.required, true);
  assert.notEqual(JSON.stringify(row), before, "the failure is durably recorded (error_class/translation_status)");
  assert.equal(row.error_class, "summary.retryable_quota");
  assert.equal(db.rows("article_publications_p3").length, 0);
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0);
});

test("private US summary: a non-private (already-summarized) row with the hold intact returns already_summarized without a provider call", async (t) => {
  const db = privateSummarySetup(t);
  db.db.prepare("UPDATE articles SET status='summarized',summarized_at=?,summary_json=?,korean_title=?,translation_status='translated',review_state='needs_review' WHERE id=?")
    .run("2026-10-14T22:00:00Z", JSON.stringify(validSummary), validSummary.koreanTitle, US_ID);
  let providers = 0;
  const result = await runD1PrivateUsSummary({
    articleId: US_ID, apiKeys: ["test-key"], rawBucket: R2_BUCKET_OK,
    summarize: async () => { providers += 1; return stubSummary() as never; },
  });
  assert.equal(result.status, "already_summarized");
  assert.equal(providers, 0);
});

/** Restores the genuine new-case private hold for the target id. */
function seedReset(db: SqliteD1) {
  db.db.prepare("DELETE FROM article_publications_p3").run();
  db.db.prepare("DELETE FROM e2e_approval_evidence_v1").run();
  const metadata = {
    officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${US_SHA}.pdf`, sha256: US_SHA, docketVerified: true },
    collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "official-pdf" },
    review: { required: true, reason: "scotus_pdf_human_review_required" },
  };
  db.db.prepare("UPDATE articles SET status='metadata_only',summary_json=NULL,korean_title=NULL,translation_status='not_required',review_state='needs_triage',source_metadata=? WHERE id=?")
    .run(JSON.stringify(metadata), US_ID);
}
