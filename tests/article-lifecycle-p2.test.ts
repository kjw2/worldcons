import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  articleLifecycleP2ReadsEnabled,
  articleLifecycleP2ShadowWriteEnabled,
  mapLegacyArticleLifecycle,
  shadowArticleLifecycleTransition,
} from "../lib/article-lifecycle";
import type {
  ArticleLifecycleRepository,
  ArticleLifecycleSnapshot,
  ArticleLifecycleTransitionInput,
  ArticleLifecycleTransitionResult,
} from "../lib/article-lifecycle/types";
import { createArticleLifecycleService } from "../lib/article-lifecycle/service";

const migrationPath = path.join(process.cwd(), "supabase/migrations/20260712170000_article_lifecycle_p2.sql");
const indexMigrationPath = path.join(process.cwd(), "supabase/migrations/20260712171000_article_lifecycle_p2_indexes.sql");

const expectedByStatus = {
  discovered: ["discovered", "not_ready", "unreviewed"],
  metadata_only: ["metadata_only", "not_ready", "unreviewed"],
  robots_disallowed: ["metadata_only", "not_ready", "unreviewed"],
  blocked: ["metadata_only", "not_ready", "unreviewed"],
  timeout: ["metadata_only", "not_ready", "unreviewed"],
  fetched: ["source_fetched", "not_ready", "unreviewed"],
  cleaned: ["source_text_ready", "ready", "unreviewed"],
  summarizing: ["source_text_ready", "running", "unreviewed"],
  summarized: ["source_text_ready", "complete", "unreviewed"],
  failed_fetch: ["metadata_only", "not_ready", "unreviewed"],
  failed_summary: ["source_text_ready", "ready", "unreviewed"],
  needs_review: ["source_text_ready", "ready", "needs_review"],
} as const;

test("P2 maps every existing article status to orthogonal axes", () => {
  for (const [status, expected] of Object.entries(expectedByStatus)) {
    const sourceTextAvailable = status === "needs_review" ? true : undefined;
    const mapped = mapLegacyArticleLifecycle({
      status,
      sourceMetadata: sourceTextAvailable === undefined ? {} : { collection: { sourceTextAvailable } },
      hasSummary: status === "summarized",
    });
    assert.equal(mapped.ok, true, status);
    if (!mapped.ok) continue;
    assert.deepEqual(
      [mapped.state.collectionState, mapped.state.processingState, mapped.state.reviewState],
      expected,
      status,
    );
  }
});

test("ambiguous and contradictory legacy evidence is quarantined", () => {
  assert.deepEqual(
    mapLegacyArticleLifecycle({ status: "needs_review", sourceMetadata: {}, hasSummary: false }),
    { ok: false, anomalyCode: "backfill.needs_review_text_ambiguous" },
  );
  assert.deepEqual(
    mapLegacyArticleLifecycle({ status: "cleaned", sourceMetadata: { collection: { sourceTextAvailable: false } }, hasSummary: false }),
    { ok: false, anomalyCode: "backfill.status_text_conflict" },
  );
  assert.deepEqual(
    mapLegacyArticleLifecycle({ status: "summarized", sourceMetadata: { collection: { sourceTextAvailable: true } }, hasSummary: false }),
    { ok: false, anomalyCode: "backfill.summarized_without_summary" },
  );
});

test("review and structured attention mapping stay independent", () => {
  const reviewed = mapLegacyArticleLifecycle({
    status: "failed_summary",
    sourceMetadata: {
      collection: { sourceTextAvailable: true, publishable: true },
      review: { decision: "approved_for_summary" },
    },
    errorClass: "summary.retryable_quota",
    errorContext: { retryable: true },
    hasSummary: false,
  });
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(reviewed.state.reviewState, "approved_for_processing");
  assert.deepEqual(reviewed.state.attention, {
    operation: "raise",
    code: "summary.retryable_quota",
    retryable: true,
    severity: "high",
    source: "processing",
  });
});

test("workflow-only review labels recover the latest authoritative history decision", () => {
  const mapped = mapLegacyArticleLifecycle({
    status: "summarized",
    sourceMetadata: {
      collection: { sourceTextAvailable: true, publishable: true },
      review: { decision: "manual_resummarized" },
      reviewHistory: [
        { decision: "published" },
        { decision: "manual_resummarized" },
      ],
    },
    reviewState: "manual_resummarized",
    hasSummary: true,
  });
  assert.equal(mapped.ok, true);
  if (mapped.ok) assert.equal(mapped.state.reviewState, "approved");

  const triage = mapLegacyArticleLifecycle({
    status: "summarized",
    sourceMetadata: {
      collection: { sourceTextAvailable: true, publishable: true },
      review: { decision: "published" },
    },
    reviewState: "needs_triage",
    hasSummary: true,
  });
  assert.equal(triage.ok, true);
  if (triage.ok) assert.equal(triage.state.reviewState, "needs_review");
});

test("P2 flags and cohorts are false by default and reads remain independent", async () => {
  assert.equal(articleLifecycleP2ShadowWriteEnabled({}), false);
  assert.equal(articleLifecycleP2ReadsEnabled({}), false);
  assert.equal(articleLifecycleP2ShadowWriteEnabled({ ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED: "TRUE" }), true);
  assert.equal(articleLifecycleP2ReadsEnabled({ ARTICLE_LIFECYCLE_P2_READ_ENABLED: "true" }), true);

  let called = false;
  const service = {
    get: async () => {
      called = true;
      throw new Error("must not read while disabled");
    },
    transition: async () => {
      called = true;
      throw new Error("must not transition while disabled");
    },
  };
  const result = await shadowArticleLifecycleTransition({
    articleId: "00000000-0000-4000-8000-000000000001",
    cohort: "summary",
    actorType: "summary_worker",
    source: "summary.generate",
    reasonCode: "legacy.summary.completed",
    processingState: "complete",
  }, { environment: {}, service });
  assert.deepEqual(result, { shadow: "disabled" });
  assert.equal(called, false);
});

test("P2 shadow writes require an enabled cohort and preserve expected revision", async () => {
  const current: ArticleLifecycleSnapshot = {
    articleId: "00000000-0000-4000-8000-000000000001",
    revision: 7,
    collectionState: "source_text_ready",
    processingState: "ready",
    reviewState: "unreviewed",
    attentionState: "clear",
    attentionCode: null,
    attentionRetryable: null,
    attentionSeverity: null,
    attentionSource: null,
  };
  let captured: ArticleLifecycleTransitionInput | undefined;
  const transitioned: ArticleLifecycleTransitionResult = { ...current, revision: 8, processingState: "complete", applied: true, idempotent: false };
  const service = {
    get: async () => ({ ok: true as const, data: current }),
    transition: async (input: ArticleLifecycleTransitionInput) => {
      captured = input;
      return { ok: true as const, data: transitioned };
    },
  };
  const disabled = await shadowArticleLifecycleTransition({
    articleId: current.articleId,
    cohort: "summary",
    actorType: "summary_worker",
    source: "summary.generate",
    reasonCode: "legacy.summary.completed",
    processingState: "complete",
  }, {
    environment: { ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED: "true", ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS: "collection" },
    service,
  });
  assert.deepEqual(disabled, { shadow: "cohort_disabled" });

  const written = await shadowArticleLifecycleTransition({
    articleId: current.articleId,
    cohort: "summary",
    actorType: "summary_worker",
    source: "summary.generate",
    reasonCode: "legacy.summary.completed",
    processingState: "complete",
  }, {
    environment: { ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED: "true", ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS: "summary" },
    service,
  });
  assert.equal(written.shadow, "written");
  const submitted = captured as ArticleLifecycleTransitionInput | undefined;
  assert.equal(submitted?.expectedRevision, 7);
  assert.match(String(submitted?.idempotencyKey), /^p2-shadow:[a-f0-9]{64}$/);
});

test("P2 shadow failures cannot alter legacy control flow", async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await shadowArticleLifecycleTransition({
      articleId: "00000000-0000-4000-8000-000000000001",
      cohort: "review",
      actorType: "admin",
      source: "admin.review",
      reasonCode: "legacy.review.approved",
      reviewState: "approved",
    }, {
      environment: { ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED: "true", ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS: "review" },
      service: {
        get: async () => { throw new Error("secret database detail"); },
        transition: async () => { throw new Error("not reached"); },
      },
    });
    assert.deepEqual(result, { shadow: "failed", errorCode: "internal" });
  } finally {
    console.warn = originalWarn;
  }
});

test("P2 service enforces actor ownership before repository access", async () => {
  let called = false;
  const repository: ArticleLifecycleRepository = {
    get: async () => {
      called = true;
      return { ok: false, error: { code: "internal", message: "unused", retryable: false } };
    },
    transition: async () => {
      called = true;
      return { ok: false, error: { code: "internal", message: "unused", retryable: false } };
    },
  };
  const service = createArticleLifecycleService(repository);
  const result = await service.transition({
    articleId: "00000000-0000-4000-8000-000000000001",
    expectedRevision: 1,
    idempotencyKey: "actor-test",
    actorType: "admin",
    source: "summary.generate",
    reasonCode: "test.actor_mismatch",
    processingState: "running",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_input");
  assert.equal(called, false);
});

test("P2 migration is additive, guarded, indexed online, and leaves publication untouched", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const indexes = fs.readFileSync(indexMigrationPath, "utf8");
  assert.match(sql, /alter table articles add column if not exists lifecycle_collection_state/i);
  assert.match(sql, /articles_lifecycle_cross_axis_p2_check[\s\S]*not valid/i);
  assert.match(sql, /validate constraint articles_lifecycle_cross_axis_p2_check/i);
  assert.match(sql, /ARTICLE_LIFECYCLE_DIRECT_WRITE_FORBIDDEN/);
  assert.match(sql, /for update/);
  assert.match(sql, /ARTICLE_LIFECYCLE_STALE_REVISION/);
  assert.match(sql, /article_lifecycle_events_p2_article_key_key unique/i);
  assert.match(sql, /article_lifecycle_backfill_batch_p2/);
  assert.match(sql, /article_lifecycle_evidence_p2/);
  assert.match(indexes, /create index concurrently if not exists/gi);
  assert.doesNotMatch(sql, /drop column|alter column status|drop table articles|truncate articles/i);

  const transitionStart = sql.indexOf("create or replace function article_lifecycle_transition_p2");
  const transitionEnd = sql.indexOf("create or replace function article_lifecycle_map_legacy_p2");
  const transitionSql = sql.slice(transitionStart, transitionEnd);
  assert.doesNotMatch(transitionSql, /\bstatus\s*=|source_metadata\s*=/i, "P2 transitions must not publish or mutate the legacy predicate");
});

test("all lifecycle write paths use the compatibility boundary and no application path writes P2 columns", () => {
  const covered = [
    "lib/ingest/run.ts",
    "lib/ingest/summary.ts",
    "lib/ingest/review.ts",
    "lib/ingest/manual-summary-edit.ts",
    "lib/ingest/candidate-retry.ts",
    "lib/db/admin-queries.ts",
  ];
  for (const relative of covered) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.match(source, /shadowArticleLifecycleTransition|shadowLegacyArticleLifecycleOutcome|insertNormalizedArticle/, relative);
  }

  const applicationFiles = ["app", "lib", "scripts", "workers"]
    .flatMap((directory) => walk(path.join(process.cwd(), directory)))
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .filter((file) => !file.includes(`${path.sep}article-lifecycle${path.sep}repository.ts`));
  for (const file of applicationFiles) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\.update\(\{[\s\S]{0,800}lifecycle_(?:collection|processing|review|attention)_state/, file);
  }
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
