import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  articlePublicationV4OutboxProcessorEnabled,
  articlePublicationV4ReadsEnabled,
  articlePublicationV4ShadowWriteEnabled,
  processArticleCacheOutboxBatch,
  shadowConfirmedLegacyArticleMutation,
} from "@/lib/article-publication";
import type {
  ArticleCacheOutboxEvent,
  ArticleCacheOutboxRepository,
  ArticlePublicationRepository,
} from "@/lib/article-publication/types";
import { createArticlePublicationService } from "@/lib/article-publication/service";
import { shadowConfirmedAdminBulkArticleOutcomes } from "@/lib/db/admin-queries";

const articleId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const publicationId = "33333333-3333-4333-8333-333333333333";

function successfulRepository(calls: Array<Record<string, unknown>>): ArticlePublicationRepository {
  return {
    async getSnapshot(id) {
      calls.push({ operation: "snapshot", id });
      return {
        ok: true,
        data: {
          articleId: id,
          versionRevision: 4,
          publicationRevision: 7,
          publicationState: "published",
          legacyUpdatedAt: "2026-07-12T00:00:00.000Z",
        },
      };
    },
    async transition(input) {
      calls.push({ operation: "transition", input });
      return {
        ok: true,
        data: {
          articleId: input.articleId,
          versionId,
          versionRevision: 5,
          publicationId,
          publicationRevision: 8,
          publicationState: input.targetState,
          versionCreated: true,
          publicationApplied: true,
          idempotent: false,
        },
      };
    },
  };
}

test("P3 flags are false unless explicitly true", () => {
  assert.equal(articlePublicationV4ShadowWriteEnabled({}), false);
  assert.equal(articlePublicationV4ReadsEnabled({ ADMIN_PUBLICATION_V4_READ_ENABLED: "1" }), false);
  assert.equal(articlePublicationV4OutboxProcessorEnabled({ ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED: "TRUE" }), true);
});

test("compatibility shadows only confirmed outcomes and builds deterministic persisted-row transitions", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = createArticlePublicationService(successfulRepository(calls));
  const input = {
    articleId,
    succeeded: true,
    reason: "Legacy manual edit persisted.",
    provenanceActorType: "human" as const,
  };

  const disabled = await shadowConfirmedLegacyArticleMutation(input, { environment: {}, service, legacyPublic: async () => true });
  assert.deepEqual(disabled, { shadow: "disabled" });
  assert.equal(calls.length, 0);

  const unconfirmed = await shadowConfirmedLegacyArticleMutation({ ...input, succeeded: false }, {
    environment: { ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED: "true" },
    service,
    legacyPublic: async () => true,
  });
  assert.deepEqual(unconfirmed, { shadow: "not_confirmed" });
  assert.equal(calls.length, 0);

  const environment = { ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED: "true" };
  const first = await shadowConfirmedLegacyArticleMutation(input, { environment, service, legacyPublic: async () => false });
  const second = await shadowConfirmedLegacyArticleMutation(input, { environment, service, legacyPublic: async () => false });
  assert.equal(first.shadow, "written");
  assert.equal(second.shadow, "written");
  const transitions = calls.filter((call) => call.operation === "transition").map((call) => call.input as Record<string, unknown>);
  assert.equal(transitions.length, 2);
  assert.equal(transitions[0].targetState, "withdrawn");
  assert.equal(transitions[0].captureLegacy, true);
  assert.equal(transitions[0].idempotencyKey, transitions[1].idempotencyKey);
});

test("shadow authority failures are isolated as data", async () => {
  const repository = successfulRepository([]);
  repository.transition = async () => ({ ok: false, error: { code: "stale_revision", retryable: true } });
  const result = await shadowConfirmedLegacyArticleMutation({
    articleId,
    succeeded: true,
    reason: "Confirmed legacy result.",
    provenanceActorType: "import",
  }, {
    environment: { ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED: "true" },
    service: createArticlePublicationService(repository),
    legacyPublic: async () => true,
  });
  assert.deepEqual(result, { shadow: "failed", errorCode: "stale_revision" });
});

test("bulk review shadows each unique persisted row and excludes missing or failed rows", async () => {
  const calls: Array<Record<string, unknown>> = [];
  await shadowConfirmedAdminBulkArticleOutcomes([
    { articleId, persisted: true },
    { articleId, persisted: true },
    { articleId: "55555555-5555-4555-8555-555555555555", persisted: true },
    { articleId: "66666666-6666-4666-8666-666666666666", persisted: false },
    { persisted: false },
  ], { action: "close-private", notePresent: true }, async (input) => {
    calls.push(input as unknown as Record<string, unknown>);
    return { shadow: "written", versionCreated: true, publicationApplied: true, idempotent: false };
  });

  assert.deepEqual(calls.map((call) => call.articleId), [articleId, "55555555-5555-4555-8555-555555555555"]);
  assert.ok(calls.every((call) => call.succeeded === true));
  assert.ok(calls.every((call) => String(call.reason).includes("private closure")));
});

function outboxEvent(index: number): ArticleCacheOutboxEvent {
  return {
    eventId: `${index}`.padStart(8, "0") + "-0000-4000-8000-000000000000",
    eventKey: `event-${index}`,
    articleId,
    publicationId,
    publicationRevision: index,
    versionId,
    publicationState: "published",
    articleSlug: `article-${index}`,
    leaseToken: "44444444-4444-4444-8444-444444444444",
    leaseExpiresAt: "2026-07-12T00:02:00.000Z",
    attemptCount: 1,
  };
}

test("outbox is default-off and batches at-least-once delivery through an idempotent handler", async () => {
  const calls: string[] = [];
  const events = [outboxEvent(1), outboxEvent(2)];
  const repository: ArticleCacheOutboxRepository = {
    async claim() { calls.push("claim"); return events; },
    async deliver(event) { calls.push(`deliver:${event.eventKey}`); },
    async fail(event) { calls.push(`fail:${event.eventKey}`); return "pending"; },
  };
  const handler = { async invalidate(received: readonly ArticleCacheOutboxEvent[]) { calls.push(`invalidate:${received.length}`); } };

  const disabled = await processArticleCacheOutboxBatch({ workerId: "worker", repository, handler, environment: {} });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(calls, []);

  const delivered = await processArticleCacheOutboxBatch({
    workerId: "worker",
    repository,
    handler,
    environment: { ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED: "true" },
  });
  assert.equal(delivered.deliveredCount, 2);
  assert.deepEqual(calls, ["claim", "invalidate:2", "deliver:event-1", "deliver:event-2"]);
});

test("outbox failure retries every claimed logical event without leaking the handler error", async () => {
  const failed: string[] = [];
  const errorCodes: string[] = [];
  const repository: ArticleCacheOutboxRepository = {
    async claim() { return [outboxEvent(1), outboxEvent(2)]; },
    async deliver() { assert.fail("delivery must not run after handler failure"); },
    async fail(event, _workerId, code) {
      failed.push(event.eventKey);
      errorCodes.push(code);
      if (event.eventKey === "event-2") throw new Error("stale lease");
      return "dead_letter";
    },
  };
  const result = await processArticleCacheOutboxBatch({
    workerId: "worker",
    repository,
    handler: { async invalidate() { throw new Error("sensitive response body"); } },
    environment: { ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED: "true" },
  });
  assert.deepEqual(failed, ["event-1", "event-2"]);
  assert.deepEqual(errorCodes, ["handler.failed", "handler.failed"]);
  assert.equal(result.failedCount, 1);
  assert.equal(result.deadLetterCount, 1);
});

test("migration and application contracts cover immutable authority, projection, and every public surface", () => {
  const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712200000_article_publication_p3.sql"), "utf8");
  const reconciliation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712202000_article_publication_p3_reconciliation.sql"), "utf8");
  const correction = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712203000_article_publication_p3_authority_correction.sql"), "utf8");
  const queries = fs.readFileSync(path.join(process.cwd(), "lib/db/queries.ts"), "utf8");
  const vector = fs.readFileSync(path.join(process.cwd(), "lib/search/vector.ts"), "utf8");
  const adminQueries = fs.readFileSync(path.join(process.cwd(), "lib/db/admin-queries.ts"), "utf8");

  for (const table of [
    "article_content_versions_p3",
    "article_publications_p3",
    "article_publication_history_p3",
    "article_audit_ledger_p3",
    "article_cache_outbox_p3",
  ]) assert.ok(migration.includes(`create table if not exists ${table}`));
  assert.ok(migration.includes("before update or delete on article_content_versions_p3"));
  assert.ok(migration.includes("before update or delete on article_publication_history_p3"));
  assert.ok(migration.includes("before update or delete on article_audit_ledger_p3"));
  assert.ok(migration.includes("security definer\nset search_path = public, pg_temp"));
  assert.ok(migration.includes("ARTICLE_PUBLICATION_ACTOR_FORBIDDEN"));
  assert.ok(migration.includes("ARTICLE_PUBLICATION_INELIGIBLE"));
  assert.ok(migration.includes("on conflict on constraint article_cache_outbox_p3_publication_revision_key do nothing"));
  assert.ok(reconciliation.includes("legacyIdentityDigest"));
  assert.ok(reconciliation.includes("projectionIdentityDigest"));
  assert.ok(!reconciliation.includes("original_url"));
  assert.ok(correction.includes("where p.state = 'published'"));
  assert.ok(!correction.includes("article_publication_eligible_p3"));
  assert.ok(!correction.includes("join articles"));
  assert.ok(correction.includes("create or replace view public_tag_projection_p3"));
  assert.ok(correction.includes("create or replace function public_jurisdiction_article_counts_p3"));
  assert.ok(correction.includes("create or replace function match_public_article_versions_p3"));
  assert.ok(adminQueries.includes("shadowConfirmedAdminBulkArticleOutcomes"));
  assert.ok(adminQueries.includes('.select("id")'));
  assert.ok(adminQueries.includes("if (persisted?.id)"));
  assert.ok(!adminQueries.includes("updatedCount === refs.length"));

  assert.ok(queries.includes("public_article_projection_p3"));
  assert.ok(queries.includes("public_tag_projection_p3"));
  assert.ok(queries.includes("public_jurisdiction_article_counts_p3"));
  assert.ok(vector.includes("match_public_article_versions_p3"));
  for (const surface of [
    "app/page.tsx",
    "app/list/page.tsx",
    "app/search/page.tsx",
    "app/tags/[slug]/page.tsx",
    "app/sources/[sourceKey]/page.tsx",
    "app/api/portal/latest/route.ts",
    "app/rss.xml/route.ts",
    "app/sitemap.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), surface), "utf8");
    assert.ok(source.includes("@/lib/db/queries") || source.includes("@/lib/search/vector"), `${surface} must use the shared P3-aware repository`);
  }

  for (const mutationPath of [
    "lib/ingest/run.ts",
    "lib/ingest/summary.ts",
    "lib/ingest/review.ts",
    "lib/ingest/manual-summary-edit.ts",
    "lib/db/admin-queries.ts",
    "scripts/canonicalize-source-terminology.ts",
  ]) {
    assert.ok(fs.readFileSync(path.join(process.cwd(), mutationPath), "utf8").includes("shadowConfirmedLegacyArticleMutation"));
  }
});
