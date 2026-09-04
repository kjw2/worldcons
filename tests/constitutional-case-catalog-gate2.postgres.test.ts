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
const caseKeys = vectorFallback(migration("20260826400000_case_keys_and_ranked_pagination.sql"));
const gate1 = migration("20260903120000_constitutional_case_backfill_gate1.sql");
const requestGovernor = migration("20260903181000_constitutional_case_source_request_governor.sql");
const inventoryProvenance = migration("20260903182000_constitutional_case_inventory_provenance.sql");
const phaseAwareSourceHosts = migration("20260903184000_constitutional_case_phase_aware_source_hosts.sql");
const enumerationArtifacts = migration("20260903185000_constitutional_case_enumeration_artifacts.sql");
const gate2 = vectorFallback(migration("20260903130000_constitutional_case_catalog_gate2.sql"));
const gate3 = migration("20260903140000_constitutional_case_search_gate3.sql");
const gate4 = migration("20260903150000_constitutional_case_multilingual_search_gate4.sql");
const providerSearchResilience = vectorFallback(
  migration("20260904100000_cclrag2_provider_search_resilience.sql"),
);
const usCandidates = migration("20260903170000_constitutional_case_us_candidates_gate5.sql");
const usAuthority = migration("20260903171000_constitutional_case_us_authority_gate5.sql");
const usReview = migration("20260903172000_constitutional_case_us_review_gate5.sql");
const usCatalog = migration("20260903173000_constitutional_case_us_catalog_gate5.sql");
const usCanary = migration("20260903174000_constitutional_case_us_catalog_canary_gate5.sql");
const viewSecurity = migration("20260903175000_constitutional_case_catalog_view_security.sql");
const francePublicAttribution = migration("20260903183000_constitutional_case_france_public_attribution.sql");
const germanyPublicAttribution = migration("20260903186000_constitutional_case_germany_public_attribution.sql");
const germanyShadowCanary = migration("20260903187000_constitutional_case_germany_shadow_canary.sql");
const germanyPolicyApproval = migration("20260903188000_constitutional_case_germany_policy_approval.sql");
const germanyOfficialUrlPrefixes = migration("20260903189000_constitutional_case_germany_official_url_prefixes.sql");

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

const usPolicySql = `
insert into source_corpus_policies(
  source_key,policy_version,scope_definition,official_scope_url,discovery_methods,
  authority_hosts,redirect_hosts,robots_url,robots_observed_at,robots_rules_hash,
  license_basis,default_text_access_policy,allow_raw_snapshot,normalize_replay_policy,
  bounded_replay_fields,retention_days,min_request_delay_ms,max_concurrency,
  reviewed_by,reviewed_at,review_due_at
) values (
  'us-constitution-annotated','us-conan-gate5-v1','{"scope":"Table of Cases candidates only"}',
  'https://constitution.congress.gov/resources/cases-cited/',array['reviewed_fixture'],
  array['constitution.congress.gov'],array[]::text[],
  'https://constitution.congress.gov/robots.txt',now(),repeat('d',64),
  'official-public-record','metadata_only',false,'bounded_evidence',
  array['caseName','citation','essayReferences'],3650,1000,1,
  'catalog-test',now(),now()+interval '1 year'
),(
  'us-scotus','us-scotus-gate5-v1','{"scope":"GovInfo U.S. Reports metadata authority"}',
  'https://www.govinfo.gov/help/usreports',array['constitution_annotated_candidate_review'],
  array['www.govinfo.gov'],array[]::text[],
  'https://www.govinfo.gov/robots.txt',now(),repeat('e',64),
  'official-public-record','metadata_only',false,'non_replayable',
  array[]::text[],3650,1000,1,
  'catalog-test',now(),now()+interval '1 year'
);`;

const franceInventoryMetadata = {
  dila: {
    id: "CONSTEXT000050783534",
    nature: "QPC",
    ecli: "ECLI:FR:CC:2024:2024.1115.QPC",
    decisionNumber: "2024-1115",
    qualifiedNature: "QPC",
    archiveMemberPath: "constit/global/CONS/TEXT/00/00/50/78/35/CONSTEXT000050783534.xml",
  },
  stock: {
    filename: "Freemium_constit_global_20250713-140000.tar.gz",
    url: "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz",
    extractedAt: "2025-07-13T14:00:00.000Z",
    lastModified: "Sun, 13 Jul 2025 14:00:00 GMT",
    etag: null,
    contentLength: 12_511_366,
    sha256: "6".repeat(64),
  },
  license: {
    id: "licence-ouverte-2.0",
    url: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
    attribution: "DILA",
  },
};

const germanyOfficialUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html";
const germanyInventoryMetadata = {
  discoveryIndex: "dejure.org",
  discoveryIndexPage: 1,
  discoveryIndexUrl: "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG",
  discoveryRecordUrl: "https://dejure.org/dienste/vernetzung/rechtsprechung?Gericht=BVerfG&Datum=26.03.2024&Aktenzeichen=2+BvR+547%2F21",
  decisionDate: "2024-03-26",
  docket: "2 BvR 547/21",
  docketKey: "2bvr54721",
  officialUrlCandidates: [
    germanyOfficialUrl,
    "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rs20240326_2bvr054721.html",
  ],
  officialUrlResolverVersion: 2,
  officialUrlResolved: true,
  sourceUrlVerified: false,
  authorityVerificationRequired: true,
};

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
      do $roles$
      begin
        if not exists(select 1 from pg_roles where rolname='anon') then
          create role anon nologin;
        end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then
          create role authenticated nologin;
        end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then
          create role service_role nologin bypassrls;
        else
          alter role service_role bypassrls;
        end if;
      end;
      $roles$;
    `);
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
      ),(
        'fr-conseil-constitutionnel','Conseil constitutionnel','France',
        'https://www.conseil-constitutionnel.fr','fr'
      ),(
        'de-bverfg','Bundesverfassungsgericht','Germany',
        'https://www.bundesverfassungsgericht.de','de'
      ),(
        'us-scotus','Supreme Court of the United States','United States',
        'https://www.supremecourt.gov','en'
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
    await setup.query(caseKeys);
    await setup.query(gate1);
    await setup.query(requestGovernor);
    await setup.query(inventoryProvenance);
    await setup.query(phaseAwareSourceHosts);
    await setup.query(enumerationArtifacts);
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
    await setup.query(usCandidates);
    await setup.query(usAuthority);
    await setup.query(usReview);
    await setup.query(usCatalog);
    await setup.query(usCanary);
    await setup.query(usPolicySql);
    await setup.query(gate3);
    await setup.query(gate4);
    await setup.query(viewSecurity);
    await setup.query(francePublicAttribution);
    await setup.query(germanyPublicAttribution);
    await setup.query(germanyShadowCanary);
    await setup.query(germanyPolicyApproval);
    await setup.query(germanyOfficialUrlPrefixes);
    await setup.query(providerSearchResilience);
  } finally {
    await setup.end();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await t.test("provider search materializes a bounded P3 payload without raw text or vectors", async () => {
      const result = await pool.query<{ payload: { items: Array<Record<string, unknown>> } }>(`
        select worldcons_provider_search_v4(
          '', 'fulltext', null::double precision[], 10, 0,
          'es-tribunal-constitucional', null, 'latest', 'none'
        ) payload
      `);
      const item = result.rows[0].payload.items.find((entry) => entry.slug === "legacy-case");
      assert.ok(item);
      assert.equal(item.body_excerpt, "x".repeat(600));
      assert.equal("raw_text" in item, false);
      assert.equal("cleaned_text" in item, false);
      assert.equal("embedding" in item, false);
    });

    await t.test("Germany unattended approval is exact, immutable, and conflict-detecting", async () => {
      const result = await pool.query<{
        policy_version: string;
        scope_definition: { approval: Record<string, unknown> };
        retention_days: number;
        reviewed_by: string;
        reviewed_at: string;
        review_due_at: string;
        robots_rules_hash: string;
      }>(`select policy_version,scope_definition,retention_days,reviewed_by,
        to_char(reviewed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') reviewed_at,
        to_char(review_due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') review_due_at,
        robots_rules_hash
        from source_corpus_policies
        where source_key='de-bverfg' and policy_version='bverfg-unattended-canary-v1'`);
      assert.equal(result.rowCount, 1);
      const policy = result.rows[0];
      assert.equal(policy.retention_days, 90);
      assert.equal(policy.reviewed_by, "WorldCons owner via unattended automatic approval");
      assert.equal(policy.reviewed_at, "2026-09-04T00:00:00Z");
      assert.equal(policy.review_due_at, "2027-03-03T00:00:00Z");
      assert.equal(policy.robots_rules_hash, "7565360aa0562e6f2a86d90f58566885b8bf9106e6e493453f1fc9079837e17f");
      assert.deepEqual(policy.scope_definition.approval, {
        approvalId: "bverfg-unattended-approval-2026-09-04",
        mode: "unattended_automatic",
        authority: "worldcons_owner",
        directiveDate: "2026-09-04",
        boundedEvidenceRetentionDays: 90,
        policyReviewIntervalDays: 180,
        externalIndexAccess: "dejure_listing_discovery_only",
        openLegalDataUse: "excluded_from_first_canary",
        publicTextPosture: "metadata_only",
        publicIntegrityNotice: "bverfg-korean-integrity-v1",
        coverageLabel: "external_index_assisted_no_complete_corpus_claim",
        canaryVisibility: "private_shadow",
        geminiEgress: "denied",
      });

      await pool.query(germanyPolicyApproval);
      await assert.rejects(
        pool.query(`update source_corpus_policies set retention_days=91
          where source_key='de-bverfg' and policy_version='bverfg-unattended-canary-v1'`),
        /CASE_BACKFILL_IMMUTABLE/,
      );
      const approvalBlock = germanyPolicyApproval.match(/do \$approval\$[\s\S]*?\$approval\$;/u)?.[0];
      assert.ok(approvalBlock, "approval migration must contain its conflict-detecting block");
      const conflictClient = await pool.connect();
      try {
        await conflictClient.query("begin");
        await conflictClient.query("alter table source_corpus_policies disable trigger source_corpus_policies_immutable_trigger");
        await conflictClient.query(`update source_corpus_policies set retention_days=91
          where source_key='de-bverfg' and policy_version='bverfg-unattended-canary-v1'`);
        await conflictClient.query("alter table source_corpus_policies enable trigger source_corpus_policies_immutable_trigger");
        await assert.rejects(
          conflictClient.query(approvalBlock),
          /BVERFG_UNATTENDED_POLICY_APPROVAL_CONFLICT/,
        );
      } finally {
        await conflictClient.query("rollback").catch(() => undefined);
        conflictClient.release();
      }
    });

    await t.test("Germany attribution accepts every reviewed BVerfG procedure prefix and rejects unknown filenames", async () => {
      const prefixes = ["rk", "rs", "qk", "qs", "cs", "ls", "es", "fs", "bs"];
      for (const prefix of prefixes) {
        const result = await pool.query<{ valid: boolean }>(
          "select case_catalog_bverfg_official_url_valid_v1($1,'2024-01-22') valid",
          [`https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/01/${prefix}20240122_2bvc001422.html`],
        );
        assert.equal(result.rows[0].valid, true, `${prefix} must be accepted`);
      }
      for (const invalid of [
        "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/01/zz20240122_2bvc001422.html",
        "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/02/cs20240122_2bvc001422.html",
        "https://attacker.example/SharedDocs/Entscheidungen/DE/2024/01/cs20240122_2bvc001422.html",
      ]) {
        const result = await pool.query<{ valid: boolean }>(
          "select case_catalog_bverfg_official_url_valid_v1($1,'2024-01-22') valid",
          [invalid],
        );
        assert.equal(result.rows[0].valid, false, `${invalid} must be rejected`);
      }
    });

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

    await t.test("France Catalog publication requires the exact sealed DILA attribution provenance", async () => {
      await pool.query(`insert into source_corpus_policies(
        source_key,policy_version,scope_definition,official_scope_url,discovery_methods,
        authority_hosts,redirect_hosts,robots_url,robots_observed_at,robots_rules_hash,
        license_basis,default_text_access_policy,allow_raw_snapshot,normalize_replay_policy,
        bounded_replay_fields,retention_days,min_request_delay_ms,max_concurrency,
        reviewed_by,reviewed_at,review_due_at
      ) values (
        'fr-conseil-constitutionnel','fr-dila-attribution-test-v1','{"scope":"2024 QPC"}',
        'https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/',array['official_dila_stock'],
        array['echanges.dila.gouv.fr','www.conseil-constitutionnel.fr'],array[]::text[],
        'https://echanges.dila.gouv.fr/robots.txt',now(),repeat('f',64),
        'licence-ouverte-2.0','full',false,'bounded_evidence',array['metadata'],3650,1000,1,
        'catalog-test',now(),now()+interval '1 year'
      )`);
      const snapshot = await pool.query<{ id: string }>(`select source_inventory_snapshot_open_v1(
        'fr-conseil-constitutionnel','2024-01-01','2024-12-31','QPC','official_dila_stock',
        'fr-dila-parser-v1','fr-dila-attribution-test-v1','authoritative_crosschecked',1,
        'official_dila_stock_and_conseil_facet_exact_identity_set','{"crosschecked":true}'::jsonb,
        '[]'::jsonb,'catalog-test'
      ) id`);
      const snapshotId = snapshot.rows[0].id;
      await pool.query(`select source_inventory_item_upsert_v2(
        $1,'constit:constext000050783534','20241115QPC',
        'https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm',
        'QPC','2024-12-13',$2::jsonb
      )`, [snapshotId, JSON.stringify(franceInventoryMetadata)]);
      const closed = await pool.query<{ manifest_hash: string }>(
        "select manifest_hash from source_inventory_snapshot_close_v2($1)", [snapshotId],
      );

      const createFranceArticle = async (suffix: string) => {
        const created = await pool.query<{ id: string }>(`
          insert into articles(
            source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
            original_language,original_title,original_published_at,status,slug,cleaned_text,source_metadata
          ) values (
            (select id from sources where source_key='fr-conseil-constitutionnel'),
            'fr-conseil-constitutionnel','France','Conseil constitutionnel','decision',
            'https://www.conseil-constitutionnel.fr/decision/2024/'||$1||'.htm',
            'https://www.conseil-constitutionnel.fr/decision/2024/'||$1||'.htm',
            'fr','Décision n° 2024-1115 QPC','2024-12-13T00:00:00Z','cleaned','fr-conseil-'||lower($1),
            repeat('texte ',120),jsonb_build_object('sourceInventory',$2::jsonb)
          ) returning id
        `, [suffix, JSON.stringify(franceInventoryMetadata)]);
        const articleId = created.rows[0].id;
        await pool.query(`insert into case_identifiers_v1(
          article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary
        ) values ($1,'fr-conseil-constitutionnel','source_record_id','decision',$2,
          lower(regexp_replace($2,'[^[:alnum:]]','','g')),true)`, [articleId, suffix]);
        return articleId;
      };
      const captureFrance = async (articleId: string, inventory: Record<string, unknown>) => {
        await pool.query(`insert into case_metadata_v1(
          article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,
          enrichment_status,text_access_policy,source_policy_version,discovery_source,authority_source
        ) values ($1,'fr-conseil-constitutionnel','verified','{}','verified','source_only','full',
          'fr-dila-attribution-test-v1','official_dila_stock','https://www.conseil-constitutionnel.fr')`, [articleId]);
        return pool.query<{ version_id: string }>(`select version_id from article_version_capture_v4(
          $1,0,'authoritative_source',null,repeat('7',64),null,
          jsonb_build_object(
            'authorityStatus','verified','textAccessPolicy','full','sourcePolicyVersion','fr-dila-attribution-test-v1',
            'sourceMetadata',jsonb_build_object('sourceInventory',$2::jsonb)
          ),'[]'::jsonb,repeat('8',64),$3,$4,'import','catalog-test',null,null,null
        )`, [articleId, JSON.stringify(inventory), snapshotId, closed.rows[0].manifest_hash]);
      };

      const validArticleId = await createFranceArticle("20241115QPC");
      const validVersion = await captureFrance(validArticleId, franceInventoryMetadata);
      await catalogTransition(pool, {
        articleId: validArticleId,anchor: validVersion.rows[0].version_id,expected: 0,key: "france-attribution-valid",
      });
      const publicRow = await pool.query<{ source_metadata: { sourceInventory: unknown } }>(
        "select source_metadata from public_case_catalog_projection_v1 where id=$1", [validArticleId],
      );
      assert.deepEqual(publicRow.rows[0].source_metadata.sourceInventory, franceInventoryMetadata);

      const invalidArticleId = await createFranceArticle("20241116QPC");
      const invalidInventory = {
        ...franceInventoryMetadata,
        license: { ...franceInventoryMetadata.license,attribution: "Conseil" },
      };
      assert.equal((await pool.query<{ valid: boolean }>(
        "select case_catalog_france_inventory_attribution_valid_v1($1::jsonb) valid",
        [JSON.stringify(invalidInventory)],
      )).rows[0].valid, false);
      const invalidVersion = await captureFrance(invalidArticleId, franceInventoryMetadata);
      await assert.rejects(
        catalogTransition(pool, {
          articleId: invalidArticleId,anchor: invalidVersion.rows[0].version_id,expected: 0,key: "france-attribution-invalid",
        }),
        /CASE_CATALOG_FRANCE_PUBLIC_ATTRIBUTION_UNSEALED/,
      );
    });

    await t.test("Germany Catalog publication requires sealed BVerfG authority and discover-only index evidence", async () => {
      await pool.query(`insert into source_corpus_policies(
        source_key,policy_version,scope_definition,official_scope_url,discovery_methods,
        authority_hosts,redirect_hosts,external_index_hosts,robots_url,robots_observed_at,robots_rules_hash,
        license_basis,default_text_access_policy,allow_raw_snapshot,normalize_replay_policy,
        bounded_replay_fields,retention_days,min_request_delay_ms,max_concurrency,
        reviewed_by,reviewed_at,review_due_at
      ) values (
        'de-bverfg','bverfg-attribution-test-v1','{"scope":"2024 website publications"}',
        'https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html',
        array['external_index_dejure_paged_listing'],array['www.bundesverfassungsgericht.de'],
        array['www.bverfg.de'],array['dejure.org'],'https://www.bundesverfassungsgericht.de/robots.txt',
        now(),repeat('1',64),'official-public-record','metadata_only',false,'bounded_evidence',
        array['metadata'],3650,30000,1,'catalog-test',now(),now()+interval '1 year'
      )`);
      const snapshot = await pool.query<{ id: string }>(`select source_inventory_snapshot_open_v1(
        'de-bverfg','2024-01-01','2024-12-31','DECISION','external_index_dejure_paged_listing',
        'bverfg-official-normalize-v1','bverfg-attribution-test-v1','external_index_assisted',null,null,
        '{"officialCorpusCoverageClaimed":false,"crossedOlderBoundary":true,"firstPageProbeStable":true}'::jsonb,
        '[]'::jsonb,'catalog-test'
      ) id`);
      const snapshotId = snapshot.rows[0].id;
      const stableItemKey = "dejure:2024-03-26:2bvr54721";
      await pool.query(`select source_inventory_item_upsert_v2(
        $1,$2,null,$3,'DECISION','2024-03-26',$4::jsonb
      )`, [snapshotId, stableItemKey, germanyOfficialUrl, JSON.stringify(germanyInventoryMetadata)]);
      for (const [kind, sequence] of [["page", 1], ["boundary_probe", 1]] as const) {
        await pool.query(`insert into source_inventory_enumeration_artifacts(
          snapshot_id,source_key,provider_key,artifact_kind,sequence_no,request_url,
          response_hash,record_manifest_hash,record_count,newest_decision_date,oldest_decision_date,
          observed_last_page,safe_details
        ) values($1,'de-bverfg','dejure.org',$2,$3,
          'https://dejure.org/dienste/rechtsprechung?gericht=BVerfG',repeat($4,64),repeat($5,64),1,
          '2024-03-26','2024-03-26',425,'{"storesExternalText":false}'::jsonb
        )`, [snapshotId, kind, sequence, kind === "page" ? "2" : "3", kind === "page" ? "4" : "5"]);
      }
      const closed = await pool.query<{ manifest_hash: string }>(
        "select manifest_hash from source_inventory_snapshot_close_v3($1)", [snapshotId],
      );
      const article = await pool.query<{ id: string }>(`insert into articles(
        source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
        original_language,original_title,original_published_at,status,slug,source_metadata
      ) values(
        (select id from sources where source_key='de-bverfg'),'de-bverfg','Germany','Bundesverfassungsgericht',
        'decision',$1,$1,'de','Beschluss vom 26. März 2024','2024-03-26','metadata_only',
        'de-bverfg-attribution-test','{}'::jsonb
      ) returning id`, [germanyOfficialUrl]);
      const articleId = article.rows[0].id;
      await pool.query(`insert into case_metadata_v1(
        article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,
        enrichment_status,text_access_policy,source_policy_version,discovery_source,authority_source
      ) values($1,'de-bverfg','verified','{}','verified','source_only','metadata_only',
        'bverfg-attribution-test-v1','external_index_dejure_paged_listing',$2)`, [articleId, germanyOfficialUrl]);
      await pool.query(`insert into case_identifiers_v1(
        article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary,provenance_url
      ) values($1,'de-bverfg','source_record_id','decision',$2,$3,true,$4)`, [
        articleId,stableItemKey,stableItemKey.replace(/[^a-z0-9]/gu, ""),germanyOfficialUrl,
      ]);
      const capture = async (expected: number, inventory: Record<string, unknown>, sourceHash: string) => pool.query<{ version_id: string }>(`
        select version_id from article_version_capture_v4(
          $1,$2,'authoritative_source',null,$3,null,
          jsonb_build_object(
            'authorityStatus','verified','textAccessPolicy','metadata_only','sourcePolicyVersion','bverfg-attribution-test-v1',
            'sourceMetadata',jsonb_build_object('sourceInventory',$4::jsonb)
          ),'[]'::jsonb,repeat('6',64),$5,$6,'import','catalog-test',null,null,null
        )`, [articleId,expected,sourceHash,JSON.stringify(inventory),snapshotId,closed.rows[0].manifest_hash]);

      const validVersion = await capture(0, germanyInventoryMetadata, "7".repeat(64));
      await catalogTransition(pool, {
        articleId,anchor: validVersion.rows[0].version_id,expected: 0,key: "germany-attribution-valid",
      });
      const publicRow = await pool.query<{ source_metadata: { sourceInventory: unknown } }>(
        "select source_metadata from public_case_catalog_projection_v1 where id=$1", [articleId],
      );
      assert.deepEqual(publicRow.rows[0].source_metadata.sourceInventory, germanyInventoryMetadata);

      const invalidVersion = await capture(1, {
        ...germanyInventoryMetadata,
        discoveryIndex: "authority.invalid",
      }, "8".repeat(64));
      await assert.rejects(
        catalogTransition(pool, {
          articleId,anchor: invalidVersion.rows[0].version_id,expected: 1,key: "germany-attribution-invalid",
        }),
        /CASE_CATALOG_GERMANY_PUBLIC_ATTRIBUTION_UNSEALED/,
      );
      const privileges = await pool.query(`select
        has_function_privilege('public','case_catalog_germany_inventory_attribution_valid_v1(jsonb,text)','execute') inventory_public,
        has_function_privilege('public','case_catalog_germany_public_attribution_guard_v1()','execute') guard_public,
        has_function_privilege('public','case_backfill_bverfg_shadow_canary_v1(uuid)','execute') canary_public`);
      assert.deepEqual(privileges.rows[0], { inventory_public: false,guard_public: false,canary_public: false });
      const canary = await pool.query<{ evidence: Record<string, unknown> }>(
        "select case_backfill_bverfg_shadow_canary_v1($1) evidence", [snapshotId],
      );
      assert.equal(canary.rows[0].evidence.snapshotFound, true);
      assert.equal(Number(canary.rows[0].evidence.pageArtifactCount), 1);
      assert.equal(Number(canary.rows[0].evidence.boundaryProbeCount), 1);
      assert.equal(Number(canary.rows[0].evidence.catalogPublicationCount), 1);
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

    await t.test("evidence-bound US review publishes one metadata-only authoritative Catalog anchor", async () => {
      const opened = await pool.query<{ us_conan_candidate_snapshot_open_v1: string }>(
        "select us_conan_candidate_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7)",
        [
          "us-conan-gate5-v1","a".repeat(64),"us-conan-table-v1","reviewed_fixture",
          "best_effort","2026-09-03T08:00:00.000Z","catalog-test",
        ],
      );
      const candidateSnapshotId = opened.rows[0].us_conan_candidate_snapshot_open_v1;
      const candidate = await pool.query<{ us_conan_candidate_upsert_v1: string }>(
        "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          candidateSnapshotId,"conan:baker","Baker v. Carr","369 U.S. 186 (1962)",
          "369 U.S. 186 (1962)","scotus_candidate",100,["reviewed_redistricting_landmark_seed"],
          JSON.stringify([{
            essayId: "ALDE_00001001",
            title: "Congressional Districting",
            url: "https://constitution.congress.gov/browse/essay/artI-S2-C1-1/ALDE_00001001/",
          }]),
        ],
      );
      const candidateId = candidate.rows[0].us_conan_candidate_upsert_v1;
      const closed = await pool.query<{ manifest_hash: string }>(
        "select * from us_conan_candidate_snapshot_close_v1($1)", [candidateSnapshotId],
      );
      const authority = await pool.query<{ us_conan_candidate_authority_record_v1: string }>(
        "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          candidateId,"govinfo-usreports-v1","verified","369 U.S. 186 (1962)",
          "Baker et al. v. Carr et al.",
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
          "f".repeat(64),[],"2026-09-03T09:00:00.000Z",
        ],
      );
      const essay = await pool.query<{ id: string }>(
        "select id from us_conan_candidate_essay_evidence_v1 where candidate_id=$1", [candidateId],
      );
      const review = await pool.query<{ review_id: string; review_revision: number }>(
        "select * from us_conan_candidate_review_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          candidateId,0,"verified",true,true,true,true,
          authority.rows[0].us_conan_candidate_authority_record_v1,
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          [essay.rows[0].id],JSON.stringify([{
            sourceUrl: "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
            locator: "pp. 208-237",
            constitutionalQuestion: "Whether legislative apportionment claims present a justiciable federal constitutional question.",
          }]),{ essayId: "ALDE_00001001" },"catalog-test","All four evidence gates were reviewed.",
        ],
      );
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_publish_catalog_v1($1,$2,$3,$4,$5,$6)",
          [candidateId,2,"us-scotus-gate5-v1",0,"us-conan:baker:stale-review","catalog-test"],
        ),
        /US_CONAN_CATALOG_REVIEW_STALE/,
      );
      const published = await pool.query<{
        event_id: string;
        article_id: string;
        version_id: string;
        version_revision: string;
        publication_revision: string;
        article_slug: string;
        applied: boolean;
        idempotent: boolean;
      }>(
        "select * from us_conan_candidate_publish_catalog_v1($1,$2,$3,$4,$5,$6)",
        [candidateId,1,"us-scotus-gate5-v1",0,"us-conan:baker:review-1","catalog-test"],
      );
      assert.equal(published.rows[0].article_slug, "us-scotus-369-us-186");
      assert.equal(published.rows[0].applied, true);
      assert.equal(published.rows[0].idempotent, false);
      const detail = await pool.query(`select source_key,original_title,original_published_at,
        cleaned_text,summary_json,enrichment_status,summary_status,summary_available,source_metadata
        from public_article_detail_v4 where id=$1`, [published.rows[0].article_id]);
      assert.equal(detail.rowCount, 1);
      assert.equal(detail.rows[0].source_key, "us-scotus");
      assert.equal(detail.rows[0].original_title, "Baker et al. v. Carr et al.");
      assert.equal(detail.rows[0].original_published_at, null);
      assert.equal(detail.rows[0].cleaned_text, null);
      assert.equal(detail.rows[0].summary_json, null);
      assert.equal(detail.rows[0].enrichment_status, "source_only");
      assert.equal(detail.rows[0].summary_status, "pending");
      assert.equal(detail.rows[0].summary_available, false);
      assert.equal(detail.rows[0].source_metadata.reporterCitation, "369 U.S. 186 (1962)");
      assert.equal(detail.rows[0].source_metadata.decisionDate.status, "unknown");
      assert.deepEqual(detail.rows[0].source_metadata.constitutionAnnotated.essays.map(
        (item: { essayId: string }) => item.essayId,
      ), ["ALDE_00001001"]);
      const version = await pool.query(`select version_role,source_anchor_version_id,source_snapshot_id,
        source_snapshot_hash,source_content_hash,summary_json,embedding
        from article_content_versions_p3 where id=$1`, [published.rows[0].version_id]);
      assert.equal(version.rows[0].version_role, "authoritative_source");
      assert.equal(version.rows[0].source_anchor_version_id, published.rows[0].version_id);
      assert.equal(version.rows[0].source_snapshot_id, null);
      assert.equal(version.rows[0].source_snapshot_hash, closed.rows[0].manifest_hash);
      assert.equal(version.rows[0].source_content_hash, "f".repeat(64));
      assert.equal(version.rows[0].summary_json, null);
      assert.equal(version.rows[0].embedding, null);
      const identifiers = await pool.query<{ identifier_type: string; normalized_value: string; is_primary: boolean }>(
        "select identifier_type,normalized_value,is_primary from case_identifiers_v1 where article_id=$1 order by identifier_type",
        [published.rows[0].article_id],
      );
      assert.deepEqual(identifiers.rows, [
        { identifier_type: "reporter_citation", normalized_value: "369us1861962", is_primary: true },
        { identifier_type: "source_record_id", normalized_value: "usreports369186", is_primary: false },
      ]);
      const bridge = await pool.query("select review_id,authority_artifact_id,candidate_snapshot_id from us_conan_candidate_catalog_events_v1 where id=$1", [published.rows[0].event_id]);
      assert.deepEqual(bridge.rows[0], {
        review_id: review.rows[0].review_id,
        authority_artifact_id: authority.rows[0].us_conan_candidate_authority_record_v1,
        candidate_snapshot_id: candidateSnapshotId,
      });
      assert.equal((await pool.query("select count(*)::integer count from article_version_heads_p3 where article_id=$1", [published.rows[0].article_id])).rows[0].count, 0);
      assert.equal((await pool.query("select count(*)::integer count from article_publications_p3 where article_id=$1", [published.rows[0].article_id])).rows[0].count, 0);
      const canary = await pool.query<{ payload: Record<string, unknown> }>(
        "select us_conan_candidate_catalog_canary_v1($1) payload", [candidateId],
      );
      assert.equal(canary.rows[0].payload.candidateFound, true);
      assert.equal(canary.rows[0].payload.currentReviewId, review.rows[0].review_id);
      assert.equal(canary.rows[0].payload.currentAuthorityArtifactId, authority.rows[0].us_conan_candidate_authority_record_v1);
      assert.equal(canary.rows[0].payload.eventId, published.rows[0].event_id);
      assert.equal(canary.rows[0].payload.catalogSourceAnchorVersionId, published.rows[0].version_id);
      assert.equal(canary.rows[0].payload.sourceAnchorSelfId, published.rows[0].version_id);
      assert.equal(canary.rows[0].payload.sourceAnchorSummaryPresent, false);
      assert.equal(canary.rows[0].payload.sourceAnchorEmbeddingPresent, false);
      assert.equal(canary.rows[0].payload.publicDetailVersionRole, "authoritative_source");
      assert.equal(canary.rows[0].payload.publicDetailSummaryAvailable, false);
      const exact = await pool.query<{ payload: { entries: Array<{ id: string }>; retrievalMode: string } }>(
        "select worldcons_case_search_page_v2($1,10,null) payload", ["369 U.S. 186 (1962)"],
      );
      assert.equal(exact.rows[0].payload.retrievalMode, "exact-identity");
      assert.deepEqual(exact.rows[0].payload.entries.map((entry) => entry.id), [published.rows[0].article_id]);

      const retry = await pool.query(
        "select * from us_conan_candidate_publish_catalog_v1($1,$2,$3,$4,$5,$6)",
        [candidateId,1,"us-scotus-gate5-v1",0,"us-conan:baker:review-1","catalog-test"],
      );
      assert.equal(retry.rows[0].event_id, published.rows[0].event_id);
      assert.equal(retry.rows[0].applied, false);
      assert.equal(retry.rows[0].idempotent, true);
      assert.equal((await pool.query("select count(*)::integer count from us_conan_candidate_catalog_events_v1 where candidate_id=$1", [candidateId])).rows[0].count, 1);
      await assert.rejects(
        pool.query("update us_conan_candidate_catalog_events_v1 set actor_id='tampered' where id=$1", [published.rows[0].event_id]),
        /CASE_CATALOG_IMMUTABLE_RECORD/,
      );

      await pool.query(`insert into source_corpus_policies(
        source_key,policy_version,scope_definition,official_scope_url,discovery_methods,authority_hosts,
        redirect_hosts,robots_url,robots_observed_at,robots_rules_hash,license_basis,default_text_access_policy,
        allow_raw_snapshot,normalize_replay_policy,bounded_replay_fields,retention_days,min_request_delay_ms,
        max_concurrency,reviewed_by,reviewed_at,review_due_at
      ) select source_key,'us-scotus-expired-v1',scope_definition,official_scope_url,discovery_methods,authority_hosts,
        redirect_hosts,robots_url,now()-interval '2 years',robots_rules_hash,license_basis,default_text_access_policy,
        allow_raw_snapshot,normalize_replay_policy,bounded_replay_fields,retention_days,min_request_delay_ms,
        max_concurrency,'catalog-test',now()-interval '2 years',now()-interval '1 year'
      from source_corpus_policies where source_key='us-scotus' and policy_version='us-scotus-gate5-v1'`);
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_publish_catalog_v1($1,$2,$3,$4,$5,$6)",
          [candidateId,1,"us-scotus-expired-v1",1,"us-conan:baker:expired-policy","catalog-test"],
        ),
        /SOURCE_POLICY_REVIEW_OVERDUE/,
      );
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
          'case_catalog_publication_transition_v1','case_catalog_publish_backfill_item_v1',
          'us_conan_candidate_publish_catalog_v1','us_conan_candidate_catalog_canary_v1'
        )
      `);
      assert.equal(functions.rowCount, 6);
      for (const row of functions.rows) {
        assert.equal(row.prosecdef, true);
        assert.ok(row.proconfig?.some((value) => value === "search_path=public, extensions, pg_temp"));
        assert.equal(row.public_execute, false);
      }
      await assert.rejects(
        pool.query("update legacy_version_freshness_classifications_v4 set classified_by='changed'"),
        /CASE_CATALOG_IMMUTABLE_RECORD/,
      );
      assert.equal((await pool.query(
        "select has_table_privilege('public','us_conan_candidate_catalog_events_v1','select') allowed",
      )).rows[0].allowed, false);
    });

    await t.test("Catalog views use invoker permissions and expose no direct anon database surface", async () => {
      const views = await pool.query<{ relname: string; reloptions: string[] | null }>(`
        select c.relname,c.reloptions
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname in (
          'public_case_catalog_projection_v1','public_article_detail_v4','public_case_search_documents_v1'
        ) order by c.relname
      `);
      assert.equal(views.rowCount, 3);
      for (const view of views.rows) {
        assert.ok(view.reloptions?.includes("security_invoker=true"), `${view.relname} must use invoker rights`);
        assert.equal((await pool.query("select has_table_privilege('anon',$1,'select') allowed", [view.relname])).rows[0].allowed, false);
        assert.equal((await pool.query("select has_table_privilege('authenticated',$1,'select') allowed", [view.relname])).rows[0].allowed, false);
        assert.equal((await pool.query("select has_table_privilege('service_role',$1,'select') allowed", [view.relname])).rows[0].allowed, true);
      }

      const serviceClient = await pool.connect();
      try {
        await serviceClient.query("set role service_role");
        assert.ok((await serviceClient.query("select id from public.public_article_detail_v4 limit 1")).rowCount);
        assert.ok((await serviceClient.query("select id from public.public_case_search_documents_v1 limit 1")).rowCount);
        await assert.rejects(
          serviceClient.query("select raw_text from public.article_content_versions_p3 limit 1"),
          /permission denied/,
        );
        await serviceClient.query("reset role");

        await serviceClient.query("set role anon");
        await assert.rejects(
          serviceClient.query("select id from public.public_article_detail_v4 limit 1"),
          /permission denied/,
        );
        await serviceClient.query("reset role");
      } finally {
        await serviceClient.query("reset role").catch(() => undefined);
        serviceClient.release();
      }
    });

    await t.test("Gate 4 preserves Gate 3 source-only identity and lexical search", async () => {
      const articleId = await insertArticle(pool, "88");
      await pool.query(`update articles set
        search_vector=to_tsvector('simple','SENTENCIA 88/2024 libertad de expresion'),
        cleaned_text='La libertad de expresion constitucional',original_published_at='2024-06-01T00:00:00Z'
        where id=$1`, [articleId]);
      await seedCaseMetadata(pool, articleId);
      await pool.query(`insert into case_identifiers_v1(
        article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary
      ) values($1,'es-tribunal-constitucional','decision_number','decision','88/2024','882024',true)`, [articleId]);
      const source = await capture(pool, {
        articleId,expected: 0,role: "authoritative_source",sourceHash: "4".repeat(64),
      });
      await catalogTransition(pool, { articleId,anchor: source.rows[0].version_id,expected: 0,key: "search-88" });

      const exact = await pool.query<{ payload: {
        entries: Array<{ id: string; matchType: string; enrichmentStatus: string; summaryAvailable: boolean }>;
        retrievalMode: string;
      } }>("select worldcons_case_search_page_v2($1,10,null) payload", ["88/2024"]);
      assert.equal(exact.rows[0].payload.retrievalMode, "exact-identity");
      assert.deepEqual(exact.rows[0].payload.entries, [{
        id: articleId,score: 997,matchType: "exact-identity",enrichmentStatus: "source_only",
        enrichmentFreshness: null,summaryStatus: "pending",summaryAvailable: false,
      }]);

      const lexical = await pool.query<{ payload: { entries: Array<{ id: string }>; retrievalMode: string } }>(
        "select worldcons_case_search_page_v2($1,10,null) payload", ["libertad"],
      );
      assert.equal(lexical.rows[0].payload.retrievalMode, "rrf");
      assert.deepEqual(lexical.rows[0].payload.entries.map((entry) => entry.id), [articleId]);
      assert.equal((await pool.query("select count(*)::integer count from public_case_search_documents_v1 where id=$1", [articleId])).rows[0].count, 1);
    });

    await t.test("Gate 4 keyset cursor is deterministic, bounded, and query-bound", async () => {
      const ids: string[] = [];
      for (const [suffix, date] of [["201","2024-03-03"],["202","2024-03-02"],["203","2024-03-01"]]) {
        const articleId = await insertArticle(pool, suffix);
        ids.push(articleId);
        await pool.query(`update articles set search_vector=to_tsvector('simple','control constitucional comun'),
          cleaned_text='control constitucional comun',original_published_at=$2 where id=$1`, [articleId, date]);
        await seedCaseMetadata(pool, articleId);
        const source = await capture(pool, {
          articleId,expected: 0,role: "authoritative_source",sourceHash: suffix[2].repeat(64),
        });
        await catalogTransition(pool, { articleId,anchor: source.rows[0].version_id,expected: 0,key: `search-${suffix}` });
      }

      const first = await pool.query<{ payload: {
        entries: Array<{ id: string }>;
        nextCursor: string;
        hasMore: boolean;
        rankingVersion: string;
      } }>("select worldcons_case_search_page_v2($1,2,null) payload", ["control"]);
      assert.equal(first.rows[0].payload.entries.length, 2);
      assert.equal(first.rows[0].payload.hasMore, true);
      assert.match(first.rows[0].payload.rankingVersion, /^gate4-multilingual-rrf-v1:/u);
      assert.match(first.rows[0].payload.nextCursor, /^[A-Za-z0-9_-]+$/u);

      const second = await pool.query<{ payload: { entries: Array<{ id: string }>; hasMore: boolean } }>(
        "select worldcons_case_search_page_v2($1,2,$2) payload",
        ["control",first.rows[0].payload.nextCursor],
      );
      assert.equal(second.rows[0].payload.entries.length, 1);
      assert.equal(second.rows[0].payload.hasMore, false);
      assert.equal(new Set([...first.rows[0].payload.entries,...second.rows[0].payload.entries].map((entry) => entry.id)).size, 3);
      assert.deepEqual(new Set([...first.rows[0].payload.entries,...second.rows[0].payload.entries].map((entry) => entry.id)), new Set(ids));
      await assert.rejects(
        pool.query("select worldcons_case_search_page_v2($1,2,$2)", ["otro",first.rows[0].payload.nextCursor]),
        /WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH/,
      );
      await assert.rejects(
        pool.query("select worldcons_case_search_page_v2($1,2,$2)", ["control","not-a-valid-cursor!"]),
        /WORLDCONS_CASE_SEARCH_INVALID_CURSOR/,
      );
    });

    await t.test("Gate 4 reviewed aliases expand five languages with bounded RRF and jurisdiction diversity", async () => {
      const aliasSet = await pool.query<{ id: string }>(`insert into legal_concept_alias_sets_v1(
        set_version,provenance
      ) values('constitutional-multilingual-test-v1','reviewed PostgreSQL fixture') returning id`);
      const concept = await pool.query<{ id: string }>(`insert into legal_concepts_v1(
        alias_set_id,stable_key,label_ko,definition
      ) values($1,'gerrymandering','게리맨더링','선거구 획정 왜곡에 관한 비교헌법 개념') returning id`, [aliasSet.rows[0].id]);
      const aliases = [
        ["ko","게리맨더링","preferred"],
        ["en","gerrymandering","preferred"],
        ["de","Wahlkreiseinteilung","translated"],
        ["fr","découpage électoral","translated"],
        ["es","delimitación electoral","translated"],
      ];
      for (const [language, rawAlias, aliasType] of aliases) {
        await pool.query(`insert into legal_concept_aliases_v1(
          alias_set_id,concept_id,language,raw_alias,normalized_alias,alias_type,provenance,review_status
        ) values($1,$2,$3,$4,worldcons_legal_alias_normalize_v1($4),$5,'Gate 4 reviewed fixture','approved')`, [
          aliasSet.rows[0].id,concept.rows[0].id,language,rawAlias,aliasType,
        ]);
      }
      await pool.query(`update legal_concept_alias_sets_v1 set
        status='reviewed',reviewed_by='catalog-test',reviewed_at='2026-09-03T00:00:00Z'
        where id=$1`, [aliasSet.rows[0].id]);

      const caseRows: Array<{ id: string; jurisdiction: string }> = [];
      const documents = [
        ["gerry-ko","게리맨더링 gerrymandering 선거구", "Spain", "ko", "2024-06-10"],
        ["gerry-en","gerrymandering voting district", "Spain", "en", "2024-06-09"],
        ["gerry-de","Wahlkreiseinteilung Wahlrecht", "Spain", "de", "2024-06-08"],
        ["gerry-fr","découpage électoral élections", "France", "fr", "2024-06-01"],
        ["gerry-es","delimitación electoral elecciones", "Spain", "es", "2024-05-31"],
      ];
      for (const [suffix, text, jurisdiction, language, date] of documents) {
        const articleId = await insertArticle(pool, suffix);
        caseRows.push({ id: articleId, jurisdiction });
        await pool.query(`update articles set jurisdiction=$2,original_language=$3,
          search_vector=to_tsvector('simple',$4),cleaned_text=$4,original_published_at=$5 where id=$1`, [
          articleId,jurisdiction,language,text,date,
        ]);
        await seedCaseMetadata(pool, articleId);
        const source = await capture(pool, {
          articleId,expected: 0,role: "authoritative_source",sourceHash: `${caseRows.length}`.repeat(64),
        });
        await catalogTransition(pool, {
          articleId,anchor: source.rows[0].version_id,expected: 0,key: `search-${suffix}`,
        });
      }

      for (const query of ["게리맨더링","gerrymandering","Wahlkreiseinteilung","découpage électoral","delimitación electoral"]) {
        const result = await pool.query<{ payload: {
          entries: Array<{ id: string; matchType: string }>;
          retrievalMode: string;
          rankingVersion: string;
        } }>("select worldcons_case_search_page_v2($1,20,null) payload", [query]);
        assert.equal(result.rows[0].payload.retrievalMode, "rrf");
        assert.match(result.rows[0].payload.rankingVersion, /^gate4-multilingual-rrf-v1:constitutional-multilingual-test-v1:/u);
        assert.deepEqual(new Set(result.rows[0].payload.entries.map((entry) => entry.id)), new Set(caseRows.map((row) => row.id)));
        assert.ok(result.rows[0].payload.entries.every((entry) => entry.matchType === "rrf"));
      }

      const diversified = await pool.query<{ payload: { entries: Array<{ id: string }> } }>(
        "select worldcons_case_search_page_v2('게리맨더링',3,null) payload",
      );
      const jurisdictionById = new Map(caseRows.map((row) => [row.id, row.jurisdiction]));
      assert.ok(new Set(diversified.rows[0].payload.entries.map((entry) => jurisdictionById.get(entry.id))).size >= 2);

      const absent = await pool.query<{ payload: { entries: unknown[] } }>(
        "select worldcons_case_search_page_v2('존재하지않는법률개념',20,null) payload",
      );
      assert.equal(absent.rows[0].payload.entries.length, 0);
      await assert.rejects(
        pool.query("update legal_concept_aliases_v1 set raw_alias='변조' where alias_set_id=$1", [aliasSet.rows[0].id]),
        /WORLDCONS_REVIEWED_ALIAS_SET_IMMUTABLE/,
      );
    });

    await t.test("Gate 4 expires cursors when the reviewed alias ranking input changes", async () => {
      const first = await pool.query<{ payload: { nextCursor: string } }>(
        "select worldcons_case_search_page_v2('control',1,null) payload",
      );
      assert.ok(first.rows[0].payload.nextCursor);

      const replacement = await pool.query<{ id: string }>(`insert into legal_concept_alias_sets_v1(
        set_version,provenance,supersedes_alias_set_id
      ) values('constitutional-multilingual-test-v2','reviewed PostgreSQL replacement',(
        select id from legal_concept_alias_sets_v1 where status='reviewed' order by reviewed_at desc,id desc limit 1
      )) returning id`);
      const concept = await pool.query<{ id: string }>(`insert into legal_concepts_v1(
        alias_set_id,stable_key,label_ko
      ) values($1,'proportionality','비례원칙') returning id`, [replacement.rows[0].id]);
      for (const [language, rawAlias] of [["ko","비례원칙"],["en","proportionality"]]) {
        await pool.query(`insert into legal_concept_aliases_v1(
          alias_set_id,concept_id,language,raw_alias,normalized_alias,alias_type,provenance,review_status
        ) values($1,$2,$3,$4,worldcons_legal_alias_normalize_v1($4),'preferred','Gate 4 replacement','approved')`, [
          replacement.rows[0].id,concept.rows[0].id,language,rawAlias,
        ]);
      }
      await pool.query(`update legal_concept_alias_sets_v1 set
        status='reviewed',reviewed_by='catalog-test',reviewed_at='2026-09-04T00:00:00Z'
        where id=$1`, [replacement.rows[0].id]);

      await assert.rejects(
        pool.query("select worldcons_case_search_page_v2('control',1,$1)", [first.rows[0].payload.nextCursor]),
        /WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED/,
      );
    });

    await t.test("Gate 4 search authority and reviewed aliases are private and statement-bounded", async () => {
      const authority = await pool.query<{ prosecdef: boolean; proconfig: string[]; public_execute: boolean }>(`
        select p.prosecdef,p.proconfig,has_function_privilege('public',p.oid,'execute') public_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='worldcons_case_search_page_v2'
      `);
      assert.equal(authority.rowCount, 1);
      assert.equal(authority.rows[0].prosecdef, true);
      assert.ok(authority.rows[0].proconfig.includes("search_path=public, extensions, pg_temp"));
      assert.ok(authority.rows[0].proconfig.some((value) => value.startsWith("statement_timeout=")));
      assert.equal(authority.rows[0].public_execute, false);
      assert.equal((await pool.query("select has_table_privilege('public','public_case_search_documents_v1','select') allowed")).rows[0].allowed, false);
      assert.equal((await pool.query("select has_table_privilege('public','legal_concept_aliases_v1','select') allowed")).rows[0].allowed, false);
    });
  } finally {
    await pool.end();
  }
});
