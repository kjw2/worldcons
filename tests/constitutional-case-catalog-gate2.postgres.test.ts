import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";

const databaseUrl = process.env.CATALOG_TEST_DATABASE_URL;
const migration = (name: string) => fs.readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
const vectorFallback = (sql: string) => sql
  .replaceAll("extensions.vector(1536)", "double precision[]")
  .replaceAll("extensions.vector", "double precision[]")
  .replaceAll("vector(1536)", "double precision[]");

const p0 = migration("20260712090000_admin_command_control_plane.sql");
const p1 = migration("20260712130000_admin_command_worker_p1.sql");
const p2 = migration("20260712170000_article_lifecycle_p2.sql");
const p3 = vectorFallback(migration("20260712200000_article_publication_p3.sql"));
const gate1 = migration("20260903120000_constitutional_case_backfill_gate1.sql");
const gate2 = vectorFallback(migration("20260903130000_constitutional_case_catalog_gate2.sql"));

const policySql = `
insert into source_corpus_policies(
  source_key,policy_version,scope_definition,official_scope_url,discovery_methods,
  authority_hosts,redirect_hosts,robots_url,robots_observed_at,robots_rules_hash,
  license_basis,default_text_access_policy,allow_raw_snapshot,normalize_replay_policy,
  bounded_replay_fields,retention_days,min_request_delay_ms,max_concurrency,
  reviewed_by,reviewed_at,review_due_at
) values (
  'es-tribunal-constitucional','spain-hj-gate2-v1','{"scope":"2024 SENTENCIA"}',
  'https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index',array['official_search'],
  array['hj.tribunalconstitucional.es'],array[]::text[],
  'https://hj.tribunalconstitucional.es/robots.txt',now(),repeat('a',64),
  'official-public-record','full',false,'bounded_evidence',array['text','metadata'],3650,1000,1,
  'catalog-test',now(),now()+interval '1 year'
);`;

async function insertArticle(pool: Pool, suffix: string, status = "cleaned") {
  const result = await pool.query<{ id: string }>(`
    insert into articles(
      source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
      original_language,original_title,korean_title,original_published_at,status,slug,cleaned_text,
      summary_json,source_metadata,error_metadata
    ) values (
      (select id from sources where source_key='es-tribunal-constitucional'),
      'es-tribunal-constitucional','Spain','Tribunal Constitucional de España','decision',
      'https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/'||$1,
      'https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/'||$1,
      'es','SENTENCIA '||$1||'/2024',null,'2024-05-08T00:00:00Z',$2,'es-tc-'||$1,
      repeat('texto ',120),null,
      jsonb_build_object('collection',jsonb_build_object(
        'publishable',true,'sourceTextAvailable',true,'sourceUrlVerified',true,'strategy','fetch'
      )),jsonb_build_object('internal','must-not-leak')
    ) returning id
  `, [suffix, status]);
  return result.rows[0].id;
}

async function seedCaseMetadata(pool: Pool, articleId: string, policyVersion = "spain-hj-gate2-v1") {
  await pool.query(`insert into case_metadata_v1(
    article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,
    enrichment_status,text_access_policy,source_policy_version,discovery_source,authority_source
  ) values ($1,'es-tribunal-constitucional','verified','{"authorityUrl":"https://hj.tribunalconstitucional.es"}',
    'verified','source_only','full',$2,'official_search','https://hj.tribunalconstitucional.es')`, [articleId, policyVersion]);
}

async function capture(pool: Pool, input: {
  articleId: string;
  expected: number;
  role: "authoritative_source" | "enrichment_full";
  anchor?: string | null;
  sourceHash: string;
}) {
  return pool.query<{ version_id: string; version_revision: string; version_created: boolean }>(`
    select * from article_version_capture_v4(
      $1,$2,$3,$4,$5,$6,
      '{"authorityStatus":"verified","textAccessPolicy":"full"}'::jsonb,
      '[]'::jsonb,repeat('b',64),null,null,'import','catalog-test',null,null
    )
  `, [
    input.articleId,
    input.expected,
    input.role,
    input.anchor ?? null,
    input.sourceHash,
    input.role === "authoritative_source" ? null : input.sourceHash,
  ]);
}

async function catalogTransition(pool: Pool, input: {
  articleId: string;
  anchor: string;
  expected: number;
  key: string;
  state?: "published" | "withdrawn";
}) {
  return pool.query(`select * from case_catalog_publication_transition_v1(
    $1,$2,$3,$4,$5,'backfill','catalog-test','Catalog PostgreSQL contract test.'
  )`, [input.articleId, input.anchor, input.expected, input.key, input.state ?? "published"]);
}

async function p3Transition(pool: Pool, input: {
  articleId: string;
  versionRevision: number;
  publicationRevision: number;
  versionId: string;
  key: string;
  state: "published" | "withdrawn";
}) {
  return pool.query(`select * from article_publication_transition_p3(
    $1,$2,$3,$4,$5,$6,false,'backfill','catalog-test','P3 Gate 2 contract transition.',
    null,'catalog-test','import','catalog-test',null,null,'{}'::jsonb,null
  )`, [
    input.articleId,input.versionRevision,input.publicationRevision,input.key,input.state,input.versionId,
  ]);
}

test("Gate 2 PostgreSQL contracts separate Catalog authority from current P3 enrichment", { skip: !databaseUrl }, async (t) => {
  const setup = new Client({ connectionString: databaseUrl });
  await setup.connect();
  try {
    const database = await setup.query<{ current_database: string }>("select current_database()");
    assert.match(database.rows[0].current_database, /catalog/i, "Catalog tests refuse to reset a database without catalog in its name");
    await setup.query("drop schema public cascade; create schema public; drop schema if exists extensions cascade; create schema extensions");
    await setup.query("create extension if not exists pgcrypto with schema extensions");
    await setup.query(`
      create function extensions.test_array_distance(double precision[],double precision[])
      returns double precision language sql immutable as 'select 0::double precision';
      create operator extensions.<=> (
        leftarg=double precision[],rightarg=double precision[],function=extensions.test_array_distance
      );
    `);
    await setup.query(p0);
    await setup.query(`create table source_url_candidates(
      id uuid primary key default gen_random_uuid(),source_key text not null,url text not null,
      candidate_type text not null,discovered_by text not null,status text not null default 'pending',
      last_attempt_at timestamptz,attempt_count integer not null default 0,last_error_code text,
      last_error_message text,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
    )`);
    await setup.query(p1);
    await setup.query(`
      create table sources(
        id uuid primary key default gen_random_uuid(),source_key text unique not null,name text not null,
        jurisdiction text not null,base_url text not null,language text not null,is_active boolean not null default true
      );
      insert into sources(source_key,name,jurisdiction,base_url,language) values(
        'es-tribunal-constitucional','Tribunal Constitucional de España','Spain',
        'https://hj.tribunalconstitucional.es','es'
      );
      create table articles(
        id uuid primary key default gen_random_uuid(),source_id uuid references sources(id),source_key text not null,
        jurisdiction text not null,institution_name text not null,content_type text not null,
        original_url text not null,canonical_url text not null unique,original_language text not null,
        original_title text,korean_title text,original_published_at timestamptz,discovered_at timestamptz default now(),
        fetched_at timestamptz,summarized_at timestamptz,status text not null,slug text not null unique,
        raw_text text,cleaned_text text,summary_json jsonb,search_vector tsvector,embedding double precision[],
        content_hash text,source_metadata jsonb,error_metadata jsonb,review_state text,error_class text,error_context jsonb,
        created_at timestamptz default now(),updated_at timestamptz default now()
      );
      create table tags(
        id uuid primary key default gen_random_uuid(),slug text unique not null,name text not null,
        normalized_name text not null,type text not null,description text,article_count integer default 0,
        latest_article_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now()
      );
      create table article_tags(
        article_id uuid references articles(id),tag_id uuid references tags(id),confidence numeric,
        primary key(article_id,tag_id)
      );
    `);
    await setup.query(p2);
    await setup.query(p3);
    await setup.query(gate1);
    await setup.query(policySql);

    const legacyArticle = await setup.query<{ id: string }>(`
      insert into articles(
        source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
        original_language,original_title,korean_title,status,slug,cleaned_text,summary_json,source_metadata
      ) values (
        (select id from sources limit 1),'es-tribunal-constitucional','Spain','Tribunal Constitucional de España',
        'decision','https://example.test/legacy','https://example.test/legacy','es','Legacy','기존 판례',
        'summarized','legacy-case',repeat('x',600),'{"koreanTitle":"기존 판례","summary":{"coreSummary":["요약"]}}',
        '{"collection":{"publishable":true,"sourceTextAvailable":true,"sourceUrlVerified":true,"strategy":"fetch"}}'
      ) returning id
    `);
    await setup.query(`select * from article_lifecycle_transition_p2(
      $1,0,'legacy-init','system','catalog-test','system.test','test.initialize',
      'source_text_ready','complete','unreviewed','keep',null,null,null,null,array[]::text[]
    )`, [legacyArticle.rows[0].id]);
    await setup.query(`select * from article_publication_transition_p3(
      $1,0,0,'legacy-publish','published',null,true,'compatibility','catalog-test','Legacy publication.',
      null,null,'import','catalog-test',null,null,'{}',null
    )`, [legacyArticle.rows[0].id]);
    await setup.query(gate2);
  } finally {
    await setup.end();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await t.test("global head backfill and legacy sidecar preserve existing public P3", async () => {
      const row = await pool.query(`select h.current_revision,l.freshness,l.freshness_basis
        from article_revision_heads_v4 h
        join article_content_versions_p3 v on v.id=h.current_version_id
        join legacy_version_freshness_classifications_v4 l on l.version_id=v.id
        where v.slug='legacy-case'`);
      assert.equal(row.rowCount, 1);
      assert.equal(Number(row.rows[0].current_revision), 1);
      assert.deepEqual([row.rows[0].freshness, row.rows[0].freshness_basis], ["current", "legacy_same_version"]);
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where slug='legacy-case'")).rows[0].count, 1);
    });

    await t.test("decision identity is unique but proceeding docket is reusable", async () => {
      const first = await insertArticle(pool, "identity-a");
      const second = await insertArticle(pool, "identity-b");
      await pool.query(`insert into case_identifiers_v1(article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value)
        values($1,'es-tribunal-constitucional','docket','proceeding','2 BvR 547/21','2bvr54721'),
              ($2,'es-tribunal-constitucional','docket','proceeding','2 BvR 547/21','2bvr54721')`, [first, second]);
      await pool.query(`insert into case_identifiers_v1(article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value)
        values($1,'es-tribunal-constitucional','source_record_id','decision','HJ-1','hj1')`, [first]);
      await assert.rejects(
        pool.query(`insert into case_identifiers_v1(article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value)
          values($1,'es-tribunal-constitucional','source_record_id','decision','HJ-1','hj1')`, [second]),
        /case_identifiers_v1_decision_unique_idx/,
      );
    });

    await t.test("authoritative self-anchor and current full P3 use separate heads and pointers", async () => {
      const articleId = await insertArticle(pool, "53-2024");
      await seedCaseMetadata(pool, articleId);
      const sourceA = await capture(pool, { articleId, expected: 0, role: "authoritative_source", sourceHash: "1".repeat(64) });
      const sourceAVersion = sourceA.rows[0].version_id;
      assert.equal(sourceA.rows[0].version_created, true);
      const authoritative = await pool.query("select version_role,source_anchor_version_id,id from article_content_versions_p3 where id=$1", [sourceAVersion]);
      assert.equal(authoritative.rows[0].version_role, "authoritative_source");
      assert.equal(authoritative.rows[0].source_anchor_version_id, authoritative.rows[0].id);
      assert.equal((await pool.query("select count(*)::integer count from article_version_heads_p3 where article_id=$1", [articleId])).rows[0].count, 0);

      await catalogTransition(pool, { articleId, anchor: sourceAVersion, expected: 0, key: "catalog-a" });
      assert.equal((await pool.query("select catalog_ai_stale_v4 from articles where id=$1", [articleId])).rows[0].catalog_ai_stale_v4, false);
      await pool.query(`update articles set korean_title='헌법재판소 판결',status='summarized',
        summary_json='{"koreanTitle":"헌법재판소 판결","summary":{"coreSummary":["기본권 판단"]}}',summarized_at=now()
        where id=$1`, [articleId]);
      await pool.query(`select * from article_lifecycle_transition_p2(
        $1,0,'full-init','system','catalog-test','system.test','test.initialize',
        'source_text_ready','complete','unreviewed','keep',null,null,null,null,array[]::text[]
      )`, [articleId]);
      const fullA = await capture(pool, {
        articleId, expected: 1, role: "enrichment_full", anchor: sourceAVersion, sourceHash: "1".repeat(64),
      });
      const fullAVersion = fullA.rows[0].version_id;
      await pool.query("select * from article_p3_candidate_select_v4($1,$2,0)", [articleId, fullAVersion]);
      await p3Transition(pool, {
        articleId,versionRevision: 2,publicationRevision: 0,versionId: fullAVersion,key: "p3-a",state: "published",
      });
      const heads = await pool.query(`select
        (select current_version_id from article_revision_heads_v4 where article_id=$1) global_id,
        (select current_version_id from article_version_heads_p3 where article_id=$1) p3_id,
        (select source_anchor_version_id from case_catalog_publications_v1 where article_id=$1) catalog_id,
        (select version_id from article_publications_p3 where article_id=$1) publication_id`, [articleId]);
      assert.deepEqual(heads.rows[0], {
        global_id: fullAVersion,p3_id: fullAVersion,catalog_id: sourceAVersion,publication_id: fullAVersion,
      });
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id=$1", [articleId])).rows[0].count, 1);

      await pool.query("update articles set original_title='SENTENCIA 53/2024 corrected',summary_json=null,korean_title=null,status='cleaned' where id=$1", [articleId]);
      const sourceB = await capture(pool, { articleId, expected: 2, role: "authoritative_source", sourceHash: "2".repeat(64) });
      const sourceBVersion = sourceB.rows[0].version_id;
      await catalogTransition(pool, { articleId, anchor: sourceBVersion, expected: 1, key: "catalog-b" });
      assert.equal((await pool.query("select catalog_ai_stale_v4 from articles where id=$1", [articleId])).rows[0].catalog_ai_stale_v4, true);
      await assert.rejects(
        pool.query("update articles set catalog_ai_stale_v4=false where id=$1", [articleId]),
        /ARTICLE_CATALOG_STALE_DIRECT_WRITE_FORBIDDEN/,
      );
      assert.equal((await pool.query("select count(*)::integer count from public_article_projection_p3 where id=$1", [articleId])).rows[0].count, 0);
      const fallback = await pool.query("select summary_json,raw_text,error_metadata,enrichment_status,summary_status,summary_available from public_article_detail_v4 where id=$1", [articleId]);
      assert.deepEqual(fallback.rows[0], {
        summary_json: null,raw_text: null,error_metadata: null,enrichment_status: "source_only",
        summary_status: "reprocessing",summary_available: false,
      });

      await pool.query(`update articles set korean_title='교정 판결 요약',status='summarized',
        summary_json='{"koreanTitle":"교정 판결 요약","summary":{"coreSummary":["교정 원문 기반"]}}',summarized_at=now()
        where id=$1`, [articleId]);
      const fullB = await capture(pool, {
        articleId, expected: 3, role: "enrichment_full", anchor: sourceBVersion, sourceHash: "2".repeat(64),
      });
      const fullBVersion = fullB.rows[0].version_id;
      await pool.query("select * from article_p3_candidate_select_v4($1,$2,2)", [articleId, fullBVersion]);
      await assert.rejects(
        p3Transition(pool, {
          articleId,versionRevision: 4,publicationRevision: 1,versionId: fullBVersion,key: "withdraw-wrong",state: "withdrawn",
        }),
        /ARTICLE_P3_WITHDRAW_VERSION_CHANGED/,
      );
      const withdrawn = await p3Transition(pool, {
        articleId,versionRevision: 4,publicationRevision: 1,versionId: fullAVersion,key: "withdraw-right",state: "withdrawn",
      });
      assert.equal(withdrawn.rows[0].publication_state, "withdrawn");
      const kept = await pool.query("select version_id from article_publications_p3 where article_id=$1", [articleId]);
      assert.equal(kept.rows[0].version_id, fullAVersion);
    });

    await t.test("fenced publish pass atomically creates a Gemini-free source-only public article", async () => {
      const opened = await pool.query<{ source_inventory_snapshot_open_v1: string }>(
        "select source_inventory_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          "es-tribunal-constitucional","2024-01-01","2024-12-31","SENTENCIA",
          "official_hj_search_pagination","spain-hj-normalize-v1","spain-hj-gate2-v1",
          "authoritative_enumerated",1,"official-result-count",{ official: true },JSON.stringify([]),"catalog-test",
        ],
      );
      const snapshotId = opened.rows[0].source_inventory_snapshot_open_v1;
      const item = await pool.query<{ source_inventory_item_upsert_v1: string }>(
        "select source_inventory_item_upsert_v1($1,$2,$3,$4,$5,$6)",
        [
          snapshotId,"hj:77777","77777",
          "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/77777","SENTENCIA","2024-06-20",
        ],
      );
      const itemId = item.rows[0].source_inventory_item_upsert_v1;
      await pool.query("select * from source_inventory_snapshot_close_v1($1)", [snapshotId]);
      const fetch = await pool.query<{ id: string }>(`insert into source_fetch_artifacts(
        item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,
        payload_size,replayability,bounded_replay_payload,fetch_contract_version
      ) values($1,'spain-hj-gate2-v1',$2,200,'{}',repeat('4',64),100,'bounded_evidence','{"bounded":true}','spain-hj-fetch-v1') returning id`, [
        itemId,"https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/77777",
      ]);
      const normalizedOutput = {
        sourceKey: "es-tribunal-constitucional",
        jurisdiction: "Spain",
        institutionName: "Tribunal Constitucional de España",
        contentType: "decision",
        originalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/77777",
        canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/77777",
        originalLanguage: "es",
        originalTitle: "SENTENCIA 77/2024",
        originalPublishedAt: "2024-06-20T00:00:00.000Z",
        cleanedText: "texto constitucional ".repeat(80),
        metadata: { resolutionType: "SENTENCIA", decisionDate: "2024-06-20", caseNumber: "77/2024" },
      };
      const normalization = await pool.query<{ id: string }>(`insert into source_normalization_artifacts(
        item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,
        normalized_output_hash,validation_status,validation_errors
      ) values($1,$2,'spain-hj-normalize-v1','case-normalized-v1',$3,repeat('5',64),'valid','[]') returning id`, [
        itemId,fetch.rows[0].id,normalizedOutput,
      ]);
      await pool.query(`update source_backfill_items set status='verified',current_fetch_artifact_id=$2,
        current_normalization_artifact_id=$3,verified_normalization_artifact_id=$3 where id=$1`, [
        itemId,fetch.rows[0].id,normalization.rows[0].id,
      ]);
      await pool.query("select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
        "p1.case-backfill.publish",{ cohort: "catalog-backfill",snapshotId,passNumber: 1,batchLimit: 1 },
        `catalog-publish:${snapshotId}`,`catalog-publish-active:${snapshotId}`,"catalog-test",0,3,1,4,false,
      ]);
      const attempt = await pool.query<{ attempt_id: string; fencing_token: string }>(
        "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
        ["catalog-worker",["p1.case-backfill.publish"],["catalog-backfill"],60],
      );
      const run = await pool.query<{ source_backfill_run_begin_v1: string }>(
        "select source_backfill_run_begin_v1($1,'publish',1,$2,$3)",
        [snapshotId,attempt.rows[0].attempt_id,attempt.rows[0].fencing_token],
      );
      const claimed = await pool.query(
        "select * from source_backfill_items_claim_v1($1,'publish',1,$2,$3,60,null)",
        [snapshotId,attempt.rows[0].attempt_id,attempt.rows[0].fencing_token],
      );
      assert.equal(claimed.rowCount, 1);
      const published = await pool.query<{ article_id: string; version_id: string; article_slug: string }>(
        "select * from case_catalog_publish_backfill_item_v1($1,$2,$3,'catalog-test')",
        [itemId,attempt.rows[0].attempt_id,attempt.rows[0].fencing_token],
      );
      assert.equal(published.rows[0].article_slug, "es-tc-77777");
      const detail = await pool.query(`select slug,korean_title,summary_json,raw_text,error_metadata,
        enrichment_status,summary_status,summary_available,source_metadata
        from public_article_detail_v4 where id=$1`, [published.rows[0].article_id]);
      assert.equal(detail.rowCount, 1);
      assert.equal(detail.rows[0].korean_title, null);
      assert.equal(detail.rows[0].summary_json, null);
      assert.equal(detail.rows[0].raw_text, null);
      assert.equal(detail.rows[0].error_metadata, null);
      assert.equal(detail.rows[0].enrichment_status, "source_only");
      assert.equal(detail.rows[0].summary_status, "pending");
      assert.equal(detail.rows[0].summary_available, false);
      assert.equal(detail.rows[0].source_metadata.collection.publishable, true);
      assert.equal((await pool.query("select count(*)::integer count from article_version_heads_p3 where article_id=$1", [published.rows[0].article_id])).rows[0].count, 0);
      assert.equal((await pool.query("select count(*)::integer count from article_publications_p3 where article_id=$1", [published.rows[0].article_id])).rows[0].count, 0);
      await pool.query("select source_backfill_run_finish_v1($1,$2,$3,'succeeded',1,1,0,0)", [
        run.rows[0].source_backfill_run_begin_v1,attempt.rows[0].attempt_id,attempt.rows[0].fencing_token,
      ]);
      await pool.query("select * from admin_complete_command_attempt_v3($1,$2,'{}')", [
        attempt.rows[0].attempt_id,attempt.rows[0].fencing_token,
      ]);
    });

    await t.test("expired source policy stops Catalog publication", async () => {
      await pool.query(`insert into source_corpus_policies(
        source_key,policy_version,scope_definition,official_scope_url,discovery_methods,authority_hosts,
        redirect_hosts,robots_url,robots_observed_at,robots_rules_hash,license_basis,default_text_access_policy,
        allow_raw_snapshot,normalize_replay_policy,bounded_replay_fields,retention_days,min_request_delay_ms,
        max_concurrency,reviewed_by,reviewed_at,review_due_at
      ) select source_key,'expired-v1',scope_definition,official_scope_url,discovery_methods,authority_hosts,
        redirect_hosts,robots_url,now()-interval '2 years',robots_rules_hash,license_basis,default_text_access_policy,
        allow_raw_snapshot,normalize_replay_policy,bounded_replay_fields,retention_days,min_request_delay_ms,
        max_concurrency,'catalog-test',now()-interval '2 years',now()-interval '1 year'
      from source_corpus_policies where policy_version='spain-hj-gate2-v1'`);
      const articleId = await insertArticle(pool, "expired");
      await seedCaseMetadata(pool, articleId, "expired-v1");
      const source = await capture(pool, { articleId, expected: 0, role: "authoritative_source", sourceHash: "3".repeat(64) });
      await assert.rejects(
        catalogTransition(pool, { articleId, anchor: source.rows[0].version_id, expected: 0, key: "expired" }),
        /SOURCE_POLICY_REVIEW_OVERDUE/,
      );
    });

    await t.test("internal tables are private and authority functions are fixed security definers", async () => {
      const functions = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; public_execute: boolean }>(`
        select p.proname,p.prosecdef,p.proconfig,has_function_privilege('public',p.oid,'execute') public_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in (
          'article_version_capture_v4','article_p3_candidate_select_v4',
          'case_catalog_publication_transition_v1','case_catalog_publish_backfill_item_v1'
        )
      `);
      assert.equal(functions.rowCount, 4);
      for (const row of functions.rows) {
        assert.equal(row.prosecdef, true);
        assert.ok(row.proconfig?.some((value) => value === "search_path=public, extensions, pg_temp"));
        assert.equal(row.public_execute, false);
      }
      await assert.rejects(
        pool.query("update legacy_version_freshness_classifications_v4 set classified_by='changed'"),
        /CASE_CATALOG_IMMUTABLE_RECORD/,
      );
    });
  } finally {
    await pool.end();
  }
});
