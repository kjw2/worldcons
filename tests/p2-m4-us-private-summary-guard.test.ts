import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SqliteD1 } from "./helpers/e2e-core-fixture";
import { validSummary } from "./helpers/e2e-m4-summary";
import { runD1AdminReviewAction } from "../lib/admin/d1-review";
import { readHumanReviewSnapshot } from "../lib/cloudflare/e2e/manual-approval";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../lib/cloudflare/d1/runtime-binding";
import { canSummarizeArticle } from "../lib/ingest/publishability";
import { runD1SummarizeArticle } from "../lib/cloudflare/summary/d1-summary-drain";

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
