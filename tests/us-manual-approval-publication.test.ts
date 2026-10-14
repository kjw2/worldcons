import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SqliteD1 } from "./helpers/e2e-core-fixture";
import { validSummary } from "./helpers/e2e-m4-summary";
import {
  HumanApprovalBlocked,
  protectedSourceRequired,
  recordHumanApproval,
  readHumanReviewSnapshot,
} from "../lib/cloudflare/e2e/manual-approval";
import { verifyHumanPreview, updateReviewedMetadata } from "../lib/admin/e2e-human-review";
import { runD1AdminReviewAction } from "../lib/admin/d1-review";
import { transitionArticlePublicationInD1 } from "../lib/cloudflare/core-write/authority";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../lib/cloudflare/d1/runtime-binding";
import { auditUsManualApprovalGuardOnce } from "../workers/async-pipeline/src/ingest-stage-handlers";
import { approvalIdentity, HUMAN_APPROVAL_POLICY } from "../lib/cloudflare/e2e/contracts";
import { approvalSourceMetadata } from "../lib/cloudflare/core-write/authority";

const US_URL = "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf";
const US_ID = "a60db8bb-4ec3-4ecf-bb5a-6245f621a334";
const US_PRIVATE_ID = "b70ec9cc-5fd4-4fd0-cc6b-7356f732b445";

function core(): SqliteD1 {
  const db = new SqliteD1();
  for (const file of ["0008_e2e_core_writer_guards.sql", "0009_e2e_source_ownership.sql"]) {
    db.db.exec(readFileSync(new URL(`../d1/worldcons_core/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

/** Inserts a US article held at the private review hold (publishable=false, review.required=true). */
function seedUs(db: SqliteD1, id: string, overrides: { metadata?: unknown; reviewState?: string; status?: string } = {}) {
  const metadata = overrides.metadata ?? {
    officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${"1".repeat(64)}.pdf`, sha256: "1".repeat(64), docketVerified: true },
    collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "official-pdf" },
    review: { required: true, reason: "scotus_pdf_human_review_required" },
  };
  db.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,discovered_at,fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "us-scotus", "United States", "Supreme Court of the United States", "opinion",
      US_URL, US_URL, "en", "Opinion of the Court", "미국 연방대법원 판결",
      "2026-10-10T00:00:00Z", "2026-10-10T01:00:00Z", "2026-10-10T02:00:00Z",
      overrides.status ?? "summarized", `us-${id.slice(0, 8)}`, "official opinion text ".repeat(60),
      JSON.stringify(validSummary), JSON.stringify(metadata), "2026-10-10T00:00:00Z", "2026-10-10T02:00:00Z",
      "source_text_ready", "complete", "unreviewed", "clear", "translated", overrides.reviewState ?? "needs_review");
}

/**
 * Applies the EXACT protected publication metadata the real `publish-reviewed`
 * branch builds (promote publishable/verified true, clear review.required) via the
 * CAS-guarded `updateReviewedMetadata`, then records the snapshot-bound human
 * receipt. Returns the approval context for the protected transition.
 */
async function approveUsProtected(db: SqliteD1, id: string, actorId: string, note?: string) {
  // Mirror the real reviewer flow: the operator submits the exact preview hash
  // they were shown. Because US is ALWAYS protected, an absent/incorrect stored
  // hash is refused by verifyHumanPreview.
  const shown = await readHumanReviewSnapshot(db, { articleId: id });
  const checked = await verifyHumanPreview(db, id, shown.identity.approvalSnapshotHash);
  const existing = JSON.parse(String(checked.article.source_metadata)) as Record<string, unknown>;
  const history = Array.isArray(existing.reviewHistory) ? (existing.reviewHistory as unknown[]) : [];
  const review = {
    decision: "published",
    note: note?.trim() || undefined,
    reviewedAt: new Date().toISOString(),
    previousStatus: String(checked.article.status ?? ""),
    snapshotHash: shown.identity.approvalSnapshotHash,
    actorId,
    // Explicitly release the private hold inside the authenticated review, and
    // preserve the append-only audit history (mirrors lib/admin/d1-review.ts).
    required: false,
  };
  const metadata = {
    ...existing,
    collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, confidence: "human_reviewed" },
    review,
    reviewHistory: [...history.slice(-19), review],
  };
  const now = new Date().toISOString();
  const expected = await updateReviewedMetadata(db, checked.article, metadata, "published", now);
  const context = await recordHumanApproval(db, { articleId: id, actorId, expectedSnapshotHash: expected, note, now });
  return { context, expected, previewHash: shown.identity.approvalSnapshotHash };
}

test("US is ALWAYS a protected source for publication; DE and unlisted sources are not", async (t) => {
  const db = core();
  t.after(() => db.close());
  seedUs(db, US_ID);
  assert.equal(await protectedSourceRequired(db, US_ID), true, "a US article is protected by source even without an FR/ES ledger row");
  // A DE article with no ledger row and no generation head is not protected.
  db.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,discovered_at,fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("de-1", "de-bverfg", "Germany", "Federal Constitutional Court", "decision",
      "https://www.bundesverfassungsgericht.de/x.html", "https://www.bundesverfassungsgericht.de/x.html", "de", "t", "결정",
      "2026-10-10T00:00:00Z", "2026-10-10T01:00:00Z", "2026-10-10T02:00:00Z", "summarized", "de-1", "de text",
      "{}", "{}", "2026-10-10T00:00:00Z", "2026-10-10T02:00:00Z",
      "source_text_ready", "complete", "unreviewed", "clear", "translated", "summarized");
  assert.equal(await protectedSourceRequired(db, "de-1"), false, "a DE article with no ledger row and no generation head is not protected");
});

test("US direct publish is rejected: an unbound protected publication without a human receipt is ineligible", async (t) => {
  const db = core();
  t.after(() => db.close());
  seedUs(db, US_ID);
  // A direct call that omits the human receipt must fail closed (ineligible),
  // never fall through to a legacy no-receipt publication.
  const result = await transitionArticlePublicationInD1(db, {
    articleId: US_ID, expectedVersionRevision: 0, expectedPublicationRevision: 0,
    idempotencyKey: "us-direct-publish", targetState: "published", captureLegacy: true,
    actorType: "human", actorId: "admin-review", reason: "direct publication bypass attempt",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ineligible");
  assert.equal(db.rows("article_publications_p3").length, 0, "no US publication without a receipt");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0);
});

test("US new needs_review hold: a stale preview hash is rejected and a valid private-to-reviewed transition publishes with a protected P3 + human receipt", async (t) => {
  const db = core();
  t.after(() => db.close());
  seedUs(db, US_ID, { reviewState: "needs_review" });

  // (1) A stale preview checksum (the pre-review hash) must be rejected.
  const before = await readHumanReviewSnapshot(db, { articleId: US_ID });
  await assert.rejects(
    verifyHumanPreview(db, US_ID, "0".repeat(64)),
    /snapshot_stale/,
    "a preview hash that does not match the exact live row must fail closed",
  );
  // While the private hold stands (publishable=false), recordHumanApproval is
  // refused and writes nothing — approval requires an explicit review promotion.
  await assert.rejects(
    recordHumanApproval(db, { articleId: US_ID, actorId: "reviewer:human", expectedSnapshotHash: before.identity.approvalSnapshotHash, note: "unpromoted", now: new Date().toISOString() }),
    (error: unknown) => error instanceof HumanApprovalBlocked,
  );
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0, "no receipt is recorded while the US private hold stands");

  // (2) Promote the private review hold via the CAS-guarded exact-row update,
  //     then record the snapshot-bound human receipt and publish through the
  //     protected path.
  const { context } = await approveUsProtected(db, US_ID, "reviewer:human", "Reviewed exact official SCOTUS PDF and Korean summary.");
  assert.equal(context.policyVersion, HUMAN_APPROVAL_POLICY);
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 1, "exactly one immutable human receipt is recorded");
  const receipt = db.rows("e2e_approval_evidence_v1")[0] as Record<string, unknown>;
  assert.equal(receipt.policy_version, HUMAN_APPROVAL_POLICY);
  const document = JSON.parse(String(receipt.evidence_document)) as Record<string, unknown>;
  assert.equal(document.schema, "worldcons.human-approval.v1");
  assert.equal(document.actorId, "reviewer:human");

  const snapshot = db.rows("article_publications_p3");
  assert.equal(snapshot.length, 0, "no publication exists before the transition");
  const result = await transitionArticlePublicationInD1(db, {
    articleId: US_ID, expectedVersionRevision: 0, expectedPublicationRevision: 0,
    idempotencyKey: "us-protected-publish", targetState: "published", captureLegacy: true,
    actorType: "human", actorId: "reviewer:human", provenanceActorType: "human", provenanceActorId: "reviewer:human",
    reason: "Reviewed exact source and summary.", e2eApproval: context,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.publicationState, "published");
  assert.equal((db.rows("article_publications_p3")[0] as { state: string }).state, "published");
  // The PDF provenance is retained and review.required was cleared conservatively.
  const updated = db.rows("articles").find((row) => (row as { id: string }).id === US_ID) as { source_metadata: string; review_state: string };
  const metadata = JSON.parse(updated.source_metadata) as {
    officialPdf: { docketVerified: boolean; sha256: string };
    collection: { publishable: boolean };
    review: { required: boolean; decision?: string; actorId?: string };
    reviewHistory?: Array<{ decision?: string; required?: boolean }>;
  };
  assert.equal(metadata.officialPdf.docketVerified, true);
  assert.equal(metadata.officialPdf.sha256, "1".repeat(64));
  assert.equal(metadata.collection.publishable, true);
  assert.equal(metadata.review.required, false, "review.required is removed conservatively after a real human approval");
  // The append-only audit history is retained and records the reviewed decision.
  assert.ok(Array.isArray(metadata.reviewHistory), "reviewHistory must be a retained array");
  assert.ok((metadata.reviewHistory?.length ?? 0) >= 1, "reviewHistory retains the approval decision");
  assert.equal(metadata.reviewHistory?.at(-1)?.decision, "published", "the last history entry records the publication decision");
});

test("US never auto-publishes on a crawler/Workflow/operatorId: an approval context with mode!=human for the human policy is invalid", async (t) => {
  const db = core();
  t.after(() => db.close());
  seedUs(db, US_ID);
  const { context } = await approveUsProtected(db, US_ID, "reviewer:human");
  // Forge the mode as automatic while keeping the human policy: the transition
  // must reject it as invalid_input rather than treat it as consent.
  const result = await transitionArticlePublicationInD1(db, {
    articleId: US_ID, expectedVersionRevision: 0, expectedPublicationRevision: 0,
    idempotencyKey: "us-forged-mode", targetState: "published", captureLegacy: true,
    actorType: "compatibility", actorId: "crawler", reason: "automatic attempt",
    e2eApproval: { ...context, mode: "automatic" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_input");
  assert.equal(db.rows("article_publications_p3").length, 0);
});

test("existing FR / ES / DE protected and non-protected flows are unaffected by the US source rule", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());
  for (const file of ["0008_e2e_core_writer_guards.sql", "0009_e2e_source_ownership.sql"]) {
    db.db.exec(readFileSync(new URL(`../d1/worldcons_core/${file}`, import.meta.url), "utf8"));
  }
  db.db.prepare("UPDATE articles SET summary_json=?,cleaned_text=?").run(JSON.stringify(validSummary), "Official French decision text. ".repeat(60));
  // The default fixture summary_json does not match SummarySchema, so replace it
  // with a schema-valid Korean summary that the human-approval gate accepts.
  db.db.prepare("UPDATE articles SET original_language='fr',translation_status='translated',korean_title='프랑스 헌법위원회 결정',review_state='unreviewed' WHERE id=?").run((db.rows("articles")[0] as { id: string }).id);
  // The default fixture is a French protected source once the ledger requires it.
  db.db.exec("UPDATE e2e_source_policies_v1 SET required=1 WHERE source_key='fr-conseil-constitutionnel'");
  const frId = db.rows("articles")[0] as { id: string };
  assert.equal(await protectedSourceRequired(db, frId.id), true, "FR protected flows still work through the ledger");

  // A US article that is later re-pointed must not affect a DE article's status.
  const de = core();
  t.after(() => de.close());
  seedUs(de, US_PRIVATE_ID);
  de.db.prepare("UPDATE articles SET source_key='de-bverfg' WHERE id=?").run(US_PRIVATE_ID);
  assert.equal(await protectedSourceRequired(de, US_PRIVATE_ID), false);

  // The existing FR/ES approval path still records a human receipt and publishes.
  const preview = await readHumanReviewSnapshot(db, { articleId: frId.id });
  const now = new Date().toISOString();
  const metadata = {
    ...JSON.parse(String((preview.article as { source_metadata: string }).source_metadata)),
    collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false },
  };
  const expected = await updateReviewedMetadata(db, preview.article, metadata, "published", now);
  const context = await recordHumanApproval(db, { articleId: frId.id, actorId: "reviewer:human", expectedSnapshotHash: expected, note: "FR review", now });
  const published = await transitionArticlePublicationInD1(db, {
    articleId: frId.id, expectedVersionRevision: 0, expectedPublicationRevision: 0,
    idempotencyKey: "fr-protected-publish", targetState: "published", captureLegacy: true,
    actorType: "human", actorId: "reviewer:human", provenanceActorType: "human", provenanceActorId: "reviewer:human",
    reason: "Reviewed exact source and summary.", e2eApproval: context,
  });
  assert.ok(published.ok, JSON.stringify(published));
  assert.equal(published.data.publicationState, "published");
});

test("US guard source verification: a non-US Core UUID cannot be audited as US, and a forged mismatch fails closed (no data)", async (t) => {
  const db = core();
  t.after(() => db.close());
  // A genuinely non-US (FR) Core row with a valid UUID.
  const frId = "c81fd0dd-6ae5-4ae1-dc7d-8467f843c556";
  db.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,discovered_at,fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(frId, "fr-conseil-constitutionnel", "FR", "Conseil constitutionnel", "decision",
      "https://www.conseil-constitutionnel.fr/decision/2026/x.htm", "https://www.conseil-constitutionnel.fr/decision/2026/x.htm",
      "fr", "Décision", "결정", "2026-10-10T00:00:00Z", "2026-10-10T01:00:00Z", "2026-10-10T02:00:00Z",
      "summarized", "fr-1", "fr text", "{}", "{}", "2026-10-10T00:00:00Z", "2026-10-10T02:00:00Z",
      "source_text_ready", "complete", "unreviewed", "clear", "translated", "summarized");

  // The read-only audit requires the exact us-scotus literal at the envelope layer.
  const wrongSource = await auditUsManualApprovalGuardOnce(db, { sourceKey: "fr-conseil-constitutionnel", articleId: frId });
  assert.equal(wrongSource.ok, false);
  assert.equal(wrongSource.blocked, true);
  assert.equal(wrongSource.code, "operator_canary.audit_us_guard_source_not_allowed");

  // Even with the `us-scotus` argument, the persisted FR row is verified and the
  // guard fails closed with a bounded source-mismatch block and NO data.
  const mismatched = await auditUsManualApprovalGuardOnce(db, { sourceKey: "us-scotus", articleId: frId });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.blocked, true);
  assert.equal(mismatched.retry, false);
  assert.equal(mismatched.receiptPresent, false);
  assert.equal(mismatched.receiptAuthenticated, false);
  assert.equal(mismatched.officialPdfProvenancePresent, false);
  assert.equal(mismatched.code, "ingest_stage.us_manual_approval_source_mismatch");
});

test("US guard source verification: forged US PDF metadata on a non-US row is rejected by the source check, not by PDF trust", async (t) => {
  const db = core();
  t.after(() => db.close());
  // A non-US (DE) row that maliciously carries US officialPdf provenance and an
  // otherwise-valid snapshot. Without the row-level source check, a forged
  // receipt could open the gate for a non-US article.
  const deId = "d92ae1ee-7bf6-4bf2-ed8e-9578f954d667";
  const forgedMetadata = {
    officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${"1".repeat(64)}.pdf`, sha256: "1".repeat(64), docketVerified: true },
    collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "official-pdf" },
    review: { required: true },
  };
  db.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,discovered_at,fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(deId, "de-bverfg", "Germany", "Bundesverfassungsgericht", "decision",
      "https://www.bundesverfassungsgericht.de/x.html", "https://www.bundesverfassungsgericht.de/x.html",
      "de", "Beschluss", "결정", "2026-10-10T00:00:00Z", "2026-10-10T01:00:00Z", "2026-10-10T02:00:00Z",
      "summarized", "de-forged", "de text", JSON.stringify(validSummary), JSON.stringify(forgedMetadata),
      "2026-10-10T00:00:00Z", "2026-10-10T02:00:00Z",
      "source_text_ready", "complete", "unreviewed", "clear", "translated", "needs_review");
  const audit = await auditUsManualApprovalGuardOnce(db, { sourceKey: "us-scotus", articleId: deId });
  assert.equal(audit.code, "ingest_stage.us_manual_approval_source_mismatch");
  assert.equal(audit.officialPdfProvenancePresent, false, "forged PDF provenance must never be reported as present for a non-US row");
  assert.equal(audit.receiptAuthenticated, false);
});

test("real authenticated US publish-reviewed flow: runD1AdminReviewAction clears review.required only in the human-approved CAS path and always records the receipt first", async (t) => {
  const db = core();
  t.after(() => { db.close(); setRuntimeD1Bindings({}); });
  setRuntimeD1Bindings({ worldcons_core: db as unknown as D1RuntimeDatabase });
  seedUs(db, US_ID, { reviewState: "needs_review" });

  // The authenticated reviewer has previewed the exact row and submits its hash.
  const preview = await readHumanReviewSnapshot(db, { articleId: US_ID });
  const previewHash = preview.identity.approvalSnapshotHash;

  // A stale/incorrect preview hash must be refused and change nothing.
  const stale = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "stale preview", provider: undefined, model: undefined, expectedApprovalSnapshotHash: "0".repeat(64) },
    "reviewer:human",
  ).then(() => null, (error: unknown) => error);
  assert.ok(stale instanceof HumanApprovalBlocked, "a stale preview hash must be refused");
  assert.equal(db.rows("e2e_approval_evidence_v1").length, 0, "no receipt on a stale preview");
  assert.equal(db.rows("article_publications_p3").length, 0, "no publication on a stale preview");

  // The real, authenticated reviewer flow: exact preview hash + session identity.
  const result = await runD1AdminReviewAction(
    { action: "publish-reviewed", articleId: US_ID, slug: undefined, note: "Reviewed exact official SCOTUS PDF and Korean summary.", provider: undefined, model: undefined, expectedApprovalSnapshotHash: previewHash },
    "reviewer:human",
  );
  assert.equal(result.action, "publish-reviewed");
  assert.equal(result.status, "published");

  // The private review hold was explicitly released inside the human-approved CAS.
  const article = db.rows("articles").find((row) => (row as { id: string }).id === US_ID) as { source_metadata: string };
  const metadata = JSON.parse(article.source_metadata) as {
    officialPdf: { docketVerified: boolean };
    collection: { publishable: boolean };
    review: { required: boolean; actorId?: string; decision?: string };
    reviewHistory?: Array<{ decision?: string; actorId?: string }>;
  };
  assert.equal(metadata.review.required, false, "the real flow clears review.required in the human-approved CAS path");
  assert.equal(metadata.review.actorId, "reviewer:human");
  assert.equal(metadata.review.decision, "published");
  assert.equal(metadata.collection.publishable, true);
  assert.equal(metadata.officialPdf.docketVerified, true, "PDF provenance is retained");
  assert.ok(Array.isArray(metadata.reviewHistory) && (metadata.reviewHistory?.length ?? 0) >= 1, "audit history is preserved");
  assert.equal(metadata.reviewHistory?.at(-1)?.actorId, "reviewer:human");

  // Exactly one immutable human receipt bound to the exact reviewed snapshot.
  // The receipt is bound to the POST-promotion row (the exact snapshot that was
  // approved and published), so recompute it from the live row and compare.
  const receipts = db.rows("e2e_approval_evidence_v1") as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].policy_version, HUMAN_APPROVAL_POLICY);
  const publishedRow = db.rows("articles").find((row) => (row as { id: string }).id === US_ID) as Record<string, unknown>;
  const liveIdentity = await approvalIdentity(US_ID, { ...publishedRow, source_metadata: approvalSourceMetadata(publishedRow.source_metadata, true) }, HUMAN_APPROVAL_POLICY);
  assert.equal(receipts[0].approval_snapshot_hash, liveIdentity.approvalSnapshotHash, "the receipt is bound to the exact reviewed/published snapshot");
  // The submitted preview hash (pre-promotion) differs from the post-promotion
  // reviewed hash, which is why the CAS-guarded promotion+receipt is mandatory.
  assert.notEqual(previewHash, liveIdentity.approvalSnapshotHash);

  // The article is published through the protected path.
  assert.equal((db.rows("article_publications_p3")[0] as { state: string }).state, "published");
});

