import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";

const databaseUrl = process.env.BACKFILL_TEST_DATABASE_URL;
const p0Migration = path.join(process.cwd(), "supabase/migrations/20260712090000_admin_command_control_plane.sql");
const p1Migration = path.join(process.cwd(), "supabase/migrations/20260712130000_admin_command_worker_p1.sql");
const gate1Migration = path.join(process.cwd(), "supabase/migrations/20260903120000_constitutional_case_backfill_gate1.sql");
const requestGovernorMigration = path.join(process.cwd(), "supabase/migrations/20260903181000_constitutional_case_source_request_governor.sql");
const phaseAwareHostsMigration = path.join(process.cwd(), "supabase/migrations/20260903184000_constitutional_case_phase_aware_source_hosts.sql");
const franceGate5Migration = path.join(process.cwd(), "supabase/migrations/20260903160000_constitutional_case_france_gate5.sql");
const usCandidateGate5Migration = path.join(process.cwd(), "supabase/migrations/20260903170000_constitutional_case_us_candidates_gate5.sql");
const usAuthorityGate5Migration = path.join(process.cwd(), "supabase/migrations/20260903171000_constitutional_case_us_authority_gate5.sql");
const usReviewGate5Migration = path.join(process.cwd(), "supabase/migrations/20260903172000_constitutional_case_us_review_gate5.sql");
const inventoryProvenanceMigration = path.join(process.cwd(), "supabase/migrations/20260903182000_constitutional_case_inventory_provenance.sql");

const policyInsert = `
insert into source_corpus_policies(
  source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
  authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
  terms_url, terms_observed_at, license_basis, default_text_access_policy,
  allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days,
  min_request_delay_ms, max_concurrency, reviewed_by, reviewed_at, review_due_at
) values (
  'es-tribunal-constitucional', 'spain-hj-test-v1', '{"scope":"2024 SENTENCIA"}',
  'https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index', array['official_search'],
  array['hj.tribunalconstitucional.es'], '{}',
  'https://hj.tribunalconstitucional.es/robots.txt', now(), repeat('a', 64),
  null, null, 'official-public-record', 'full', false, 'bounded_evidence',
  array['sourceKey','url','canonicalUrl','title','publishedAt','contentType','text','metadata.resolutionType','metadata.decisionDate','metadata.sourceRecordId'],
  3650, 1000, 1, 'postgres-test', now(), now() + interval '1 year'
);`;

test("Gate 1 PostgreSQL contracts enforce manifests, P1 fences, leases, and claim release", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const database = await client.query<{ current_database: string }>("select current_database()");
    assert.match(database.rows[0].current_database, /backfill/i, "Backfill tests refuse to reset a database whose name does not contain backfill");
    await client.query(`do $role$ begin
      if not exists(select 1 from pg_roles where rolname='service_role') then
        create role service_role nologin;
      end if;
    end $role$`);
    await client.query("drop schema public cascade; create schema public; drop schema if exists extensions cascade; create schema extensions");
    await client.query("create extension if not exists pgcrypto with schema extensions");
    await client.query(fs.readFileSync(p0Migration, "utf8"));
    await client.query(`create table source_url_candidates(
      id uuid primary key default gen_random_uuid(), source_key text not null, url text not null,
      candidate_type text not null, discovered_by text not null, status text not null default 'pending',
      last_attempt_at timestamptz, attempt_count integer not null default 0,
      last_error_code text, last_error_message text, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`);
    await client.query(fs.readFileSync(p1Migration, "utf8"));
    await client.query("create table articles(id uuid primary key default gen_random_uuid())");
    await client.query(fs.readFileSync(gate1Migration, "utf8"));
    await client.query(fs.readFileSync(requestGovernorMigration, "utf8"));
    await client.query(fs.readFileSync(phaseAwareHostsMigration, "utf8"));
    await client.query(fs.readFileSync(franceGate5Migration, "utf8"));
    await client.query(fs.readFileSync(usCandidateGate5Migration, "utf8"));
    await client.query(fs.readFileSync(usAuthorityGate5Migration, "utf8"));
    await client.query(fs.readFileSync(usReviewGate5Migration, "utf8"));
    await client.query(fs.readFileSync(inventoryProvenanceMigration, "utf8"));
  } finally {
    await client.end();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    let fetchedItemId = "";
    let fetchedArtifactId = "";
    await pool.query(policyInsert);
    await pool.query(`
      insert into source_corpus_policies(
        source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
        authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
        license_basis, default_text_access_policy, allow_raw_snapshot, normalize_replay_policy,
        bounded_replay_fields, retention_days, min_request_delay_ms, max_concurrency,
        reviewed_by, reviewed_at, review_due_at
      ) values (
        'us-constitution-annotated', 'us-conan-test-v1', '{"scope":"Table of Cases candidates only"}',
        'https://constitution.congress.gov/resources/cases-cited/', array['reviewed_fixture'],
        array['constitution.congress.gov'], '{}', 'https://constitution.congress.gov/robots.txt',
        now(), repeat('d', 64), 'official-public-record', 'metadata_only', false,
        'bounded_evidence', array['caseName','citation','essayReferences'], 3650, 1000, 1,
        'postgres-test', now(), now() + interval '1 year'
      )
    `);

    await pool.query(`
      insert into source_corpus_policies(
        source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
        authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
        terms_url, terms_observed_at, license_basis, default_text_access_policy,
        allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days,
        min_request_delay_ms, max_concurrency, reviewed_by, reviewed_at, review_due_at
      ) values (
        'fr-conseil-constitutionnel', 'fr-dila-test-v1', '{"scope":"2024 QPC","aiEgress":"denied"}',
        'https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/', array['official_dila_stock','conseil_identity_crosscheck'],
        array['echanges.dila.gouv.fr','www.conseil-constitutionnel.fr'], '{}',
        'https://echanges.dila.gouv.fr/robots.txt', now(), repeat('e', 64),
        'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0', now(),
        'licence-ouverte-2.0', 'full', false, 'bounded_evidence',
        array['sourceKey','url','canonicalUrl','title','publishedAt','contentType','text','metadata'],
        3650, 3000, 1, 'postgres-test', now(), now() + interval '1 year'
      )
    `);

    await pool.query(`
      insert into source_corpus_policies(
        source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
        authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
        terms_url, terms_observed_at, license_basis, default_text_access_policy,
        allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days,
        min_request_delay_ms, max_concurrency, external_index_hosts, external_index_usage,
        reviewed_by, reviewed_at, review_due_at
      ) values (
        'de-bverfg', 'bverfg-phase-host-test-v1', '{"scope":"2024 official website publications"}',
        'https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html',
        array['external_index_dejure_paged_listing'],
        array['www.bundesverfassungsgericht.de'], array['www.bverfg.de'],
        'https://www.bundesverfassungsgericht.de/robots.txt', now(), repeat('f', 64),
        'https://www.bundesverfassungsgericht.de/DE/Service/Impressum/impressum_node.html', now(),
        'official-work-with-source-and-integrity-requirements', 'metadata_only', false,
        'bounded_evidence', array['sourceKey','url','canonicalUrl','title','publishedAt','contentType','text','metadata'],
        3650, 0, 1, array['dejure.org','testphase.rechtsinformationen.bund.de'],
        'discovery identity only', 'postgres-test', now(), now() + interval '1 year'
      )
    `);

    await t.test("source request permits allow external indexes only during discovery", async () => {
      await assert.rejects(
        pool.query(`
          insert into source_corpus_policies(
            source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
            authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
            license_basis, default_text_access_policy, allow_raw_snapshot, normalize_replay_policy,
            bounded_replay_fields, retention_days, min_request_delay_ms, max_concurrency,
            external_index_hosts, external_index_usage, reviewed_by, reviewed_at, review_due_at
          ) values (
            'de-overlap-test', 'invalid-v1', '{}', 'https://example.com', array['test'],
            array['example.com'], '{}', 'https://example.com/robots.txt', now(), repeat('0',64),
            'test', 'metadata_only', false, 'bounded_evidence', array['title'], 1, 0, 1,
            array['example.com'], 'invalid overlap', 'postgres-test', now(), now() + interval '1 day'
          )
        `),
        /source_corpus_policies_host_classification_check/,
      );

      const snapshot = await pool.query<{ source_inventory_snapshot_open_v1: string }>(
        "select source_inventory_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          "de-bverfg", "2024-01-01", "2024-12-31", "DECISION",
          "external_index_union_to_official_detail", "bverfg-normalize-v1",
          "bverfg-phase-host-test-v1", "external_index_assisted", null, null,
          { externalIndexes: ["dejure.org"] }, JSON.stringify([]), "postgres-test",
        ],
      );
      const snapshotId = snapshot.rows[0].source_inventory_snapshot_open_v1;

      const claimAttempt = async (phase: "discover" | "fetch", passNumber: number) => {
        await pool.query(
          "select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            `p1.case-backfill.${phase}`,
            { cohort: "catalog-backfill", snapshotId, passNumber, batchLimit: 1 },
            `backfill-pass:germany-host:${phase}:${passNumber}`,
            `backfill-active:germany-host:${phase}:${passNumber}`,
            "postgres-test", 0, 1, 1, 1, false,
          ],
        );
        const attempt = await pool.query<{ attempt_id: string; fencing_token: string }>(
          "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
          [`germany-host-${phase}`, [`p1.case-backfill.${phase}`], ["catalog-backfill"], 30],
        );
        assert.equal(attempt.rowCount, 1);
        return attempt.rows[0];
      };

      const discoveryAttempt = await claimAttempt("discover", 1);
      const externalPermit = await pool.query<{ granted: boolean; permit_id: string }>(
        "select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)",
        [snapshotId, "discover", discoveryAttempt.attempt_id, discoveryAttempt.fencing_token, "https://dejure.org", 10],
      );
      assert.equal(externalPermit.rows[0].granted, true);
      await pool.query("select source_backfill_request_permit_release_v1($1,$2,$3)", [
        externalPermit.rows[0].permit_id, discoveryAttempt.attempt_id, discoveryAttempt.fencing_token,
      ]);
      await pool.query("select * from admin_fail_command_attempt_v3($1,$2,$3,$4,$5,$6)", [
        discoveryAttempt.attempt_id, discoveryAttempt.fencing_token, "terminal", "test.complete", "test", {},
      ]);

      const fetchAttempt = await claimAttempt("fetch", 1);
      await assert.rejects(
        pool.query("select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)", [
          snapshotId, "fetch", fetchAttempt.attempt_id, fetchAttempt.fencing_token, "https://dejure.org", 10,
        ]),
        /CASE_BACKFILL_REQUEST_HOST_NOT_ALLOWED/,
      );
      const officialPermit = await pool.query<{ granted: boolean; permit_id: string }>(
        "select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)",
        [
          snapshotId, "fetch", fetchAttempt.attempt_id, fetchAttempt.fencing_token,
          "https://www.bundesverfassungsgericht.de", 10,
        ],
      );
      assert.equal(officialPermit.rows[0].granted, true);
      await pool.query("select source_backfill_request_permit_release_v1($1,$2,$3)", [
        officialPermit.rows[0].permit_id, fetchAttempt.attempt_id, fetchAttempt.fencing_token,
      ]);
      await pool.query("select * from admin_fail_command_attempt_v3($1,$2,$3,$4,$5,$6)", [
        fetchAttempt.attempt_id, fetchAttempt.fencing_token, "terminal", "test.complete", "test", {},
      ]);

      const privileges = await pool.query<{ public_helper: boolean; public_acquire: boolean }>(`select
        has_function_privilege(
          'public','source_policy_request_host_allowed_v1(text[],text[],text[],text,text)','execute'
        ) public_helper,
        has_function_privilege(
          'public','source_backfill_request_permit_acquire_v1(uuid,text,uuid,bigint,text,integer)','execute'
        ) public_acquire`);
      assert.deepEqual(privileges.rows[0], { public_helper: false, public_acquire: false });
    });

    await t.test("France DILA provenance is validated, secret-free, immutable, and part of the manifest hash", async () => {
      const metadata = (sha256: string) => ({
        dila: {
          id: "CONSTEXT000050783534", nature: "QPC", ecli: "ECLI:FR:CC:2024:2024.1115.QPC",
          decisionNumber: "2024-1115", qualifiedNature: "QPC",
          archiveMemberPath: "constit/global/CONS/TEXT/00/00/50/78/35/CONSTEXT000050783534.xml",
        },
        stock: {
          filename: "Freemium_constit_global_20250713-140000.tar.gz",
          url: "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz",
          extractedAt: "2025-07-13T14:00:00.000Z", lastModified: null, etag: null,
          contentLength: 12_511_366, sha256,
        },
        license: {
          id: "licence-ouverte-2.0",
          url: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
          attribution: "DILA",
        },
      });
      const openSnapshot = async () => {
        const opened = await pool.query<{ source_inventory_snapshot_open_v1: string }>(
          "select source_inventory_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            "fr-conseil-constitutionnel", "2024-01-01", "2024-12-31", "QPC",
            "official_dila_constit_stock_with_conseil_identity_crosscheck", "france-conseil-normalize-v1",
            "fr-dila-test-v1", "authoritative_crosschecked", 1,
            "official_dila_stock_and_conseil_facet_exact_identity_set",
            { dilaStock: true, exactIdentitySetMatch: true }, JSON.stringify([]), "postgres-test",
          ],
        );
        return opened.rows[0].source_inventory_snapshot_open_v1;
      };
      const firstSnapshot = await openSnapshot();
      await assert.rejects(
        pool.query("select source_inventory_item_upsert_v2($1,$2,$3,$4,$5,$6,$7)", [
          firstSnapshot, "constit:constext000050783534", "20241115QPC",
          "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm", "QPC", "2024-12-13",
          { ...metadata("6".repeat(64)), accessToken: "sk-secret-must-not-enter-the-ledger" },
        ]),
        /CASE_BACKFILL_INVALID_INVENTORY_METADATA/,
      );
      await assert.rejects(
        pool.query("select source_inventory_item_upsert_v2($1,$2,$3,$4,$5,$6,$7)", [
          firstSnapshot, "constit:constext000050783534", "20241115QPC",
          "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm", "QPC", "2024-12-13",
          { ...metadata("6".repeat(64)), license: { ...metadata("6".repeat(64)).license, attribution: "Unknown" } },
        ]),
        /CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID/,
      );
      const item = await pool.query<{ source_inventory_item_upsert_v2: string }>(
        "select source_inventory_item_upsert_v2($1,$2,$3,$4,$5,$6,$7)",
        [
          firstSnapshot, "constit:constext000050783534", "20241115QPC",
          "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm", "QPC", "2024-12-13",
          metadata("6".repeat(64)),
        ],
      );
      const firstClose = await pool.query<{ manifest_hash: string }>(
        "select * from source_inventory_snapshot_close_v2($1)", [firstSnapshot],
      );
      await assert.rejects(
        pool.query("update source_backfill_items set inventory_metadata = '{}' where id = $1", [item.rows[0].source_inventory_item_upsert_v2]),
        /CASE_BACKFILL_MANIFEST_CLOSED/,
      );

      const secondSnapshot = await openSnapshot();
      await pool.query("select source_inventory_item_upsert_v2($1,$2,$3,$4,$5,$6,$7)", [
        secondSnapshot, "constit:constext000050783534", "20241115QPC",
        "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm", "QPC", "2024-12-13",
        metadata("7".repeat(64)),
      ]);
      const secondClose = await pool.query<{ manifest_hash: string }>(
        "select * from source_inventory_snapshot_close_v2($1)", [secondSnapshot],
      );
      assert.notEqual(firstClose.rows[0].manifest_hash, secondClose.rows[0].manifest_hash);
      const publicExecute = await pool.query<{ upsert: boolean; close: boolean; claim: boolean }>(`select
        has_function_privilege('public','source_inventory_item_upsert_v2(uuid,text,text,text,text,date,jsonb)','execute') upsert,
        has_function_privilege('public','source_inventory_snapshot_close_v2(uuid)','execute') close,
        has_function_privilege('public','source_backfill_items_claim_v2(uuid,text,integer,uuid,bigint,integer,text)','execute') claim`);
      assert.deepEqual(publicExecute.rows[0], { upsert: false, close: false, claim: false });
      const serviceExecute = await pool.query<{
        old_upsert: boolean;
        old_close: boolean;
        old_claim: boolean;
        new_upsert: boolean;
        new_close: boolean;
        new_claim: boolean;
      }>(`select
        has_function_privilege('service_role','source_inventory_item_upsert_v1(uuid,text,text,text,text,date)','execute') old_upsert,
        has_function_privilege('service_role','source_inventory_snapshot_close_v1(uuid)','execute') old_close,
        has_function_privilege('service_role','source_backfill_items_claim_v1(uuid,text,integer,uuid,bigint,integer,text)','execute') old_claim,
        has_function_privilege('service_role','source_inventory_item_upsert_v2(uuid,text,text,text,text,date,jsonb)','execute') new_upsert,
        has_function_privilege('service_role','source_inventory_snapshot_close_v2(uuid)','execute') new_close,
        has_function_privilege('service_role','source_backfill_items_claim_v2(uuid,text,integer,uuid,bigint,integer,text)','execute') new_claim`);
      assert.deepEqual(serviceExecute.rows[0], {
        old_upsert: false, old_close: false, old_claim: false,
        new_upsert: true, new_close: true, new_claim: true,
      });
    });

    await t.test("US candidate graph is immutable and requires explicit authority review", async () => {
      const opened = await pool.query<{ us_conan_candidate_snapshot_open_v1: string }>(
        "select us_conan_candidate_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7)",
        [
          "us-conan-test-v1", "e".repeat(64), "us-conan-table-v1", "reviewed_fixture",
          "best_effort", "2026-09-03T08:00:00.000Z", "postgres-test",
        ],
      );
      const candidateSnapshotId = opened.rows[0].us_conan_candidate_snapshot_open_v1;
      const bakerEvidence = [{
        essayId: "ALDE_00001001",
        title: "Congressional Districting",
        url: "https://constitution.congress.gov/browse/essay/artI-S2-C1-1/ALDE_00001001/",
      }];
      const baker = await pool.query<{ us_conan_candidate_upsert_v1: string }>(
        "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          candidateSnapshotId, "conan:baker", "Baker v. Carr", "369 U.S. 186 (1962)",
          "369 U.S. 186 (1962)", "scotus_candidate", 100,
          ["reviewed_redistricting_landmark_seed"], JSON.stringify(bakerEvidence),
        ],
      );
      const bakerId = baker.rows[0].us_conan_candidate_upsert_v1;
      const duplicate = await pool.query<{ us_conan_candidate_upsert_v1: string }>(
        "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          candidateSnapshotId, "conan:baker", "Baker v. Carr", "369 U.S. 186 (1962)",
          "369 U.S. 186 (1962)", "scotus_candidate", 100,
          ["reviewed_redistricting_landmark_seed"], JSON.stringify(bakerEvidence),
        ],
      );
      assert.equal(duplicate.rows[0].us_conan_candidate_upsert_v1, bakerId);
      await assert.rejects(
        pool.query(
          "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            candidateSnapshotId, "conan:baker", "Baker v. Carr", "369 U.S. 186 (1962)",
            "369 U.S. 186 (1962)", "scotus_candidate", 100,
            ["reviewed_redistricting_landmark_seed"],
            JSON.stringify([{ ...bakerEvidence[0], title: "Conflicting title" }]),
          ],
        ),
        /US_CONAN_ESSAY_EVIDENCE_CONFLICT/,
      );

      const district = await pool.query<{ us_conan_candidate_upsert_v1: string }>(
        "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          candidateSnapshotId, "conan:district", "Example District Case", "103 F. Supp. 569 (D.D.C. 1952)",
          "103 F. Supp. 569 (D.D.C. 1952)", "lower_federal", 0, [],
          JSON.stringify([{
            essayId: "ALDE_00000069",
            title: "Methodologies for the Tables",
            url: "https://constitution.congress.gov/browse/essay/appx.1/ALDE_00000069/",
          }]),
        ],
      );
      const districtId = district.rows[0].us_conan_candidate_upsert_v1;
      const closed = await pool.query<{ candidate_count: number; manifest_hash: string }>(
        "select * from us_conan_candidate_snapshot_close_v1($1)", [candidateSnapshotId],
      );
      assert.equal(closed.rows[0].candidate_count, 2);
      assert.match(closed.rows[0].manifest_hash, /^[0-9a-f]{64}$/);

      const authorityArtifact = await pool.query<{ us_conan_candidate_authority_record_v1: string }>(
        "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          bakerId, "govinfo-usreports-v1", "verified", "369 U.S. 186 (1962)",
          "Baker et al. v. Carr et al.",
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
          "f".repeat(64), [], "2026-09-03T09:00:00.000Z",
        ],
      );
      const authorityArtifactId = authorityArtifact.rows[0].us_conan_candidate_authority_record_v1;
      const authorityDuplicate = await pool.query<{ us_conan_candidate_authority_record_v1: string }>(
        "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          bakerId, "govinfo-usreports-v1", "verified", "369 U.S. 186 (1962)",
          "Baker et al. v. Carr et al.",
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
          "f".repeat(64), [], "2026-09-03T09:00:00.000Z",
        ],
      );
      assert.equal(authorityDuplicate.rows[0].us_conan_candidate_authority_record_v1, authorityArtifactId);
      const authorityFresh = await pool.query<{ us_conan_candidate_authority_record_v1: string }>(
        "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          bakerId, "govinfo-usreports-v1", "verified", "369 U.S. 186 (1962)",
          "Baker et al. v. Carr et al.",
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
          "f".repeat(64), [], "2026-09-03T09:01:00.000Z",
        ],
      );
      const authorityFreshId = authorityFresh.rows[0].us_conan_candidate_authority_record_v1;
      assert.notEqual(authorityFreshId, authorityArtifactId);
      const authorityCurrent = await pool.query<{ status: string; citation: string; observed_at: Date }>(
        "select status,citation,observed_at from us_conan_candidate_authority_current_v1 where candidate_id=$1", [bakerId],
      );
      assert.equal(authorityCurrent.rows[0].status, "verified");
      assert.equal(authorityCurrent.rows[0].citation, "369 U.S. 186 (1962)");
      assert.equal(authorityCurrent.rows[0].observed_at.toISOString(), "2026-09-03T09:01:00.000Z");
      await assert.rejects(
        pool.query(
          "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            districtId, "govinfo-usreports-v1", "verified", "103 F. Supp. 569 (D.D.C. 1952)",
            "Example District Case", "https://www.govinfo.gov/app/details/USREPORTS-103/USREPORTS-103-569",
            "https://www.govinfo.gov/content/pkg/USREPORTS-103/pdf/USREPORTS-103-569.pdf",
            "f".repeat(64), [], "2026-09-03T09:00:00.000Z",
          ],
        ),
        /US_CONAN_AUTHORITY_CITATION_INVALID/,
      );
      await assert.rejects(
        pool.query(
          "select us_conan_candidate_authority_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            bakerId, "govinfo-usreports-v1", "verified", "369 U.S. 186 (1962)",
            "Baker et al. v. Carr et al.",
            "https://www.govinfo.gov/app/details/USREPORTS-370/USREPORTS-370-186",
            "https://www.govinfo.gov/content/pkg/USREPORTS-370/pdf/USREPORTS-370-186.pdf",
            "f".repeat(64), [], "2026-09-03T09:00:00.000Z",
          ],
        ),
        /US_CONAN_AUTHORITY_URL_MISMATCH/,
      );
      await assert.rejects(
        pool.query("update us_conan_candidate_authority_artifacts_v1 set status='blocked' where id=$1", [authorityArtifactId]),
        /CASE_BACKFILL_IMMUTABLE/,
      );

      await assert.rejects(
        pool.query("update us_conan_case_candidates_v1 set priority=99 where id=$1", [bakerId]),
        /CASE_BACKFILL_IMMUTABLE/,
      );
      await assert.rejects(
        pool.query(
          "select us_conan_candidate_upsert_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            candidateSnapshotId, "conan:late", "Late Case", "1 U.S. 1", "1 U.S. 1",
            "scotus_candidate", 0, [], JSON.stringify(bakerEvidence),
          ],
        ),
        /US_CONAN_MANIFEST_CLOSED/,
      );
      await assert.rejects(
        pool.query(`insert into us_conan_candidate_reviews_v1(
          candidate_id,revision,status,official_scotus_identity_verified,
          constitutional_essay_context_verified,official_authority_verified,
          constitutional_holding_verified,official_authority_url,reviewed_by,review_reason
        ) values($1,1,'verified',true,true,true,true,'https://www.supremecourt.gov/opinions/test.pdf','postgres-test','invalid')`, [districtId]),
        /US_CONAN_VERIFICATION_GATE_FAILED/,
      );
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_review_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            bakerId, 0, "verified", true, false, true, true,
            "https://www.supremecourt.gov/opinions/test.pdf", {}, "postgres-test", "missing context",
          ],
        ),
        /US_CONAN_VERIFIED_REQUIRES_REVIEW_V2/,
      );
      const uncertain = await pool.query<{ review_revision: number; review_status: string }>(
        "select * from us_conan_candidate_review_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [bakerId, 0, "uncertain", true, false, true, false, null, {}, "postgres-test", "Essay context pending."],
      );
      assert.deepEqual(
        { revision: uncertain.rows[0].review_revision, status: uncertain.rows[0].review_status },
        { revision: 1, status: "uncertain" },
      );
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_review_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [bakerId, 0, "rejected", false, false, false, false, null, {}, "postgres-test", "stale reviewer"],
        ),
        /US_CONAN_REVIEW_STALE_REVISION/,
      );
      const essayEvidence = await pool.query<{ id: string }>(
        "select id from us_conan_candidate_essay_evidence_v1 where candidate_id=$1 and essay_id=$2",
        [bakerId, "ALDE_00001001"],
      );
      const essayEvidenceId = essayEvidence.rows[0].id;
      const holdingEvidence = [{
        sourceUrl: "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
        locator: "pp. 208-237",
        constitutionalQuestion: "Whether legislative apportionment claims present a justiciable federal constitutional question.",
      }];
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_review_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            bakerId, 1, "verified", true, true, true, true, authorityArtifactId,
            "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
            [essayEvidenceId], JSON.stringify(holdingEvidence), {}, "postgres-test", "Stale authority artifact.",
          ],
        ),
        /US_CONAN_AUTHORITY_ARTIFACT_STALE/,
      );
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_review_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            bakerId, 1, "verified", true, true, true, true, authorityFreshId,
            "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
            ["00000000-0000-4000-8000-000000000099"], JSON.stringify(holdingEvidence), {},
            "postgres-test", "Unknown essay evidence.",
          ],
        ),
        /US_CONAN_VERIFIED_ESSAY_EVIDENCE_INVALID/,
      );
      await assert.rejects(
        pool.query(
          "select * from us_conan_candidate_review_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            bakerId, 1, "verified", true, true, true, true, authorityFreshId,
            "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
            [essayEvidenceId], JSON.stringify([{
              sourceUrl: "https://example.com/not-authority",
              locator: "",
              constitutionalQuestion: "Article III justiciability.",
            }]), {}, "postgres-test", "Invalid holding locator.",
          ],
        ),
        /US_CONAN_VERIFIED_HOLDING_EVIDENCE_INVALID/,
      );
      const verified = await pool.query<{ review_revision: number; review_status: string }>(
        "select * from us_conan_candidate_review_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          bakerId, 1, "verified", true, true, true, true, authorityFreshId,
          "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
          [essayEvidenceId], JSON.stringify(holdingEvidence),
          { identity: "369 U.S. 186", essayId: "ALDE_00001001", authorityArtifactId: authorityFreshId },
          "postgres-test", "All four gates and bound evidence reviewed.",
        ],
      );
      assert.deepEqual(
        { revision: verified.rows[0].review_revision, status: verified.rows[0].review_status },
        { revision: 2, status: "verified" },
      );
      const current = await pool.query<{ constitutional_relevance_status: string; review_revision: number }>(
        "select constitutional_relevance_status,review_revision from us_conan_candidate_current_v1 where id=$1", [bakerId],
      );
      assert.deepEqual(current.rows[0], { constitutional_relevance_status: "verified", review_revision: 2 });
      const reviewEvidence = await pool.query<{
        authority_artifact_id: string;
        essay_evidence_ids: string[];
        holding_evidence: unknown[];
      }>(
        `select authority_artifact_id,essay_evidence_ids,holding_evidence
         from us_conan_candidate_reviews_v1 where candidate_id=$1 and revision=2`,
        [bakerId],
      );
      assert.equal(reviewEvidence.rows[0].authority_artifact_id, authorityFreshId);
      assert.deepEqual(reviewEvidence.rows[0].essay_evidence_ids, [essayEvidenceId]);
      assert.deepEqual(reviewEvidence.rows[0].holding_evidence, holdingEvidence);
      const security = await pool.query<{
        rls: boolean;
        public_select: boolean;
        public_execute: boolean;
        public_execute_v2: boolean;
      }>(`
        select
          (select relrowsecurity from pg_class where oid='us_conan_case_candidates_v1'::regclass) rls,
          has_table_privilege('public','us_conan_case_candidates_v1','select') public_select,
          has_function_privilege(
            'public',
            'us_conan_candidate_review_v1(uuid,integer,text,boolean,boolean,boolean,boolean,text,jsonb,text,text)',
            'execute'
          ) public_execute,
          has_function_privilege(
            'public',
            'us_conan_candidate_review_v2(uuid,integer,text,boolean,boolean,boolean,boolean,uuid,text,uuid[],jsonb,jsonb,text,text)',
            'execute'
          ) public_execute_v2
      `);
      assert.deepEqual(security.rows[0], {
        rls: true,
        public_select: false,
        public_execute: false,
        public_execute_v2: false,
      });
      await assert.rejects(
        pool.query("update us_conan_candidate_reviews_v1 set review_reason='tampered' where candidate_id=$1", [bakerId]),
        /CASE_BACKFILL_IMMUTABLE/,
      );
    });
    await pool.query(`
      insert into source_corpus_policies(
        source_key, policy_version, scope_definition, official_scope_url, discovery_methods,
        authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
        terms_url, terms_observed_at, license_basis, default_text_access_policy,
        allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days,
        min_request_delay_ms, max_concurrency, external_index_hosts, external_index_usage,
        reviewed_by, reviewed_at, review_due_at, supersedes_policy_version
      )
      select source_key, 'spain-hj-expired-v1', scope_definition, official_scope_url, discovery_methods,
        authority_hosts, redirect_hosts, robots_url, robots_observed_at, robots_rules_hash,
        terms_url, terms_observed_at, license_basis, default_text_access_policy,
        allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days,
        min_request_delay_ms, max_concurrency, external_index_hosts, external_index_usage,
        reviewed_by, now() - interval '2 years', now() - interval '1 year', null
      from source_corpus_policies
      where source_key = 'es-tribunal-constitucional' and policy_version = 'spain-hj-test-v1'
    `);
    await assert.rejects(
      pool.query(
        "select source_inventory_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          "es-tribunal-constitucional", "2024-01-01", "2024-12-31", "SENTENCIA",
          "official_hj_search_pagination", "spain-hj-normalize-v1", "spain-hj-expired-v1",
          "authoritative_enumerated", null, null,
          { method: "official_hj_search_pagination" }, JSON.stringify([]), "postgres-test",
        ],
      ),
      /SOURCE_POLICY_REVIEW_OVERDUE/,
    );
    const opened = await pool.query<{ source_inventory_snapshot_open_v1: string }>(
      "select source_inventory_snapshot_open_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        "es-tribunal-constitucional", "2024-01-01", "2024-12-31", "SENTENCIA",
        "official_hj_search_pagination", "spain-hj-normalize-v1", "spain-hj-test-v1",
        "authoritative_enumerated", null, null,
        { method: "official_hj_search_pagination", exhausted: true }, JSON.stringify([]), "postgres-test",
      ],
    );
    const snapshotId = opened.rows[0].source_inventory_snapshot_open_v1;
    await pool.query("select source_inventory_snapshot_evidence_v2($1,$2,$3,$4)", [
      snapshotId,
      { method: "official_hj_search_pagination", exhausted: true, discoveredCount: 2 },
      2,
      "official_search_result_count",
    ]);
    for (const id of ["12345", "12346"]) {
      await pool.query("select source_inventory_item_upsert_v1($1,$2,$3,$4,$5,$6)", [
        snapshotId,
        `hj:${id}`,
        id,
        `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${id}`,
        "SENTENCIA",
        "2024-05-08",
      ]);
    }
    const closed = await pool.query<{ discovered_count: number; manifest_hash: string }>(
      "select * from source_inventory_snapshot_close_v1($1)", [snapshotId],
    );
    assert.equal(closed.rows[0].discovered_count, 2);
    assert.match(closed.rows[0].manifest_hash, /^[0-9a-f]{64}$/);
    const fixedCount = await pool.query<{ expected_count: number; expected_count_basis: string }>(
      "select expected_count, expected_count_basis from source_inventory_snapshots where id = $1",
      [snapshotId],
    );
    assert.deepEqual(fixedCount.rows[0], {
      expected_count: 2,
      expected_count_basis: "official_search_result_count",
    });

    await t.test("closed manifest rejects discovery mutation and insertion", async () => {
      await assert.rejects(
        pool.query("update source_backfill_items set discovered_url = discovered_url || '?changed=1' where snapshot_id = $1", [snapshotId]),
        /CASE_BACKFILL_MANIFEST_CLOSED/,
      );
      await assert.rejects(
        pool.query("select source_inventory_item_upsert_v1($1,$2,$3,$4,$5,$6)", [
          snapshotId, "hj:99999", "99999", "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/99999", "SENTENCIA", "2024-06-01",
        ]),
        /CASE_BACKFILL_MANIFEST_CLOSED/,
      );
    });

    await t.test("item claim is scoped to a live P1 attempt and capped by its lease", async () => {
      const submitted = await pool.query<{ run_id: string }>(
        "select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          "p1.case-backfill.fetch",
          { cohort: "catalog-backfill", snapshotId, passNumber: 1, batchLimit: 1, fetchContractVersion: "spain-hj-fetch-v1" },
          "backfill-pass:test:fetch:1", "backfill-active:test:fetch", "postgres-test", 0, 3, 1, 4, false,
        ],
      );
      const attempt = await pool.query<{ attempt_id: string; fencing_token: string; lease_expires_at: string }>(
        "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
        ["backfill-worker", ["p1.case-backfill.fetch"], ["catalog-backfill"], 30],
      );
      const sourceRun = await pool.query<{ source_backfill_run_begin_v1: string }>("select source_backfill_run_begin_v1($1,$2,$3,$4,$5)", [
        snapshotId, "fetch", 1, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
      ]);
      const claimed = await pool.query<{
        item_id: string;
        item_lease_expires_at: string;
        inventory_metadata: Record<string, unknown>;
      }>(
        "select * from source_backfill_items_claim_v2($1,$2,$3,$4,$5,$6,$7)",
        [snapshotId, "fetch", 1, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, 600, "spain-hj-fetch-v1"],
      );
      assert.equal(claimed.rowCount, 1);
      assert.deepEqual(claimed.rows[0].inventory_metadata, {});
      assert(Date.parse(claimed.rows[0].item_lease_expires_at) <= Date.parse(attempt.rows[0].lease_expires_at));
      await assert.rejects(
        pool.query("select * from source_backfill_items_claim_v1($1,$2,$3,$4,$5,$6,$7)", [
          snapshotId, "fetch", 1, attempt.rows[0].attempt_id, "999999", 30, "spain-hj-fetch-v1",
        ]),
        /CASE_BACKFILL_STALE_FENCE/,
      );

      const firstPermit = await pool.query<{
        granted: boolean;
        permit_id: string | null;
        retry_after_ms: number;
        permit_lease_expires_at: string | null;
      }>("select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)", [
        snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
        "https://hj.tribunalconstitucional.es", 10,
      ]);
      assert.equal(firstPermit.rows[0].granted, true);
      assert(firstPermit.rows[0].permit_id);
      assert(Date.parse(firstPermit.rows[0].permit_lease_expires_at as string) <= Date.parse(attempt.rows[0].lease_expires_at));

      const concurrentPermit = await pool.query<{ granted: boolean; retry_after_ms: number }>(
        "select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)",
        [snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "https://hj.tribunalconstitucional.es", 10],
      );
      assert.equal(concurrentPermit.rows[0].granted, false);
      assert(concurrentPermit.rows[0].retry_after_ms > 0);
      await assert.rejects(
        pool.query("select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)", [
          snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "https://example.com", 10,
        ]),
        /CASE_BACKFILL_REQUEST_HOST_NOT_ALLOWED/,
      );
      await pool.query("select source_backfill_request_permit_release_v1($1,$2,$3)", [
        firstPermit.rows[0].permit_id, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
      ]);

      const rateLimitedPermit = await pool.query<{ granted: boolean; retry_after_ms: number }>(
        "select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)",
        [snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "https://hj.tribunalconstitucional.es", 10],
      );
      assert.equal(rateLimitedPermit.rows[0].granted, false);
      assert(rateLimitedPermit.rows[0].retry_after_ms > 0);
      await pool.query("select pg_sleep(1.05)");
      const racingPermits = await Promise.all([1, 2].map(() => pool.query<{ granted: boolean; permit_id: string | null }>(
        "select * from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6)",
        [snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "https://hj.tribunalconstitucional.es", 10],
      )));
      const grantedPermits = racingPermits.flatMap((result) => result.rows).filter((row) => row.granted);
      assert.equal(grantedPermits.length, 1);
      assert(grantedPermits[0].permit_id);
      await pool.query("select source_backfill_request_permit_release_v1($1,$2,$3)", [
        grantedPermits[0].permit_id, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
      ]);
      const governorSecurity = await pool.query<{
        states_rls: boolean;
        permits_rls: boolean;
        public_select: boolean;
        public_execute: boolean;
      }>(`select
        (select relrowsecurity from pg_class where oid='source_request_governor_states'::regclass) states_rls,
        (select relrowsecurity from pg_class where oid='source_request_permits'::regclass) permits_rls,
        has_table_privilege('public','source_request_permits','select') public_select,
        has_function_privilege(
          'public',
          'source_backfill_request_permit_acquire_v1(uuid,text,uuid,bigint,text,integer)',
          'execute'
        ) public_execute`);
      assert.deepEqual(governorSecurity.rows[0], {
        states_rls: true, permits_rls: true, public_select: false, public_execute: false,
      });

      const payload = {
        sourceKey: "es-tribunal-constitucional",
        url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
        canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
        title: "SENTENCIA 53/2024",
        publishedAt: "2024-05-08T00:00:00.000Z",
        contentType: "decision",
        text: "official text",
        metadata: { resolutionType: "SENTENCIA", decisionDate: "2024-05-08" },
      };
      const artifact = await pool.query<{ source_backfill_fetch_artifact_record_v1: string }>(
        "select source_backfill_fetch_artifact_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [
          claimed.rows[0].item_id, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "spain-hj-test-v1", payload.canonicalUrl, 200, {}, null, null, "b".repeat(64),
          JSON.stringify(payload).length, "bounded_evidence", null, payload, "spain-hj-fetch-v1",
        ],
      );
      const artifactId = artifact.rows[0].source_backfill_fetch_artifact_record_v1;
      fetchedItemId = claimed.rows[0].item_id;
      fetchedArtifactId = artifactId;
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        claimed.rows[0].item_id, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
        "fetched", { artifactId },
      ]);
      await pool.query("select source_backfill_run_finish_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
        sourceRun.rows[0].source_backfill_run_begin_v1,
        attempt.rows[0].attempt_id,
        attempt.rows[0].fencing_token,
        "succeeded", 1, 1, 0, 0,
      ]);
      await pool.query("select * from admin_complete_command_attempt_v3($1,$2,$3)", [
        attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, {},
      ]);
      const run = await pool.query<{ status: string }>("select status from admin_command_runs where id = $1", [submitted.rows[0].run_id]);
      assert.equal(run.rows[0].status, "succeeded");
      await assert.rejects(
        pool.query("update source_fetch_artifacts set http_status = 201 where id = $1", [artifactId]),
        /CASE_BACKFILL_IMMUTABLE/,
      );
    });

    await t.test("successful attempt cannot retain claims and failed attempt releases them with phase-aware retry", async () => {
      const submitted = await pool.query(
        "select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          "p1.case-backfill.fetch",
          { cohort: "catalog-backfill", snapshotId, passNumber: 2, batchLimit: 1, fetchContractVersion: "spain-hj-fetch-v1" },
          "backfill-pass:test:fetch:2", "backfill-active:test:fetch:2", "postgres-test", 0, 3, 1, 4, false,
        ],
      );
      assert.equal(submitted.rowCount, 1);
      const attempt = await pool.query<{ attempt_id: string; fencing_token: string }>(
        "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
        ["backfill-worker-2", ["p1.case-backfill.fetch"], ["catalog-backfill"], 30],
      );
      const sourceRun = await pool.query<{ source_backfill_run_begin_v1: string }>(
        "select source_backfill_run_begin_v1($1,$2,$3,$4,$5)",
        [snapshotId, "fetch", 2, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token],
      );
      const claimed = await pool.query<{ item_id: string }>(
        "select * from source_backfill_items_claim_v1($1,$2,$3,$4,$5,$6,$7)",
        [snapshotId, "fetch", 1, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, 30, "spain-hj-fetch-v1"],
      );
      assert.equal(claimed.rowCount, 1);
      await assert.rejects(
        pool.query("select * from admin_complete_command_attempt_v3($1,$2,$3)", [
          attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, {},
        ]),
        /CASE_BACKFILL_ACTIVE_ITEM_CLAIMS/,
      );
      await pool.query("select pg_sleep(1.05)");
      const permit = await pool.query<{ permit_id: string }>(
        "select permit_id from source_backfill_request_permit_acquire_v1($1,$2,$3,$4,$5,$6) where granted",
        [snapshotId, "fetch", attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
          "https://hj.tribunalconstitucional.es", 10],
      );
      assert.equal(permit.rowCount, 1);
      await pool.query("select * from admin_fail_command_attempt_v3($1,$2,$3,$4,$5,$6)", [
        attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, "retryable", "worker_stopping", "test", {},
      ]);
      const released = await pool.query<{ status: string; retry_phase: string; claimed_attempt_id: string | null }>(
        "select status, retry_phase, claimed_attempt_id from source_backfill_items where id = $1", [claimed.rows[0].item_id],
      );
      assert.deepEqual(released.rows[0], { status: "retry_wait", retry_phase: "fetch", claimed_attempt_id: null });
      const releasedPermit = await pool.query<{ released_at: string | null }>(
        "select released_at from source_request_permits where id = $1",
        [permit.rows[0].permit_id],
      );
      assert(releasedPermit.rows[0].released_at);
      const failedRun = await pool.query<{ status: string }>("select status from source_backfill_runs where id = $1", [
        sourceRun.rows[0].source_backfill_run_begin_v1,
      ]);
      assert.equal(failedRun.rows[0].status, "failed");
    });

    await t.test("successful P1 terminalization is rejected while its backfill run is still active", async () => {
      await pool.query(
        "select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          "p1.case-backfill.reconcile",
          { cohort: "catalog-backfill", snapshotId, passNumber: 1, batchLimit: 1 },
          "backfill-pass:test:reconcile:1", "backfill-active:test:reconcile:1", "postgres-test", 0, 3, 1, 4, false,
        ],
      );
      const attempt = await pool.query<{ attempt_id: string; fencing_token: string }>(
        "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
        ["backfill-reconcile", ["p1.case-backfill.reconcile"], ["catalog-backfill"], 30],
      );
      const sourceRun = await pool.query<{ source_backfill_run_begin_v1: string }>(
        "select source_backfill_run_begin_v1($1,$2,$3,$4,$5)",
        [snapshotId, "reconcile", 1, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token],
      );
      await assert.rejects(
        pool.query("select * from admin_complete_command_attempt_v3($1,$2,$3)", [
          attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, {},
        ]),
        /CASE_BACKFILL_ACTIVE_RUN/,
      );
      await pool.query("select * from admin_fail_command_attempt_v3($1,$2,$3,$4,$5,$6)", [
        attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, "terminal", "test.active_run", "test", {},
      ]);
      const run = await pool.query<{ status: string }>("select status from source_backfill_runs where id = $1", [
        sourceRun.rows[0].source_backfill_run_begin_v1,
      ]);
      assert.equal(run.rows[0].status, "failed");
    });

    await t.test("stored fetch evidence supports network-free normalize and published re-normalize remains published", async () => {
      assert(fetchedItemId && fetchedArtifactId);
      const normalizedOutput = {
        sourceKey: "es-tribunal-constitucional",
        jurisdiction: "Spain",
        institutionName: "Tribunal Constitucional de España",
        contentType: "decision",
        originalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
        canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
        originalLanguage: "es",
        originalTitle: "SENTENCIA 53/2024",
        originalPublishedAt: "2024-05-08T00:00:00.000Z",
        metadata: { resolutionType: "SENTENCIA", decisionDate: "2024-05-08" },
      };

      const runPhase = async (phase: "normalize" | "verify" | "publish", passNumber: number, targetVersion: string | null) => {
        const payload: Record<string, unknown> = { cohort: "catalog-backfill", snapshotId, passNumber, batchLimit: 1 };
        if (phase === "normalize" && targetVersion) {
          const [parserVersion, normalizationContractVersion] = targetVersion.split(":");
          payload.parserVersion = parserVersion;
          payload.normalizationContractVersion = normalizationContractVersion;
        }
        await pool.query("select * from admin_submit_command_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
          `p1.case-backfill.${phase}`,
          payload,
          `backfill-pass:test:${phase}:${passNumber}`,
          `backfill-active:test:${phase}:${passNumber}`,
          "postgres-test", 0, 3, 1, 4, false,
        ]);
        const attempt = await pool.query<{ attempt_id: string; fencing_token: string }>(
          "select * from admin_claim_command_attempt_p1($1,$2,$3,$4)",
          [`backfill-${phase}-${passNumber}`, [`p1.case-backfill.${phase}`], ["catalog-backfill"], 30],
        );
        const sourceRun = await pool.query<{ source_backfill_run_begin_v1: string }>("select source_backfill_run_begin_v1($1,$2,$3,$4,$5)", [
          snapshotId, phase, passNumber, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token,
        ]);
        const claim = await pool.query<{ item_id: string; current_fetch_artifact_id: string; current_normalization_artifact_id: string }>(
          "select * from source_backfill_items_claim_v1($1,$2,$3,$4,$5,$6,$7)",
          [snapshotId, phase, 1, attempt.rows[0].attempt_id, attempt.rows[0].fencing_token, 30, targetVersion],
        );
        assert.equal(claim.rowCount, 1);
        assert.equal(claim.rows[0].item_id, fetchedItemId);
        return {
          attempt: attempt.rows[0],
          claim: claim.rows[0],
          sourceRunId: sourceRun.rows[0].source_backfill_run_begin_v1,
        };
      };

      const completeAttempt = async (run: {
        attempt: { attempt_id: string; fencing_token: string };
        sourceRunId: string;
      }) => {
        await pool.query("select source_backfill_run_finish_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
          run.sourceRunId, run.attempt.attempt_id, run.attempt.fencing_token, "succeeded", 1, 1, 0, 0,
        ]);
        const attempt = run.attempt;
        await pool.query("select * from admin_complete_command_attempt_v3($1,$2,$3)", [attempt.attempt_id, attempt.fencing_token, {}]);
      };

      const normalizeV1 = await runPhase("normalize", 1, "spain-hj-normalize-v1:case-normalized-v1");
      assert.equal(normalizeV1.claim.current_fetch_artifact_id, fetchedArtifactId);
      const normalizationV1 = await pool.query<{ source_backfill_normalization_artifact_record_v1: string }>(
        "select source_backfill_normalization_artifact_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          fetchedItemId, normalizeV1.attempt.attempt_id, normalizeV1.attempt.fencing_token, fetchedArtifactId,
          "spain-hj-normalize-v1", "case-normalized-v1", normalizedOutput, "c".repeat(64), "valid", JSON.stringify([]),
        ],
      );
      const normalizationV1Id = normalizationV1.rows[0].source_backfill_normalization_artifact_record_v1;
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        fetchedItemId, "normalize", normalizeV1.attempt.attempt_id, normalizeV1.attempt.fencing_token,
        "normalized", { artifactId: normalizationV1Id },
      ]);
      await completeAttempt(normalizeV1);

      const verifyV1 = await runPhase("verify", 1, null);
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        fetchedItemId, "verify", verifyV1.attempt.attempt_id, verifyV1.attempt.fencing_token,
        "verified", { artifactId: normalizationV1Id },
      ]);
      await completeAttempt(verifyV1);

      const publishV1 = await runPhase("publish", 1, null);
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        fetchedItemId, "publish", publishV1.attempt.attempt_id, publishV1.attempt.fencing_token,
        "published", { artifactId: normalizationV1Id },
      ]);
      await completeAttempt(publishV1);

      const normalizeV2 = await runPhase("normalize", 2, "spain-hj-normalize-v2:case-normalized-v1");
      const normalizationV2 = await pool.query<{ source_backfill_normalization_artifact_record_v1: string }>(
        "select source_backfill_normalization_artifact_record_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          fetchedItemId, normalizeV2.attempt.attempt_id, normalizeV2.attempt.fencing_token, fetchedArtifactId,
          "spain-hj-normalize-v2", "case-normalized-v1", normalizedOutput, "c".repeat(64), "valid", JSON.stringify([]),
        ],
      );
      const normalizationV2Id = normalizationV2.rows[0].source_backfill_normalization_artifact_record_v1;
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        fetchedItemId, "normalize", normalizeV2.attempt.attempt_id, normalizeV2.attempt.fencing_token,
        "published", { artifactId: normalizationV2Id },
      ]);
      await completeAttempt(normalizeV2);
      const maintenance = await pool.query<{ status: string; needs_reverify: boolean; needs_republish: boolean }>(
        "select status, needs_reverify, needs_republish from source_backfill_item_work_v1 where id = $1", [fetchedItemId],
      );
      assert.deepEqual(maintenance.rows[0], { status: "published", needs_reverify: true, needs_republish: false });

      const verifyV2 = await runPhase("verify", 2, null);
      await pool.query("select * from source_backfill_item_complete_v1($1,$2,$3,$4,$5,$6)", [
        fetchedItemId, "verify", verifyV2.attempt.attempt_id, verifyV2.attempt.fencing_token,
        "published", { artifactId: normalizationV2Id, noop: true },
      ]);
      await completeAttempt(verifyV2);
      const reconciled = await pool.query<{
        status: string;
        current_normalization_artifact_id: string;
        verified_normalization_artifact_id: string;
        published_normalization_artifact_id: string;
        needs_reverify: boolean;
        needs_republish: boolean;
      }>(
        `select status, current_normalization_artifact_id, verified_normalization_artifact_id,
          published_normalization_artifact_id, needs_reverify, needs_republish
         from source_backfill_item_work_v1 where id = $1`, [fetchedItemId],
      );
      assert.deepEqual(reconciled.rows[0], {
        status: "published",
        current_normalization_artifact_id: normalizationV2Id,
        verified_normalization_artifact_id: normalizationV2Id,
        published_normalization_artifact_id: normalizationV2Id,
        needs_reverify: false,
        needs_republish: false,
      });
      await assert.rejects(
        pool.query("update source_normalization_artifacts set parser_version = 'tampered' where id = $1", [normalizationV2Id]),
        /CASE_BACKFILL_IMMUTABLE/,
      );
    });
  } finally {
    await pool.end();
  }
});
