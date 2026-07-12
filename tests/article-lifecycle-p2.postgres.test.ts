import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool, type QueryResult } from "pg";

const databaseUrl = process.env.P2_TEST_DATABASE_URL;
const migrationSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712170000_article_lifecycle_p2.sql"), "utf8");
const indexSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712171000_article_lifecycle_p2_indexes.sql"), "utf8");
const reconciliationSql = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260712172000_article_lifecycle_p2_evidence_reconciliation.sql"),
  "utf8",
);

interface BackfillRow {
  selected_count: number;
  mapped_count: number;
  anomaly_count: number;
  unchanged_count: number;
  next_after_id: string | null;
  batch_complete: boolean;
}

async function transition(pool: Pool, articleId: string, revision: number, key: string, changes: Record<string, unknown>) {
  const source = typeof changes.source === "string" ? changes.source : "system.test";
  const actorType = changes.actorType ?? (source.startsWith("summary.")
    ? "summary_worker"
    : source.startsWith("admin.")
      ? "admin"
      : source.startsWith("ingestion.")
        ? "ingestion"
        : source.startsWith("candidate.")
          ? "candidate"
          : source.startsWith("backfill.") ? "backfill" : "system");
  return pool.query(
    `select * from article_lifecycle_transition_p2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
    )`,
    [
      articleId, revision, key, actorType, changes.actorId ?? "p2-test",
      source, changes.reasonCode ?? "test.transition",
      changes.collectionState ?? null, changes.processingState ?? null, changes.reviewState ?? null,
      changes.attentionOperation ?? "keep", changes.attentionCode ?? null, changes.attentionRetryable ?? null,
      changes.attentionSeverity ?? null, changes.attentionSource ?? null, changes.resolvesCodes ?? [],
    ],
  );
}

async function insertArticle(pool: Pool, status = "cleaned", metadata: Record<string, unknown> = { collection: { sourceTextAvailable: true, publishable: false } }) {
  const result = await pool.query<{ id: string }>(
    "insert into articles(status, source_metadata) values ($1, $2) returning id",
    [status, metadata],
  );
  return result.rows[0].id;
}

test("P2 PostgreSQL lifecycle authority and reconciliation", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const database = await client.query<{ current_database: string }>("select current_database()");
  assert.match(database.rows[0].current_database, /(?:^|_)p2(?:_|$)/i, "P2 tests refuse to reset a database whose name does not contain p2");
  await client.query("drop schema public cascade; create schema public; create extension if not exists pgcrypto");
  await client.query(`create table articles (
    id uuid primary key default gen_random_uuid(),
    status text not null,
    source_metadata jsonb,
    review_state text,
    error_class text,
    error_context jsonb,
    summary_json jsonb
  )`);
  await client.query(migrationSql);
  await client.query(migrationSql);
  for (const statement of indexSql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await client.query(statement);
    await client.query(statement);
  }
  await client.query(reconciliationSql);
  await client.query(reconciliationSql);
  await client.end();

  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await t.test("legal transitions change one axis without corrupting the others", async () => {
      const id = await insertArticle(pool);
      const initialized = await transition(pool, id, 0, "init", {
        collectionState: "source_text_ready", processingState: "ready", reviewState: "unreviewed",
      });
      assert.equal(initialized.rows[0].revision, "1");
      const running = await transition(pool, id, 1, "running", { processingState: "running", source: "summary.generate" });
      assert.deepEqual(
        [running.rows[0].collection_state, running.rows[0].processing_state, running.rows[0].review_state],
        ["source_text_ready", "running", "unreviewed"],
      );
      const review = await transition(pool, id, 2, "review", { reviewState: "needs_review", actorType: "admin", source: "admin.review" });
      assert.equal(review.rows[0].processing_state, "running");
      assert.equal(review.rows[0].review_state, "needs_review");
      await assert.rejects(
        transition(pool, id, 3, "illegal", { collectionState: "metadata_only", source: "system.test" }),
        /ARTICLE_LIFECYCLE_ILLEGAL_TRANSITION/,
      );
      await assert.rejects(
        pool.query("update articles set lifecycle_processing_state = 'complete' where id = $1", [id]),
        /ARTICLE_LIFECYCLE_DIRECT_WRITE_FORBIDDEN/,
      );
      await assert.rejects(
        transition(pool, id, 3, "actor-mismatch", {
          reviewState: "approved", actorType: "summary_worker", source: "admin.review",
        }),
        /ARTICLE_LIFECYCLE_ACTOR_SOURCE_MISMATCH/,
      );
    });

    await t.test("collection and review axes follow their own legal matrices", async () => {
      const collectionId = await insertArticle(pool, "discovered", { collection: { sourceTextAvailable: false, publishable: false } });
      await transition(pool, collectionId, 0, "collection-init", {
        collectionState: "discovered", processingState: "not_ready", reviewState: "unreviewed",
      });
      const fetched = await transition(pool, collectionId, 1, "collection-fetched", {
        collectionState: "source_fetched", actorType: "ingestion", source: "ingestion.insert",
      });
      assert.deepEqual(
        [fetched.rows[0].collection_state, fetched.rows[0].processing_state, fetched.rows[0].review_state],
        ["source_fetched", "not_ready", "unreviewed"],
      );
      const textReady = await transition(pool, collectionId, 2, "collection-ready", {
        collectionState: "source_text_ready", processingState: "ready", actorType: "ingestion", source: "ingestion.insert",
      });
      assert.equal(textReady.rows[0].attention_state, "clear");

      const reviewId = await insertArticle(pool);
      await transition(pool, reviewId, 0, "review-init", {
        collectionState: "source_text_ready", processingState: "ready", reviewState: "unreviewed",
      });
      const reviewStates = ["needs_review", "approved_for_processing", "approved", "closed_private", "needs_review"];
      let revision = 1;
      for (const reviewState of reviewStates) {
        const changed = await transition(pool, reviewId, revision, `review-${revision}`, {
          reviewState, actorType: "admin", source: "admin.review",
        });
        revision += 1;
        assert.equal(changed.rows[0].review_state, reviewState);
        assert.equal(changed.rows[0].processing_state, "ready");
      }
    });

    await t.test("stale revisions fail and concurrent idempotent replay applies once", async () => {
      const id = await insertArticle(pool);
      await transition(pool, id, 0, "init", { collectionState: "source_text_ready", processingState: "ready", reviewState: "unreviewed" });
      const [left, right] = await Promise.all([
        transition(pool, id, 1, "same-key", { processingState: "running", source: "summary.generate" }),
        transition(pool, id, 1, "same-key", { processingState: "running", source: "summary.generate" }),
      ]);
      assert.equal(Number(left.rows[0].applied) + Number(right.rows[0].applied), 1);
      assert.equal(Number(left.rows[0].idempotent) + Number(right.rows[0].idempotent), 1);
      await assert.rejects(
        transition(pool, id, 1, "stale-key", { reviewState: "needs_review", source: "admin.review" }),
        /ARTICLE_LIFECYCLE_STALE_REVISION/,
      );
    });

    await t.test("failure, retry, exact recovery, and review attention remain orthogonal", async () => {
      const id = await insertArticle(pool);
      await transition(pool, id, 0, "init", { collectionState: "source_text_ready", processingState: "ready", reviewState: "unreviewed" });
      await transition(pool, id, 1, "failed", {
        processingState: "ready", reviewState: "needs_review", source: "summary.generate",
        attentionOperation: "raise", attentionCode: "summary.retryable_quota", attentionRetryable: true,
        attentionSeverity: "high", attentionSource: "processing",
      });
      const wrongClear = await transition(pool, id, 2, "wrong-clear", {
        attentionOperation: "clear", resolvesCodes: ["crawl.timeout"], source: "summary.generate",
      });
      assert.equal(wrongClear.rows[0].attention_state, "active");
      assert.equal(wrongClear.rows[0].applied, false);
      const retry = await transition(pool, id, 2, "retry", { processingState: "running", source: "summary.generate" });
      assert.equal(retry.rows[0].attention_code, "summary.retryable_quota");
      const recovered = await transition(pool, id, 3, "recovered", {
        processingState: "complete", source: "summary.generate", attentionOperation: "clear",
        resolvesCodes: ["summary.retryable_quota"],
      });
      assert.equal(recovered.rows[0].attention_state, "clear");
      assert.equal(recovered.rows[0].review_state, "needs_review", "error recovery must not erase review attention");
    });

    await t.test("queue-style completion alone cannot change legacy public eligibility", async () => {
      const id = await insertArticle(pool, "cleaned", { collection: { sourceTextAvailable: true, publishable: false } });
      await transition(pool, id, 0, "init", { collectionState: "source_text_ready", processingState: "ready", reviewState: "unreviewed" });
      await transition(pool, id, 1, "complete", { processingState: "complete", source: "summary.generate" });
      const row = await pool.query<{ status: string; publishable: string | null }>(
        "select status, source_metadata #>> '{collection,publishable}' as publishable from articles where id = $1",
        [id],
      );
      assert.deepEqual(row.rows[0], { status: "cleaned", publishable: "false" });
    });

    await t.test("mixed review columns preserve metadata authority and quarantine false text readiness", async () => {
      await pool.query("truncate article_lifecycle_events_p2, article_lifecycle_anomalies_p2, articles restart identity cascade");
      const shortPublished = await pool.query<{ id: string }>(
        `insert into articles(status, source_metadata, review_state, error_class, error_context, summary_json)
         values ('summarized', $1, 'needs_triage', 'job.stale_running', '{"retryable":true}'::jsonb, '{"ok":true}'::jsonb)
         returning id`,
        [{
          collection: { sourceTextAvailable: false, publishable: true },
          review: { decision: "published" },
        }],
      );
      await pool.query("select * from article_lifecycle_backfill_batch_p2(null, 10)");
      const state = await pool.query<{
        status: string;
        publishable: string;
        lifecycle_collection_state: string | null;
        lifecycle_review_state: string;
        lifecycle_attention_state: string;
        lifecycle_attention_code: string;
      }>(
        `select status, source_metadata #>> '{collection,publishable}' as publishable,
                lifecycle_collection_state, lifecycle_review_state,
                lifecycle_attention_state, lifecycle_attention_code
         from articles where id = $1`,
        [shortPublished.rows[0].id],
      );
      assert.deepEqual(state.rows[0], {
        status: "summarized",
        publishable: "true",
        lifecycle_collection_state: null,
        lifecycle_review_state: "approved",
        lifecycle_attention_state: "anomaly",
        lifecycle_attention_code: "backfill.status_text_conflict",
      });

      const approvedWithStaleAttention = await pool.query<{ mapped: Record<string, unknown> }>(
        `select article_lifecycle_map_legacy_p2(
          'cleaned', $1, 'needs_triage', 'job.stale_running', '{"retryable":true}'::jsonb, null
        ) as mapped`,
        [{
          collection: { sourceTextAvailable: true, publishable: true },
          review: { decision: "approved_for_summary" },
        }],
      );
      assert.equal(approvedWithStaleAttention.rows[0].mapped.reviewState, "approved_for_processing");
      assert.equal(approvedWithStaleAttention.rows[0].mapped.attentionCode, "job.stale_running");
    });

    await t.test("batch backfill covers statuses, quarantines ambiguity, reruns, and proves identity parity", async () => {
      await pool.query("truncate article_lifecycle_events_p2, article_lifecycle_anomalies_p2, articles restart identity cascade");
      const statuses = [
        "discovered", "metadata_only", "robots_disallowed", "blocked", "timeout", "fetched",
        "cleaned", "summarizing", "summarized", "failed_fetch", "failed_summary",
      ];
      for (const status of statuses) {
        const sourceTextAvailable = ["cleaned", "summarizing", "summarized", "failed_summary"].includes(status) ? true : false;
        await pool.query(
          "insert into articles(status, source_metadata, summary_json) values ($1,$2,$3)",
          [status, { collection: { sourceTextAvailable, publishable: status === "summarized" } }, status === "summarized" ? { ok: true } : null],
        );
      }
      const historicalReview = await pool.query<{ id: string }>(
        `insert into articles(status, source_metadata, review_state, summary_json)
         values ('summarized', $1, 'manual_resummarized', '{"ok":true}'::jsonb) returning id`,
        [{
          collection: { sourceTextAvailable: true, publishable: true },
          review: { decision: "manual_resummarized" },
          reviewHistory: [{ decision: "published" }, { decision: "manual_resummarized" }],
        }],
      );
      await pool.query("insert into articles(status, source_metadata) values ('needs_review', '{}'::jsonb)");

      let after: string | null = null;
      let complete = false;
      while (!complete) {
        const batchResult: QueryResult<BackfillRow> = await pool.query<BackfillRow>(
          "select * from article_lifecycle_backfill_batch_p2($1, 3)",
          [after],
        );
        after = batchResult.rows[0].next_after_id;
        complete = batchResult.rows[0].batch_complete;
      }
      const evidence = await pool.query<{ article_lifecycle_evidence_p2: Record<string, unknown> }>("select article_lifecycle_evidence_p2()");
      assert.equal(evidence.rows[0].article_lifecycle_evidence_p2.anomalyCount, 1);
      assert.equal(evidence.rows[0].article_lifecycle_evidence_p2.legacyOnlyCount, 0);
      assert.equal(evidence.rows[0].article_lifecycle_evidence_p2.compatibilityOnlyCount, 0);
      assert.equal(
        evidence.rows[0].article_lifecycle_evidence_p2.legacyIdentityDigest,
        evidence.rows[0].article_lifecycle_evidence_p2.compatibilityIdentityDigest,
      );
      const recoveredReview = await pool.query<{ lifecycle_review_state: string }>(
        "select lifecycle_review_state from articles where id = $1",
        [historicalReview.rows[0].id],
      );
      assert.equal(recoveredReview.rows[0].lifecycle_review_state, "approved");

      const rerun = await pool.query("select * from article_lifecycle_backfill_batch_p2(null, 100)");
      assert.equal(rerun.rows[0].mapped_count, 0);
      assert.equal(rerun.rows[0].batch_complete, true);
    });
  } finally {
    await pool.end();
  }
});
