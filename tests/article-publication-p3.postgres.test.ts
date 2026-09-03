import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool, type QueryResult } from "pg";

const databaseUrl = process.env.P3_TEST_DATABASE_URL;
const vectorFallback = process.env.P3_TEST_VECTOR_FALLBACK === "true";
const p2Sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712170000_article_lifecycle_p2.sql"), "utf8");
const rawP3Sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712200000_article_publication_p3.sql"), "utf8");
const replaceVectorForPostgresTest = (sql: string) => sql
  .replaceAll("extensions.vector(1536)", "double precision[]")
  .replaceAll("extensions.vector", "double precision[]")
  .replaceAll("vector(1536)", "double precision[]")
  .replaceAll("OPERATOR(extensions.<=>)", "OPERATOR(public.<=>)");
const p3Sql = vectorFallback ? replaceVectorForPostgresTest(rawP3Sql) : rawP3Sql;
const p3Indexes = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712201000_article_publication_p3_indexes.sql"), "utf8");
const p3Reconciliation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712202000_article_publication_p3_reconciliation.sql"), "utf8");
const rawP3AuthorityCorrection = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260712203000_article_publication_p3_authority_correction.sql"),
  "utf8",
);
const p3AuthorityCorrection = vectorFallback
  ? replaceVectorForPostgresTest(rawP3AuthorityCorrection)
  : rawP3AuthorityCorrection;

interface BackfillRow {
  next_after_id: string | null;
  batch_complete: boolean;
  mapped_count: number;
}

async function insertArticle(pool: Pool, overrides: Record<string, unknown> = {}) {
  const metadata = overrides.source_metadata ?? {
    collection: {
      publishable: true,
      sourceTextAvailable: true,
      sourceUrlVerified: true,
      strategy: "fetch",
    },
  };
  const result = await pool.query<{ id: string }>(`insert into articles (
    source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
    original_language,original_title,korean_title,status,slug,cleaned_text,summary_json,
    source_metadata,updated_at
  ) values ('test-source','Test','Test Court','decision','https://example.test/a',
    'https://example.test/' || gen_random_uuid()::text,'en','Original','Korean','summarized',
    'article-' || gen_random_uuid()::text,repeat('x',600),'{"koreanTitle":"Korean","summary":{"coreSummary":["ok"]}}'::jsonb,$1,now())
  returning id`, [metadata]);
  const id = result.rows[0].id;
  for (const [column, value] of Object.entries(overrides).filter(([key]) => key !== "source_metadata")) {
    assert.match(column, /^[a-z_]+$/);
    await pool.query(`update articles set ${column} = $2 where id = $1`, [id, value]);
  }
  await pool.query(`select * from article_lifecycle_transition_p2(
    $1,0,'p3-test-lifecycle','system','p3-test','system.test','test.initialize',
    'source_text_ready','complete','unreviewed','keep',null,null,null,null,array[]::text[]
  )`, [id]);
  return id;
}

async function transition(pool: Pool, args: {
  articleId: string;
  versionRevision: number;
  publicationRevision: number;
  key: string;
  state: string;
  versionId?: string | null;
  capture?: boolean;
  actor?: string;
  reason?: string;
}) {
  return pool.query(`select * from article_publication_transition_p3(
    $1,$2,$3,$4,$5,$6,$7,$8,'p3-test',$9,null,'p3-test','human','p3-test',null,null,'{}'::jsonb,null
  )`, [
    args.articleId, args.versionRevision, args.publicationRevision, args.key, args.state,
    args.versionId ?? null, args.capture ?? false, args.actor ?? "human", args.reason ?? "P3 test transition reason.",
  ]);
}

test("P3 PostgreSQL publication authority", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const database = await client.query<{ current_database: string }>("select current_database()");
    assert.match(database.rows[0].current_database, /(?:^|_)p3(?:_|$)/i, "P3 tests refuse to reset a database whose name does not contain p3");
    await client.query("drop schema public cascade; create schema public; create extension if not exists pgcrypto");
    if (vectorFallback) {
      await client.query(`
        create function public.p3_test_array_distance(double precision[], double precision[])
        returns double precision language sql immutable as 'select 0::double precision';
        create operator public.<=> (
          leftarg = double precision[], rightarg = double precision[],
          function = public.p3_test_array_distance
        )
      `);
    } else {
      await client.query("create extension if not exists vector");
    }
    const embeddingType = vectorFallback ? "double precision[]" : "vector(1536)";
    await client.query(`create table articles (
    id uuid primary key default gen_random_uuid(), source_id uuid, source_key text not null,
    jurisdiction text not null, institution_name text not null, content_type text not null,
    original_url text not null, canonical_url text not null, original_language text not null,
    original_title text, korean_title text, original_published_at timestamptz,
    discovered_at timestamptz default now(), fetched_at timestamptz, summarized_at timestamptz,
    status text not null, slug text not null unique, raw_text text, cleaned_text text,
    summary_json jsonb, search_vector tsvector, embedding ${embeddingType}, content_hash text,
    source_metadata jsonb, error_metadata jsonb, review_state text, error_class text,
    error_context jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table tags (
    id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null,
    normalized_name text not null, type text not null, description text, article_count integer default 0,
    latest_article_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table article_tags (
    article_id uuid references articles(id), tag_id uuid references tags(id), confidence numeric,
    primary key(article_id,tag_id)
  )`);
    await client.query(p2Sql);
    await client.query(p3Sql);
    await client.query(p3Sql);
    for (const statement of p3Indexes.split(";").map((value) => value.trim()).filter(Boolean)) {
      if (vectorFallback && statement.includes("vector_cosine_ops")) continue;
      await client.query(statement);
      await client.query(statement);
    }
    await client.query(p3Reconciliation);
    await client.query(p3Reconciliation);
    await client.query(p3AuthorityCorrection);
    await client.query(p3AuthorityCorrection);
  } finally {
    await client.end();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await t.test("deterministic immutable versions, idempotency, and concurrent revision fences", async () => {
      const id = await insertArticle(pool);
      const first = await transition(pool, { articleId: id, versionRevision: 0, publicationRevision: 0, key: "publish-1", state: "published", capture: true, actor: "compatibility" });
      assert.equal(first.rows[0].version_created, true);
      const replay = await transition(pool, { articleId: id, versionRevision: 99, publicationRevision: 99, key: "publish-1", state: "published", capture: true, actor: "compatibility" });
      assert.equal(replay.rows[0].idempotent, true);
      assert.equal(first.rows[0].version_id, replay.rows[0].version_id);
      const noOp = await transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 1, key: "capture-noop", state: "published", capture: true, actor: "compatibility" });
      assert.equal(noOp.rows[0].version_created, false);
      assert.equal(noOp.rows[0].publication_applied, false);
      const noOpAudit = await pool.query("select count(*)::integer count from article_audit_ledger_p3 where article_id = $1 and event_type = 'article.version.capture_noop'", [id]);
      assert.equal(noOpAudit.rows[0].count, 1);
      await assert.rejects(pool.query("update article_content_versions_p3 set korean_title = 'changed' where article_id = $1", [id]), /IMMUTABLE/);
      await assert.rejects(pool.query("delete from article_publication_history_p3 where article_id = $1", [id]), /IMMUTABLE/);
      await assert.rejects(pool.query("delete from article_audit_ledger_p3 where article_id = $1", [id]), /IMMUTABLE/);

      await pool.query("update articles set korean_title = 'Korean revision 2', updated_at = now() where id = $1", [id]);
      const attempts = await Promise.allSettled([
        transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 1, key: "concurrent-a", state: "published", capture: true, actor: "compatibility" }),
        transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 1, key: "concurrent-b", state: "published", capture: true, actor: "compatibility" }),
      ]);
      assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
      assert.match(String((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /STALE_REVISION/);

      const replayId = await insertArticle(pool);
      const concurrentReplay = await Promise.all([
        transition(pool, { articleId: replayId, versionRevision: 0, publicationRevision: 0, key: "same-key", state: "published", capture: true, actor: "compatibility" }),
        transition(pool, { articleId: replayId, versionRevision: 0, publicationRevision: 0, key: "same-key", state: "published", capture: true, actor: "compatibility" }),
      ]);
      assert.equal(concurrentReplay.filter((result) => result.rows[0].idempotent).length, 1);
      assert.equal(new Set(concurrentReplay.map((result) => result.rows[0].version_id)).size, 1);
    });

    await t.test("publish, withdraw, and explicit republish matrix rejects queue/system publication", async () => {
      const id = await insertArticle(pool);
      const draft = await transition(pool, { articleId: id, versionRevision: 0, publicationRevision: 0, key: "draft", state: "draft", capture: true });
      const version = draft.rows[0].version_id;
      await assert.rejects(transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 1, key: "illegal-direct", state: "published", versionId: version }), /ILLEGAL_TRANSITION/);
      const review = await transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 1, key: "review", state: "in_review", versionId: version });
      await assert.rejects(transition(pool, { articleId: id, versionRevision: 1, publicationRevision: 2, key: "system-publish", state: "published", versionId: version, actor: "system" }), /ACTOR_FORBIDDEN/);
      const published = await transition(pool, { articleId: id, versionRevision: 1, publicationRevision: Number(review.rows[0].publication_revision), key: "publish", state: "published", versionId: version });
      const withdrawn = await transition(pool, { articleId: id, versionRevision: 1, publicationRevision: Number(published.rows[0].publication_revision), key: "withdraw", state: "withdrawn", versionId: version });
      await assert.rejects(transition(pool, { articleId: id, versionRevision: 1, publicationRevision: Number(withdrawn.rows[0].publication_revision), key: "republish-short", state: "published", versionId: version, reason: "short" }), /REPUBLISH_REASON_REQUIRED/);
      const republished = await transition(pool, { articleId: id, versionRevision: 1, publicationRevision: Number(withdrawn.rows[0].publication_revision), key: "republish", state: "published", versionId: version, reason: "Explicit operator republish after review." });
      assert.equal(republished.rows[0].publication_state, "published");
    });

    await t.test("published projection ignores later mutable lifecycle changes and only explicit withdraw hides it", async () => {
      const id = await insertArticle(pool);
      if (vectorFallback) {
        await pool.query("update articles set embedding = array[0::double precision] where id = $1", [id]);
      }
      const published = await transition(pool, {
        articleId: id,
        versionRevision: 0,
        publicationRevision: 0,
        key: "authority-publish",
        state: "published",
        capture: true,
        actor: "compatibility",
      });
      const versionId = published.rows[0].version_id;
      const tag = await pool.query<{ id: string }>("insert into tags(slug,name,normalized_name,type) values ('authority-tag','Authority','Authority','topic') returning id");
      await pool.query("insert into article_tags(article_id,tag_id,confidence) values ($1,$2,1)", [id, tag.rows[0].id]);

      const beforeHistory = await pool.query("select count(*)::integer count from article_publication_history_p3 where article_id = $1", [id]);
      const beforeOutbox = await pool.query("select count(*)::integer count from article_cache_outbox_p3 where article_id = $1", [id]);
      const beforeJurisdiction = await pool.query("select article_count::integer from public_jurisdiction_article_counts_p3(null) where jurisdiction = 'Test'");
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id = $1", [id])).rows[0].count, 1);
      assert.equal((await pool.query("select article_count from public_tag_projection_p3 where id = $1", [tag.rows[0].id])).rows[0].article_count, 1);
      if (vectorFallback) {
        const vectorMatch = await pool.query("select article_id from match_public_article_versions_p3(array[0::double precision],200,null,null,null,null) where article_id = $1", [id]);
        assert.equal(vectorMatch.rowCount, 1);
      }

      await pool.query(`select * from article_lifecycle_transition_p2(
        $1,1,'post-publish-mutable','summary_worker','p3-test','summary.resummary','test.post_publish_mutation',
        null,'running','needs_review','raise','review.post_publish',false,'high','review',array[]::text[]
      )`, [id]);
      await pool.query(`update articles set status = 'needs_review', cleaned_text = 'short',
        source_metadata = jsonb_set(source_metadata, '{collection,publishable}', 'false'::jsonb),
        updated_at = now() where id = $1`, [id]);

      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id = $1", [id])).rows[0].count, 1);
      assert.equal((await pool.query("select article_count from public_tag_projection_p3 where id = $1", [tag.rows[0].id])).rows[0].article_count, 1);
      assert.equal((await pool.query("select article_count::integer from public_jurisdiction_article_counts_p3(null) where jurisdiction = 'Test'")).rows[0].article_count, beforeJurisdiction.rows[0].article_count);
      assert.equal((await pool.query("select count(*)::integer count from article_publication_history_p3 where article_id = $1", [id])).rows[0].count, beforeHistory.rows[0].count);
      assert.equal((await pool.query("select count(*)::integer count from article_cache_outbox_p3 where article_id = $1", [id])).rows[0].count, beforeOutbox.rows[0].count);
      if (vectorFallback) {
        const vectorMatch = await pool.query("select article_id from match_public_article_versions_p3(array[0::double precision],200,null,null,null,null) where article_id = $1", [id]);
        assert.equal(vectorMatch.rowCount, 1);
      }

      const withdrawn = await transition(pool, {
        articleId: id,
        versionRevision: 1,
        publicationRevision: 1,
        key: "authority-withdraw",
        state: "withdrawn",
        versionId,
      });
      assert.equal(withdrawn.rows[0].publication_state, "withdrawn");
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id = $1", [id])).rows[0].count, 0);
      assert.equal((await pool.query("select article_count from public_tag_projection_p3 where id = $1", [tag.rows[0].id])).rows[0].article_count, 0);
      assert.equal((await pool.query("select count(*)::integer count from article_publication_history_p3 where article_id = $1", [id])).rows[0].count, beforeHistory.rows[0].count + 1);
      assert.equal((await pool.query("select count(*)::integer count from article_cache_outbox_p3 where article_id = $1", [id])).rows[0].count, beforeOutbox.rows[0].count + 1);

      await pool.query(`select * from article_lifecycle_transition_p2(
        $1,2,'post-withdraw-restore','summary_worker','p3-test','summary.resummary','test.post_withdraw_restore',
        null,'complete','approved','clear',null,null,null,null,array['review.post_publish']::text[]
      )`, [id]);
      await pool.query(`update articles set status = 'summarized', cleaned_text = repeat('x',600),
        source_metadata = jsonb_set(source_metadata, '{collection,publishable}', 'true'::jsonb),
        updated_at = now() where id = $1`, [id]);
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id = $1", [id])).rows[0].count, 0);
      assert.equal((await pool.query("select count(*)::integer count from article_publication_history_p3 where article_id = $1", [id])).rows[0].count, beforeHistory.rows[0].count + 1);
      assert.equal((await pool.query("select count(*)::integer count from article_cache_outbox_p3 where article_id = $1", [id])).rows[0].count, beforeOutbox.rows[0].count + 1);
      if (vectorFallback) {
        const vectorMatch = await pool.query("select article_id from match_public_article_versions_p3(array[0::double precision],200,null,null,null,null) where article_id = $1", [id]);
        assert.equal(vectorMatch.rowCount, 0);
      }
      await pool.query(`update articles set status = 'needs_review',
        source_metadata = jsonb_set(source_metadata, '{collection,publishable}', 'false'::jsonb),
        updated_at = now() where id = $1`, [id]);
    });

    await t.test("invalid lifecycle and short text cannot publish", async () => {
      const shortId = await insertArticle(pool, { cleaned_text: "short" });
      await assert.rejects(transition(pool, { articleId: shortId, versionRevision: 0, publicationRevision: 0, key: "short", state: "published", capture: true, actor: "compatibility" }), /INELIGIBLE/);
      const reviewId = await insertArticle(pool);
      await pool.query(`select * from article_lifecycle_transition_p2(
        $1,1,'needs-review','admin','p3-test','admin.review','test.review',null,null,'needs_review','keep',null,null,null,null,array[]::text[]
      )`, [reviewId]);
      await assert.rejects(transition(pool, { articleId: reviewId, versionRevision: 0, publicationRevision: 0, key: "review-block", state: "published", capture: true, actor: "compatibility" }), /INELIGIBLE/);
      await pool.query(`update articles set status = 'needs_review',
        source_metadata = jsonb_set(source_metadata, '{collection,publishable}', 'false'::jsonb), updated_at = now()
        where id = any($1::uuid[])`, [[shortId, reviewId]]);
    });

    await t.test("transaction rollback leaves no publication, audit, history, or outbox", async () => {
      const id = await insertArticle(pool);
      const connection = await pool.connect();
      try {
        await connection.query("begin");
        await connection.query(`select * from article_publication_transition_p3(
          $1,0,0,'rollback','published',null,true,'compatibility','p3-test','Rollback test.',null,null,'llm','p3-test',null,null,'{}'::jsonb,null
        )`, [id]);
        await connection.query("rollback");
      } finally {
        await connection.query("rollback").catch(() => undefined);
        connection.release();
      }
      for (const table of ["article_content_versions_p3", "article_publications_p3", "article_publication_history_p3", "article_audit_ledger_p3", "article_cache_outbox_p3"]) {
        const count = await pool.query(`select count(*)::integer count from ${table} where article_id = $1`, [id]);
        assert.equal(count.rows[0].count, 0, table);
      }
    });

    await t.test("outbox has one logical event per publication revision and stale leases are reclaimable", async () => {
      await pool.query(`update article_cache_outbox_p3 set status = 'delivered', delivered_at = now(),
        lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now()
        where status in ('pending','processing')`);
      const id = await insertArticle(pool);
      await transition(pool, { articleId: id, versionRevision: 0, publicationRevision: 0, key: "outbox-publish", state: "published", capture: true, actor: "compatibility" });
      const logical = await pool.query("select count(*)::integer count from article_cache_outbox_p3 where article_id = $1", [id]);
      assert.equal(logical.rows[0].count, 1);
      const claim = await pool.query("select * from article_cache_outbox_claim_p3('worker-a',1,15)");
      assert.equal(claim.rowCount, 1);
      await pool.query("update article_cache_outbox_p3 set lease_expires_at = now() - interval '1 second' where id = $1", [claim.rows[0].event_id]);
      const reclaimed = await pool.query("select * from article_cache_outbox_claim_p3('worker-b',1,15)");
      assert.equal(reclaimed.rows[0].attempt_count, 2);
      await assert.rejects(pool.query("select article_cache_outbox_deliver_p3($1,'worker-a',$2)", [claim.rows[0].event_id, claim.rows[0].lease_token]), /STALE_LEASE/);
      await pool.query("select article_cache_outbox_deliver_p3($1,'worker-b',$2)", [reclaimed.rows[0].event_id, reclaimed.rows[0].lease_token]);
    });

    await t.test("restartable backfill preserves exact legacy public identities and only returns aggregate evidence", async () => {
      for (let index = 0; index < 5; index += 1) await insertArticle(pool);
      let after: string | null = null;
      let complete = false;
      while (!complete) {
        const batch: QueryResult<BackfillRow> = await pool.query("select * from article_publication_backfill_batch_p3($1,2)", [after]);
        after = batch.rows[0].next_after_id;
        complete = batch.rows[0].batch_complete;
      }
      const evidence = await pool.query<{ article_publication_evidence_p3: Record<string, unknown> }>("select article_publication_evidence_p3()");
      const value = evidence.rows[0].article_publication_evidence_p3;
      assert.equal(value.legacyOnlyCount, 0);
      assert.equal(value.projectionOnlyCount, 0);
      assert.equal(value.legacyIdentityDigest, value.projectionIdentityDigest);
      const rerun = await pool.query("select * from article_publication_backfill_batch_p3(null,2000)");
      assert.equal(rerun.rows[0].mapped_count, 0);
    });

    await t.test("authority RPCs are security definer with fixed search_path and PUBLIC execute revoked", async () => {
      const rows = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; public_execute: boolean }>(`
        select p.proname, p.prosecdef, p.proconfig,
          has_function_privilege('public', p.oid, 'execute') public_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'article_publication_transition_p3','article_publication_snapshot_p3',
          'article_cache_outbox_claim_p3','article_cache_outbox_deliver_p3','article_cache_outbox_fail_p3'
        )
      `);
      assert.equal(rows.rowCount, 5);
      for (const row of rows.rows) {
        assert.equal(row.prosecdef, true);
        assert.ok(row.proconfig?.includes("search_path=public, pg_temp"));
        assert.equal(row.public_execute, false);
      }
      const legacyColumns = await pool.query("select status, source_metadata from articles limit 1");
      assert.ok(legacyColumns.fields.some((field) => field.name === "status"));
    });
  } finally {
    await pool.end();
  }
});
