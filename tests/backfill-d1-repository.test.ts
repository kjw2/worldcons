import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { d1CaseBackfillRepository } from "../lib/backfill/d1-repository";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Bindings,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";

const SNAPSHOT_ID = "57948d51-1300-4ff1-86db-be00a6572bc9";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const FENCE = "9001";
const FETCH_CONTRACT = "bverfg-official-fetch-v1";

function binding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const prepared: D1RuntimePreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return prepared;
        },
        async all<T>() {
          try {
            const rows = database.prepare(sql).all(...values as SQLInputValue[]) as T[];
            return { success: true, results: rows, meta: { changes: 0 } };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
        async run() {
          try {
            const result = database.prepare(sql).run(...values as SQLInputValue[]);
            return { success: true, results: [], meta: { changes: Number(result.changes) } };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return prepared;
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          if (!statement.run) throw new Error("missing run");
          results.push(await statement.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function createDatabases() {
  const core = new DatabaseSync(":memory:");
  const ingest = new DatabaseSync(":memory:");
  const ops = new DatabaseSync(":memory:");

  core.exec(`
    CREATE TABLE source_corpus_policies (
      source_key TEXT, policy_version TEXT, normalize_replay_policy TEXT, bounded_replay_fields TEXT, default_text_access_policy TEXT,
      min_request_delay_ms INTEGER, max_concurrency INTEGER, review_due_at TEXT,
      authority_hosts TEXT, redirect_hosts TEXT, external_index_hosts TEXT
    );
    CREATE TABLE sources (id TEXT PRIMARY KEY,source_key TEXT,name TEXT,jurisdiction TEXT,base_url TEXT,language TEXT,is_active INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,source_id TEXT,source_key TEXT,jurisdiction TEXT,institution_name TEXT,content_type TEXT,original_url TEXT,canonical_url TEXT,
      original_language TEXT,original_title TEXT,korean_title TEXT,original_published_at TEXT,discovered_at TEXT,fetched_at TEXT,summarized_at TEXT,status TEXT,
      slug TEXT,raw_text TEXT,cleaned_text TEXT,summary_json TEXT,source_metadata TEXT,error_metadata TEXT,created_at TEXT,updated_at TEXT,catalog_ai_stale_v4 INTEGER DEFAULT 0,
      translation_status TEXT NOT NULL DEFAULT 'not_required',translation_started_at TEXT,translated_at TEXT,translation_provider TEXT,translation_model TEXT,
      translation_attempt_count INTEGER NOT NULL DEFAULT 0,translation_error_code TEXT,translation_error_summary TEXT,translation_next_attempt_at TEXT
    );
    CREATE UNIQUE INDEX articles_slug_key ON articles(slug);
    CREATE UNIQUE INDEX articles_canonical_url_key ON articles(canonical_url);
    CREATE TABLE case_identifiers_v1 (
      id TEXT PRIMARY KEY,article_id TEXT,source_key TEXT,identifier_type TEXT,identifier_scope TEXT,raw_value TEXT,normalized_value TEXT,
      normalization_version INTEGER,is_primary INTEGER,provenance_url TEXT,created_at TEXT
    );
    CREATE TABLE case_metadata_v1 (
      article_id TEXT PRIMARY KEY,source_key TEXT,authority_status TEXT,authority_evidence TEXT,constitutional_relevance_status TEXT,enrichment_status TEXT,
      enrichment_freshness TEXT,freshness_basis TEXT,text_access_policy TEXT,source_policy_version TEXT,discovery_source TEXT,authority_source TEXT,
      source_last_modified_at TEXT,source_etag TEXT,source_snapshot_hash TEXT,ai_priority INTEGER,created_at TEXT,updated_at TEXT
    );
    CREATE TABLE article_content_versions_p3 (
      id TEXT PRIMARY KEY,article_id TEXT,revision TEXT,parent_version_id TEXT,content_hash TEXT,provenance_actor_type TEXT,provenance_actor_id TEXT,
      slug TEXT,source_key TEXT,jurisdiction TEXT,institution_name TEXT,content_type TEXT,original_url TEXT,canonical_url TEXT,original_language TEXT,
      original_title TEXT,original_published_at TEXT,discovered_at TEXT,fetched_at TEXT,cleaned_text TEXT,summary_json TEXT,source_metadata TEXT,error_metadata TEXT,
      created_at TEXT,case_key TEXT,version_document_schema TEXT,version_role TEXT,case_metadata_snapshot TEXT,case_identifiers_snapshot TEXT,authority_evidence_hash TEXT,
      source_snapshot_id TEXT,source_snapshot_hash TEXT,source_content_hash TEXT,source_anchor_version_id TEXT,enrichment_source_content_hash TEXT
    );
    CREATE UNIQUE INDEX article_content_versions_p3_article_hash_key ON article_content_versions_p3(article_id,content_hash);
    CREATE TABLE article_revision_heads_v4 (article_id TEXT PRIMARY KEY,current_version_id TEXT,current_revision TEXT,updated_at TEXT);
    CREATE TABLE case_catalog_publications_v1 (
      id TEXT PRIMARY KEY,article_id TEXT,state TEXT,source_anchor_version_id TEXT,revision TEXT,source_policy_version TEXT,decided_by_type TEXT,
      decided_by_id TEXT,reason TEXT,published_at TEXT,withdrawn_at TEXT,created_at TEXT,updated_at TEXT
    );
    CREATE UNIQUE INDEX case_catalog_publications_v1_article_id_key ON case_catalog_publications_v1(article_id);
    CREATE TABLE case_catalog_publication_events_v1 (
      id TEXT PRIMARY KEY,publication_id TEXT,article_id TEXT,publication_revision TEXT,from_state TEXT,to_state TEXT,previous_source_anchor_version_id TEXT,
      next_source_anchor_version_id TEXT,idempotency_key TEXT,actor_type TEXT,actor_id TEXT,reason TEXT,occurred_at TEXT
    );
    CREATE UNIQUE INDEX case_catalog_publication_events_v1_article_key ON case_catalog_publication_events_v1(article_id,idempotency_key);
    CREATE TABLE case_catalog_cache_outbox_v1 (
      id TEXT PRIMARY KEY,event_key TEXT,article_id TEXT,publication_id TEXT,publication_revision TEXT,source_anchor_version_id TEXT,article_slug TEXT,created_at TEXT
    );
    CREATE UNIQUE INDEX case_catalog_cache_outbox_v1_event_key_key ON case_catalog_cache_outbox_v1(event_key);
  `);
  core.prepare(`INSERT INTO source_corpus_policies VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    "de-bverfg", "bverfg-unattended-canary-v2", "bounded_evidence",
    JSON.stringify(["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"]),
    "metadata_only",30_000, 1, "2027-03-15T00:00:00.000Z",
    JSON.stringify(["www.bundesverfassungsgericht.de"]), JSON.stringify(["www.bverfg.de"]), JSON.stringify(["dejure.org"]),
  );
  core.prepare(`INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "source-de-bverfg","de-bverfg","Federal Constitutional Court of Germany","Germany","https://www.bundesverfassungsgericht.de","de",1,
    new Date().toISOString(),new Date().toISOString(),
  );

  ops.exec(`
    CREATE TABLE admin_commands (id TEXT PRIMARY KEY,command_type TEXT,payload_ref TEXT);
    CREATE TABLE admin_command_runs (id TEXT PRIMARY KEY,command_id TEXT,status TEXT,current_attempt_id TEXT,abort_requested_at TEXT);
    CREATE TABLE admin_command_attempts (id TEXT PRIMARY KEY,run_id TEXT,status TEXT,fencing_token TEXT,lease_expires_at TEXT);
  `);

  ingest.exec(`
    CREATE TABLE source_inventory_snapshots (
      id TEXT PRIMARY KEY,source_key TEXT,scope_from TEXT,scope_to TEXT,document_type TEXT,discovery_method TEXT,
      parser_version TEXT,source_policy_version TEXT,coverage_assurance TEXT,expected_count INTEGER,expected_count_basis TEXT,
      coverage_evidence TEXT,discovered_count INTEGER,manifest_hash TEXT,status TEXT,exclusions TEXT,opened_at TEXT,closed_at TEXT,
      created_by TEXT,enumeration_manifest_hash TEXT
    );
    CREATE TABLE source_inventory_enumeration_artifacts (
      id TEXT PRIMARY KEY,snapshot_id TEXT,source_key TEXT,provider_key TEXT,artifact_kind TEXT,sequence_no INTEGER,request_url TEXT,
      response_hash TEXT,record_manifest_hash TEXT,record_count INTEGER,newest_decision_date TEXT,oldest_decision_date TEXT,
      observed_last_page INTEGER,safe_details TEXT,observed_at TEXT
    );
    CREATE TABLE source_backfill_runs (
      id TEXT PRIMARY KEY,snapshot_id TEXT,command_run_id TEXT,p1_attempt_id TEXT,p1_fencing_token TEXT,phase TEXT,pass_number INTEGER,
      status TEXT,claimed_count INTEGER DEFAULT 0,succeeded_count INTEGER DEFAULT 0,retryable_failed_count INTEGER DEFAULT 0,
      terminal_failed_count INTEGER DEFAULT 0,cursor_in TEXT,cursor_out TEXT,page_manifest_hash TEXT,heartbeat_at TEXT,started_at TEXT,
      completed_at TEXT,last_error_code TEXT,last_error_summary TEXT
    );
    CREATE TABLE source_backfill_items (
      id TEXT PRIMARY KEY,snapshot_id TEXT,source_key TEXT,stable_item_key TEXT,source_record_id TEXT,discovered_url TEXT,authority_url TEXT,
      document_type TEXT,discovered_decision_date_hint TEXT,status TEXT,attempt_count INTEGER DEFAULT 0,next_attempt_at TEXT,retry_phase TEXT,
      claimed_attempt_id TEXT,claimed_fencing_token TEXT,claimed_phase TEXT,lease_expires_at TEXT,http_status INTEGER,source_etag TEXT,
      source_last_modified_at TEXT,payload_hash TEXT,parser_version TEXT,current_fetch_artifact_id TEXT,current_normalization_artifact_id TEXT,
      verified_normalization_artifact_id TEXT,published_normalization_artifact_id TEXT,article_id TEXT,duplicate_of_item_id TEXT,exclusion_code TEXT,
      error_code TEXT,error_summary TEXT,waived_by TEXT,waived_at TEXT,waiver_reason TEXT,waiver_expires_at TEXT,first_seen_at TEXT,last_seen_at TEXT,
      updated_at TEXT,inventory_metadata TEXT DEFAULT '{}'
    );
    CREATE UNIQUE INDEX source_backfill_items_snapshot_stable_key_uidx ON source_backfill_items(snapshot_id,stable_item_key);
    CREATE UNIQUE INDEX source_inventory_enumeration_artifacts_identity_uidx
      ON source_inventory_enumeration_artifacts(snapshot_id,provider_key,artifact_kind,sequence_no);
    CREATE TABLE source_fetch_artifacts (
      id TEXT PRIMARY KEY,item_id TEXT,source_policy_version TEXT,authority_url TEXT,http_status INTEGER,response_headers_allowlist TEXT,
      source_etag TEXT,source_last_modified_at TEXT,payload_hash TEXT,payload_size TEXT,replayability TEXT,immutable_storage_ref TEXT,
      bounded_replay_payload TEXT,fetched_at TEXT,fetch_contract_version TEXT,created_at TEXT,bounded_replay_storage_ref TEXT,
      externalized_at TEXT,externalization_contract_version TEXT
    );
    CREATE TABLE source_normalization_artifacts (
      id TEXT PRIMARY KEY,item_id TEXT,fetch_artifact_id TEXT,parser_version TEXT,normalization_contract_version TEXT,normalized_output TEXT,
      normalized_output_hash TEXT,validation_status TEXT,validation_errors TEXT,created_at TEXT,normalized_output_storage_ref TEXT,
      normalized_output_size TEXT,externalized_at TEXT,externalization_contract_version TEXT
    );
    CREATE TABLE source_backfill_item_events (
      id TEXT PRIMARY KEY,item_id TEXT,attempt_id TEXT,
      event_type TEXT CHECK (event_type IN ('item_discovered','item_claimed','item_lease_extended','fetch_recorded','normalization_recorded','item_completed','item_failed','claim_released','verification_noop','item_excluded')),
      phase TEXT,safe_details TEXT,occurred_at TEXT
    );
    CREATE TABLE source_request_governor_states (
      source_key TEXT PRIMARY KEY,last_request_started_at TEXT,next_request_not_before TEXT,updated_at TEXT
    );
    CREATE TABLE source_request_permits (
      id TEXT PRIMARY KEY,source_key TEXT,source_policy_version TEXT,snapshot_id TEXT,phase TEXT,p1_attempt_id TEXT,p1_fencing_token TEXT,
      request_origin TEXT,acquired_at TEXT,lease_expires_at TEXT,released_at TEXT
    );
  `);

  return { core, ingest, ops };
}

function seed({ ingest, ops }: ReturnType<typeof createDatabases>, options: { attemptLeaseMs?: number } = {}) {
  const now = Date.now();
  const attemptLease = new Date(now + (options.attemptLeaseMs ?? 600_000)).toISOString();
  ops.prepare("INSERT INTO admin_commands VALUES (?,?,?)").run(
    COMMAND_ID,
    "p1.case-backfill.fetch",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 90, batchLimit: 1, fetchContractVersion: FETCH_CONTRACT }),
  );
  ops.prepare("INSERT INTO admin_command_runs VALUES (?,?,?,?,?)").run(COMMAND_RUN_ID, COMMAND_ID, "running", ATTEMPT_ID, null);
  ops.prepare("INSERT INTO admin_command_attempts VALUES (?,?,?,?,?)").run(ATTEMPT_ID, COMMAND_RUN_ID, "running", FENCE, attemptLease);

  ingest.prepare(`INSERT INTO source_inventory_snapshots
    (id,source_key,scope_from,scope_to,document_type,discovery_method,parser_version,source_policy_version,coverage_assurance,expected_count,
     expected_count_basis,coverage_evidence,discovered_count,manifest_hash,status,exclusions,opened_at,closed_at,created_by,enumeration_manifest_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    SNAPSHOT_ID,"de-bverfg","2022-12-31T15:00:00.000Z","2023-12-30T15:00:00.000Z","DECISION","external_index_dejure_paged_listing",
    "bverfg-normalize-v1","bverfg-unattended-canary-v2","external_index_assisted",null,null,"{}",1,"a".repeat(64),"closed","[]",
    new Date(now - 1000).toISOString(),new Date(now - 500).toISOString(),"test","b".repeat(64),
  );
  ingest.prepare(`INSERT INTO source_backfill_items
    (id,snapshot_id,source_key,stable_item_key,source_record_id,discovered_url,document_type,discovered_decision_date_hint,status,attempt_count,
     first_seen_at,last_seen_at,updated_at,inventory_metadata)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)`).run(
    ITEM_ID,SNAPSHOT_ID,"de-bverfg","stable-1","record-1","https://dejure.org/example","DECISION","2023-01-10","discovered",
    new Date(now - 1000).toISOString(),new Date(now - 1000).toISOString(),new Date(now - 1000).toISOString(),JSON.stringify({ docket: "1 BvR 1/23" }),
  );
  return { attemptLease };
}

function configure(databases: ReturnType<typeof createDatabases>) {
  setRuntimeD1Bindings({
    worldcons_core: binding(databases.core),
    worldcons_ingest: binding(databases.ingest),
    worldcons_ops: binding(databases.ops),
  });
}

function authority() {
  return { attemptId: ATTEMPT_ID, runId: COMMAND_RUN_ID, fencingToken: FENCE, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() };
}

afterEach(() => clearRuntimeD1Bindings());

test("D1 backfill snapshot/status reads preserve the existing metric semantics", async () => {
  const databases = createDatabases();
  seed(databases);
  configure(databases);
  try {
    const snapshot = await d1CaseBackfillRepository.getSnapshot(SNAPSHOT_ID);
    assert.equal(snapshot.sourceKey, "de-bverfg");
    assert.equal(snapshot.status, "closed");
    const status = await d1CaseBackfillRepository.getSnapshotStatus(SNAPSHOT_ID);
    assert.equal(status.discoveredTotal, 1);
    assert.equal(status.terminalTotal, 0);
    assert.equal(status.processingCompletion, 0);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 discovery opens, idempotently records inventory evidence, and closes a deterministic snapshot", async () => {
  const databases = createDatabases();
  const now = Date.now();
  const discoverSnapshotId = "55555555-5555-4555-8555-555555555555";
  databases.ops.prepare("INSERT INTO admin_commands VALUES (?,?,?)").run(
    COMMAND_ID,"p1.case-backfill.discover",JSON.stringify({ cohort: "catalog-backfill", snapshotId: discoverSnapshotId, passNumber: 1, batchLimit: 100 }),
  );
  databases.ops.prepare("INSERT INTO admin_command_runs VALUES (?,?,?,?,?)").run(COMMAND_RUN_ID,COMMAND_ID,"running",ATTEMPT_ID,null);
  databases.ops.prepare("INSERT INTO admin_command_attempts VALUES (?,?,?,?,?)").run(
    ATTEMPT_ID,COMMAND_RUN_ID,"running",FENCE,new Date(now + 600_000).toISOString(),
  );
  configure(databases);
  try {
    const snapshotId = await d1CaseBackfillRepository.openSnapshot({
      sourceKey: "de-bverfg",scopeFrom: "2023-01-01",scopeTo: "2023-12-31",documentType: "DECISION",
      discoveryMethod: "external_index_dejure_paged_listing",parserVersion: "bverfg-official-normalize-v2",
      sourcePolicyVersion: "bverfg-unattended-canary-v2",coverageAssurance: "external_index_assisted",
      expectedCount: null,expectedCountBasis: null,coverageEvidence: {},exclusions: [],createdBy: "test",
    });
    assert.notEqual(snapshotId, discoverSnapshotId);
    // Scope the live discover command to the generated snapshot, mirroring the control plane submit path.
    databases.ops.prepare("UPDATE admin_commands SET payload_ref=? WHERE id=?").run(
      JSON.stringify({ cohort: "catalog-backfill", snapshotId, passNumber: 1, batchLimit: 100 }),COMMAND_ID,
    );
    const itemId1 = await d1CaseBackfillRepository.upsertInventoryItem({
      snapshotId,stableItemKey: "dejure:2023-01-10:1bvr123",sourceRecordId: null,discoveredUrl: "https://dejure.org/dienste/vernetzung/rechtsprechung?Text=1%20BvR%201%2F23",
      documentType: "DECISION",decisionDateHint: "2023-01-10",inventoryMetadata: { docket: "1 BvR 1/23", officialUrlCandidates: [] },
    });
    const itemId2 = await d1CaseBackfillRepository.upsertInventoryItem({
      snapshotId,stableItemKey: "dejure:2023-01-10:1bvr123",sourceRecordId: null,discoveredUrl: "https://dejure.org/dienste/vernetzung/rechtsprechung?Text=1%20BvR%201%2F23",
      documentType: "DECISION",decisionDateHint: "2023-01-10",inventoryMetadata: { docket: "1 BvR 1/23", officialUrlCandidates: [] },
    });
    assert.equal(itemId2, itemId1);
    const authority = { attemptId: ATTEMPT_ID, runId: COMMAND_RUN_ID, fencingToken: FENCE, leaseExpiresAt: new Date(now + 600_000).toISOString() };
    const artifact = {
      providerKey: "dejure.org",artifactKind: "page" as const,sequenceNumber: 1,requestUrl: "https://dejure.org/dienste/vernetzung/rechtsprechung?gericht=BVerfG&jahr=2023",
      responseHash: "a".repeat(64),recordManifestHash: "b".repeat(64),recordCount: 1,newestDecisionDate: "2023-01-10",
      oldestDecisionDate: "2023-01-10",observedLastPage: 1,safeDetails: { page: 1, storesExternalText: false },
    };
    const artifactId1 = await d1CaseBackfillRepository.recordEnumerationArtifact({ snapshotId, authority, artifact });
    const artifactId2 = await d1CaseBackfillRepository.recordEnumerationArtifact({ snapshotId, authority, artifact });
    assert.equal(artifactId2, artifactId1);
    await d1CaseBackfillRepository.updateSnapshotEvidence(snapshotId, { method: "external_index_dejure_paged_listing" }, 1, "closed inventory count");
    const closed = await d1CaseBackfillRepository.closeSnapshot(snapshotId);
    assert.equal(closed.snapshotStatus, "closed");
    assert.equal(closed.discoveredTotal, 1);
    assert.match(closed.manifestHash ?? "", /^[0-9a-f]{64}$/);
    const row = databases.ingest.prepare("SELECT enumeration_manifest_hash FROM source_inventory_snapshots WHERE id=?").get(snapshotId) as Record<string, unknown>;
    assert.match(String(row.enumeration_manifest_hash), /^[0-9a-f]{64}$/);
    await assert.rejects(() => d1CaseBackfillRepository.upsertInventoryItem({
      snapshotId,stableItemKey: "new",sourceRecordId: null,discoveredUrl: "https://dejure.org/new",documentType: "DECISION",
      decisionDateHint: "2023-02-01",inventoryMetadata: {},
    }), /manifest_closed/);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 fetch claim is fenced and caps the item lease to the live P1 attempt", async () => {
  const databases = createDatabases();
  const { attemptLease } = seed(databases, { attemptLeaseMs: 45_000 });
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "fetch" as const, passNumber: 90, batchLimit: 1, fetchContractVersion: FETCH_CONTRACT };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    assert.equal(claimed.itemId, ITEM_ID);
    assert.ok(Date.parse(claimed.itemLeaseExpiresAt) <= Date.parse(attemptLease));
    const stored = databases.ingest.prepare("SELECT claimed_attempt_id,claimed_fencing_token,status FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(stored.claimed_attempt_id, ATTEMPT_ID);
    assert.equal(stored.claimed_fencing_token, FENCE);
    assert.equal(stored.status, "fetching");
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 request governor enforces approved host, concurrency and 30-second start spacing", async () => {
  const databases = createDatabases();
  seed(databases);
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "fetch" as const, passNumber: 90, batchLimit: 1, fetchContractVersion: FETCH_CONTRACT };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const first = await d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId: SNAPSHOT_ID, phase: "fetch", authority: authority(), requestOrigin: "https://www.bundesverfassungsgericht.de", requestedLeaseSeconds: 90,
    });
    assert.equal(first.granted, true);
    const second = await d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId: SNAPSHOT_ID, phase: "fetch", authority: authority(), requestOrigin: "https://www.bundesverfassungsgericht.de", requestedLeaseSeconds: 90,
    });
    assert.equal(second.granted, false);
    assert.ok(second.retryAfterMs > 0);
    await assert.rejects(() => d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId: SNAPSHOT_ID, phase: "fetch", authority: authority(), requestOrigin: "https://dejure.org", requestedLeaseSeconds: 90,
    }), /request_host_not_allowed/);
    await d1CaseBackfillRepository.releaseSourceRequestPermit({ permitId: first.permitId!, authority: authority() });
    const spacingOnly = await d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId: SNAPSHOT_ID, phase: "fetch", authority: authority(), requestOrigin: "https://www.bundesverfassungsgericht.de", requestedLeaseSeconds: 90,
    });
    assert.equal(spacingOnly.granted, false);
    assert.ok(spacingOnly.retryAfterMs >= 4_000, `expected spacing retry near the 5s poll cap, got ${spacingOnly.retryAfterMs}`);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 discover request governor accepts the approved external index and rejects other hosts", async () => {
  const databases = createDatabases();
  const now = Date.now();
  const snapshotId = "66666666-6666-4666-8666-666666666666";
  databases.ingest.prepare(`INSERT INTO source_inventory_snapshots
    (id,source_key,scope_from,scope_to,document_type,discovery_method,parser_version,source_policy_version,coverage_assurance,expected_count,
     expected_count_basis,coverage_evidence,discovered_count,manifest_hash,status,exclusions,opened_at,closed_at,created_by,enumeration_manifest_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    snapshotId,"de-bverfg","2022-01-01","2022-12-31","DECISION","external_index_dejure_paged_listing",
    "bverfg-official-normalize-v2","bverfg-unattended-canary-v2","external_index_assisted",null,null,"{}",0,null,"open","[]",
    new Date(now - 1000).toISOString(),null,"test",null,
  );
  databases.ops.prepare("INSERT INTO admin_commands VALUES (?,?,?)").run(
    COMMAND_ID,"p1.case-backfill.discover",JSON.stringify({ cohort: "catalog-backfill", snapshotId, passNumber: 1, batchLimit: 100 }),
  );
  databases.ops.prepare("INSERT INTO admin_command_runs VALUES (?,?,?,?,?)").run(COMMAND_RUN_ID,COMMAND_ID,"running",ATTEMPT_ID,null);
  databases.ops.prepare("INSERT INTO admin_command_attempts VALUES (?,?,?,?,?)").run(
    ATTEMPT_ID,COMMAND_RUN_ID,"running",FENCE,new Date(now + 600_000).toISOString(),
  );
  configure(databases);
  try {
    const discoverAuthority = authority();
    const runId = await d1CaseBackfillRepository.beginRun({
      cohort: "catalog-backfill",snapshotId,phase: "discover",passNumber: 1,batchLimit: 100,
    }, discoverAuthority);
    assert.ok(runId);
    const granted = await d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId,phase: "discover",authority: discoverAuthority,requestOrigin: "https://dejure.org",requestedLeaseSeconds: 90,
    });
    assert.equal(granted.granted, true);
    await d1CaseBackfillRepository.releaseSourceRequestPermit({ permitId: granted.permitId!, authority: discoverAuthority });
    await assert.rejects(() => d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId,phase: "discover",authority: discoverAuthority,requestOrigin: "https://example.com",requestedLeaseSeconds: 90,
    }), /request_host_not_allowed/);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 fetch artifact and completion transition clear the claim and preserve provenance", async () => {
  const databases = createDatabases();
  seed(databases);
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "fetch" as const, passNumber: 90, batchLimit: 1, fetchContractVersion: FETCH_CONTRACT };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    const artifactId = await d1CaseBackfillRepository.recordFetchArtifact({
      itemId: ITEM_ID, authority: authority(), sourcePolicyVersion: "bverfg-unattended-canary-v2",
      authorityUrl: "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/example.html", httpStatus: 200,
      responseHeaders: {}, sourceEtag: null, sourceLastModifiedAt: null, payloadHash: "c".repeat(64), payloadSize: 42,
      replayability: "bounded_evidence", immutableStorageRef: null, boundedReplayPayload: { sourceKey: "de-bverfg", url: "https://example.test" },
      fetchContractVersion: FETCH_CONTRACT,
    });
    await d1CaseBackfillRepository.completeItem({ itemId: ITEM_ID, phase: "fetch", authority: authority(), nextStatus: "fetched", resultMetadata: { artifactId } });
    const item = databases.ingest.prepare("SELECT status,current_fetch_artifact_id,claimed_attempt_id,payload_hash FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "fetched");
    assert.equal(item.current_fetch_artifact_id, artifactId);
    assert.equal(item.claimed_attempt_id, null);
    assert.equal(item.payload_hash, "c".repeat(64));
    assert.equal(databases.ingest.prepare("SELECT COUNT(*) AS count FROM source_backfill_item_events WHERE item_id=? AND event_type='item_completed'").get(ITEM_ID)?.count, 1);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 mutations fail closed after the P1 fence is reclaimed", async () => {
  const databases = createDatabases();
  seed(databases);
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "fetch" as const, passNumber: 90, batchLimit: 1, fetchContractVersion: FETCH_CONTRACT };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    databases.ops.prepare("UPDATE admin_command_runs SET current_attempt_id=? WHERE id=?").run("55555555-5555-4555-8555-555555555555", COMMAND_RUN_ID);
    await assert.rejects(
      () => d1CaseBackfillRepository.extendItems([ITEM_ID], "fetch", authority()),
      /stale_fence/,
    );
    const item = databases.ingest.prepare("SELECT claimed_attempt_id,claimed_fencing_token FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.claimed_attempt_id, ATTEMPT_ID);
    assert.equal(item.claimed_fencing_token, FENCE);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 normalize claim records a valid artifact and transitions fetched to normalized", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "66666666-6666-4666-8666-666666666666";
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2",
    "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/06/rk20230620_2bvr016616.html",
    200, "{}", "d".repeat(64), "42", "bounded_evidence",
    JSON.stringify({ sourceKey: "de-bverfg", url: "https://example.test", canonicalUrl: "https://example.test", contentType: "decision", text: "body" }),
    now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare("UPDATE source_backfill_items SET status='fetched',current_fetch_artifact_id=? WHERE id=?").run(fetchArtifactId, ITEM_ID);
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.normalize",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1, parserVersion: "bverfg-official-normalize-v2", normalizationContractVersion: "case-normalized-v1" }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const input = {
      cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "normalize" as const, passNumber: 1, batchLimit: 1,
      parserVersion: "bverfg-official-normalize-v2", normalizationContractVersion: "case-normalized-v1",
    };
    const runId = await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    assert.equal(claimed.currentFetchArtifactId, fetchArtifactId);
    assert.equal(claimed.resolutionStatus, "fetched");
    const artifactId = await d1CaseBackfillRepository.recordNormalizationArtifact({
      itemId: ITEM_ID, authority: authority(), fetchArtifactId,
      parserVersion: "bverfg-official-normalize-v2", normalizationContractVersion: "case-normalized-v1",
      normalizedOutput: {
        sourceKey: "de-bverfg", jurisdiction: "Germany", institutionName: "Federal Constitutional Court of Germany",
        contentType: "decision", originalUrl: "https://example.test", canonicalUrl: "https://example.test", originalLanguage: "de",
        cleanedText: "body", metadata: { sourceInventory: { docket: "1 BvR 1/23" } },
      },
      normalizedOutputHash: "e".repeat(64), validationStatus: "valid", validationErrors: [],
    });
    await d1CaseBackfillRepository.completeItem({
      itemId: ITEM_ID, phase: "normalize", authority: authority(), nextStatus: "normalized", resultMetadata: { artifactId },
    });
    const item = databases.ingest.prepare("SELECT status,current_normalization_artifact_id,parser_version,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "normalized");
    assert.equal(item.current_normalization_artifact_id, artifactId);
    assert.equal(item.parser_version, "bverfg-official-normalize-v2");
    assert.equal(item.claimed_attempt_id, null);
    await d1CaseBackfillRepository.finishRun({
      runId, authority: authority(), status: "succeeded", claimed: 1, succeeded: 1, retryableFailed: 0, terminalFailed: 0,
    });
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 normalize exclusion closes an unavailable official source without a normalization artifact", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "77777777-7777-4777-8777-777777777777";
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2",
    "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/06/rk20230620_2bvr016616.html",
    200, "{}", "f".repeat(64), "42", "bounded_evidence", JSON.stringify({ sourceKey: "de-bverfg" }), now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare("UPDATE source_backfill_items SET status='fetched',current_fetch_artifact_id=? WHERE id=?").run(fetchArtifactId, ITEM_ID);
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.normalize",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1, parserVersion: "bverfg-official-normalize-v2", normalizationContractVersion: "case-normalized-v1" }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const input = {
      cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "normalize" as const, passNumber: 1, batchLimit: 1,
      parserVersion: "bverfg-official-normalize-v2", normalizationContractVersion: "case-normalized-v1",
    };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    await d1CaseBackfillRepository.excludeItem({
      itemId: ITEM_ID, phase: "normalize", authority: authority(), exclusionCode: "official_source_unavailable",
    });
    const item = databases.ingest.prepare("SELECT status,exclusion_code,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "excluded");
    assert.equal(item.exclusion_code, "official_source_unavailable");
    assert.equal(item.claimed_attempt_id, null);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 verify claim transitions the current normalization artifact to verified", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "88888888-8888-4888-8888-888888888888";
  const normalizationArtifactId = "99999999-9999-4999-8999-999999999999";
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2",
    "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/06/rk20230620_2bvr016616.html",
    200, "{}", "1".repeat(64), "42", "bounded_evidence", JSON.stringify({ sourceKey: "de-bverfg" }), now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare(`INSERT INTO source_normalization_artifacts
    (id,item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,normalized_output_hash,validation_status,validation_errors,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    normalizationArtifactId, ITEM_ID, fetchArtifactId, "bverfg-official-normalize-v2", "case-normalized-v1",
    JSON.stringify({ sourceKey: "de-bverfg", canonicalUrl: "https://example.test" }), "2".repeat(64), "valid", "[]", now,
  );
  databases.ingest.prepare("UPDATE source_backfill_items SET status='normalized',current_fetch_artifact_id=?,current_normalization_artifact_id=?,parser_version=? WHERE id=?").run(
    fetchArtifactId, normalizationArtifactId, "bverfg-official-normalize-v2", ITEM_ID,
  );
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.verify",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1 }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "verify" as const, passNumber: 1, batchLimit: 1 };
    const runId = await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    assert.equal(claimed.currentNormalizationArtifactId, normalizationArtifactId);
    await d1CaseBackfillRepository.completeItem({
      itemId: ITEM_ID, phase: "verify", authority: authority(), nextStatus: "verified",
      resultMetadata: { artifactId: normalizationArtifactId, noop: false },
    });
    const item = databases.ingest.prepare("SELECT status,verified_normalization_artifact_id,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "verified");
    assert.equal(item.verified_normalization_artifact_id, normalizationArtifactId);
    assert.equal(item.claimed_attempt_id, null);
    await d1CaseBackfillRepository.finishRun({ runId, authority: authority(), status: "succeeded", claimed: 1, succeeded: 1, retryableFailed: 0, terminalFailed: 0 });
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 publish claim leases a verified item without mutating its public state", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const normalizationArtifactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2",
    "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/06/rk20230620_2bvr016616.html",
    200, "{}", "3".repeat(64), "42", "bounded_evidence", JSON.stringify({ sourceKey: "de-bverfg" }), now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare(`INSERT INTO source_normalization_artifacts
    (id,item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,normalized_output_hash,validation_status,validation_errors,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    normalizationArtifactId, ITEM_ID, fetchArtifactId, "bverfg-official-normalize-v2", "case-normalized-v1",
    JSON.stringify({ sourceKey: "de-bverfg", canonicalUrl: "https://example.test" }), "4".repeat(64), "valid", "[]", now,
  );
  databases.ingest.prepare(`UPDATE source_backfill_items
    SET status='verified',current_fetch_artifact_id=?,current_normalization_artifact_id=?,verified_normalization_artifact_id=?,parser_version=? WHERE id=?`).run(
    fetchArtifactId, normalizationArtifactId, normalizationArtifactId, "bverfg-official-normalize-v2", ITEM_ID,
  );
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.publish",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1 }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const input = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "publish" as const, passNumber: 1, batchLimit: 1 };
    await d1CaseBackfillRepository.beginRun(input, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(input, authority());
    assert.ok(claimed);
    assert.equal(claimed.resolutionStatus, "verified");
    assert.equal(claimed.verifiedNormalizationArtifactId, normalizationArtifactId);
    const item = databases.ingest.prepare("SELECT status,claimed_phase,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "verified");
    assert.equal(item.claimed_phase, "publish");
    assert.equal(item.claimed_attempt_id, ATTEMPT_ID);
    assert.equal(await d1CaseBackfillRepository.countBacklog(input), 1);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 backfill stage preserves verified corpus state and keeps the Catalog withdrawn", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const normalizationArtifactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const canonicalUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/01/rk20230110_1bvr000123.html";
  const normalizedOutput = {
    sourceKey: "de-bverfg", jurisdiction: "Germany", institutionName: "Federal Constitutional Court of Germany",
    contentType: "decision" as const, originalUrl: canonicalUrl, canonicalUrl, originalLanguage: "de",
    originalTitle: "1 BvR 1/23", originalPublishedAt: "2023-01-10T00:00:00.000Z", cleanedText: "Entscheidungstext",
    metadata: { caseNumber: "1 BvR 1/23", collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true } },
  };
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2", canonicalUrl, 200, "{}", "5".repeat(64), "42",
    "bounded_evidence", JSON.stringify({ sourceKey: "de-bverfg" }), now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare(`INSERT INTO source_normalization_artifacts
    (id,item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,normalized_output_hash,validation_status,validation_errors,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    normalizationArtifactId, ITEM_ID, fetchArtifactId, "bverfg-official-normalize-v2", "case-normalized-v1",
    JSON.stringify(normalizedOutput), "6".repeat(64), "valid", "[]", now,
  );
  databases.ingest.prepare(`UPDATE source_backfill_items
    SET status='verified',current_fetch_artifact_id=?,current_normalization_artifact_id=?,verified_normalization_artifact_id=?,parser_version=? WHERE id=?`).run(
    fetchArtifactId, normalizationArtifactId, normalizationArtifactId, "bverfg-official-normalize-v2", ITEM_ID,
  );
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.publish",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1 }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const pass = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "publish" as const, passNumber: 1, batchLimit: 1 };
    await d1CaseBackfillRepository.beginRun(pass, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(pass, authority());
    assert.ok(claimed);
    const publication = await d1CaseBackfillRepository.publishItem({
      itemId: ITEM_ID, authority: authority(), actorId: "test-publisher", normalizedOutput,
    });
    assert.ok(publication.articleId);
    assert.ok(publication.versionId);
    assert.equal(publication.versionRevision, 1);
    assert.equal(publication.publicationRevision, 1);
    const item = databases.ingest.prepare("SELECT status,article_id,published_normalization_artifact_id,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(item.status, "verified");
    assert.equal(item.article_id, publication.articleId);
    assert.equal(item.published_normalization_artifact_id, null);
    assert.equal(item.claimed_attempt_id, null);
    const article = databases.core.prepare("SELECT source_key,canonical_url,slug,status,source_metadata FROM articles WHERE id=?").get(publication.articleId) as Record<string, unknown>;
    assert.equal(article.source_key, "de-bverfg");
    assert.equal(article.canonical_url, canonicalUrl);
    assert.equal(article.slug, publication.articleSlug);
    assert.equal(article.status, "cleaned");
    const sourceMetadata = JSON.parse(String(article.source_metadata)) as Record<string, unknown>;
    assert.equal((sourceMetadata.collection as Record<string, unknown>).publishable, true);
    assert.equal(((sourceMetadata.case as Record<string, unknown>).collection as Record<string, unknown>).publishable, true);
    const version = databases.core.prepare("SELECT version_role,source_anchor_version_id,source_content_hash FROM article_content_versions_p3 WHERE id=?").get(publication.versionId) as Record<string, unknown>;
    assert.equal(version.version_role, "authoritative_source");
    assert.equal(version.source_anchor_version_id, publication.versionId);
    assert.equal(version.source_content_hash, "6".repeat(64));
    const catalog = databases.core.prepare("SELECT state,source_anchor_version_id,revision FROM case_catalog_publications_v1 WHERE article_id=?").get(publication.articleId) as Record<string, unknown>;
    assert.equal(catalog.state, "withdrawn");
    assert.equal(catalog.source_anchor_version_id, publication.versionId);
    assert.equal(catalog.revision, "1");
    assert.equal(databases.core.prepare("SELECT COUNT(*) AS count FROM case_catalog_publication_events_v1 WHERE article_id=?").get(publication.articleId)?.count, 1);
    assert.equal(databases.core.prepare("SELECT COUNT(*) AS count FROM case_catalog_cache_outbox_v1 WHERE article_id=?").get(publication.articleId)?.count, 1);

    databases.ingest.prepare(`UPDATE source_backfill_items SET
      status='verified',article_id=NULL,published_normalization_artifact_id=NULL,
      claimed_attempt_id=?,claimed_fencing_token=?,claimed_phase='publish',lease_expires_at=?,updated_at=?
      WHERE id=?`).run(
      ATTEMPT_ID,FENCE,new Date(Date.now() + 120_000).toISOString(),new Date().toISOString(),ITEM_ID,
    );
    const recovered = await d1CaseBackfillRepository.publishItem({
      itemId: ITEM_ID, authority: authority(), actorId: "test-publisher-recovery", normalizedOutput,
    });
    assert.deepEqual(recovered, publication);
    const recoveredItem = databases.ingest.prepare("SELECT status,article_id,published_normalization_artifact_id,claimed_attempt_id FROM source_backfill_items WHERE id=?").get(ITEM_ID) as Record<string, unknown>;
    assert.equal(recoveredItem.status, "verified");
    assert.equal(recoveredItem.article_id, publication.articleId);
    assert.equal(recoveredItem.published_normalization_artifact_id, null);
    assert.equal(recoveredItem.claimed_attempt_id, null);
    assert.equal(databases.core.prepare("SELECT COUNT(*) AS count FROM case_catalog_publication_events_v1 WHERE article_id=?").get(publication.articleId)?.count, 1);
    assert.equal(databases.core.prepare("SELECT COUNT(*) AS count FROM case_catalog_cache_outbox_v1 WHERE article_id=?").get(publication.articleId)?.count, 1);
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

test("D1 publish persists the canonical BVerfG docket identifier and version case_key without duplicates", async () => {
  const databases = createDatabases();
  seed(databases);
  const now = new Date().toISOString();
  const fetchArtifactId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const normalizationArtifactId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const canonicalUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/12/rk20231220_2bvr121621.html";
  const normalizedOutput = {
    sourceKey: "de-bverfg", jurisdiction: "Germany", institutionName: "Federal Constitutional Court of Germany",
    contentType: "decision" as const, originalUrl: canonicalUrl, canonicalUrl, originalLanguage: "de",
    originalTitle: "Beschluss der 2. Kammer", originalPublishedAt: "2023-12-20T00:00:00.000Z", cleanedText: "Entscheidungstext",
    metadata: {
      caseNumber: "2 BvR 1216/21",
      sourceInventory: { docket: "2 BvR 1216/21", docketKey: "2bvr121621" },
      collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true },
    },
  };
  databases.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, ITEM_ID, "bverfg-unattended-canary-v2", canonicalUrl, 200, "{}", "7".repeat(64), "42",
    "bounded_evidence", JSON.stringify({ sourceKey: "de-bverfg" }), now, FETCH_CONTRACT, now,
  );
  databases.ingest.prepare(`INSERT INTO source_normalization_artifacts
    (id,item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,normalized_output_hash,validation_status,validation_errors,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    normalizationArtifactId, ITEM_ID, fetchArtifactId, "bverfg-official-normalize-v2", "case-normalized-v1",
    JSON.stringify(normalizedOutput), "8".repeat(64), "valid", "[]", now,
  );
  databases.ingest.prepare(`UPDATE source_backfill_items
    SET status='verified',current_fetch_artifact_id=?,current_normalization_artifact_id=?,verified_normalization_artifact_id=?,parser_version=? WHERE id=?`).run(
    fetchArtifactId, normalizationArtifactId, normalizationArtifactId, "bverfg-official-normalize-v2", ITEM_ID,
  );
  databases.ops.prepare("UPDATE admin_commands SET command_type=?,payload_ref=? WHERE id=?").run(
    "p1.case-backfill.publish",
    JSON.stringify({ cohort: "catalog-backfill", snapshotId: SNAPSHOT_ID, passNumber: 1, batchLimit: 1 }),
    COMMAND_ID,
  );
  configure(databases);
  try {
    const pass = { cohort: "catalog-backfill" as const, snapshotId: SNAPSHOT_ID, phase: "publish" as const, passNumber: 1, batchLimit: 1 };
    await d1CaseBackfillRepository.beginRun(pass, authority());
    const [claimed] = await d1CaseBackfillRepository.claimItems(pass, authority());
    assert.ok(claimed);
    const publication = await d1CaseBackfillRepository.publishItem({
      itemId: ITEM_ID, authority: authority(), actorId: "test-publisher", normalizedOutput,
    });

    const version = databases.core.prepare("SELECT case_key,case_identifiers_snapshot FROM article_content_versions_p3 WHERE id=?").get(publication.versionId) as Record<string, unknown>;
    assert.equal(version.case_key, "2bvr121621");
    const snapshot = JSON.parse(String(version.case_identifiers_snapshot)) as Array<Record<string, unknown>>;
    assert.ok(snapshot.some((entry) => entry.type === "docket" && entry.normalizedValue === "2bvr121621"));

    const dockets = databases.core.prepare(
      "SELECT identifier_type,identifier_scope,raw_value,normalized_value,normalization_version,is_primary FROM case_identifiers_v1 WHERE article_id=? AND identifier_type='docket'",
    ).all(publication.articleId) as Record<string, unknown>[];
    assert.equal(dockets.length, 1, "exactly one docket identifier is persisted");
    assert.equal(dockets[0].identifier_scope, "decision");
    assert.equal(dockets[0].raw_value, "2 BvR 1216/21");
    assert.equal(dockets[0].normalized_value, "2bvr121621");
    assert.equal(dockets[0].normalization_version, 1);
    assert.equal(dockets[0].is_primary, 0);

    const sourceRecords = databases.core.prepare(
      "SELECT COUNT(*) AS count FROM case_identifiers_v1 WHERE article_id=? AND identifier_type='source_record_id'",
    ).get(publication.articleId) as Record<string, unknown>;
    assert.equal(sourceRecords.count, 1, "the source_record_id identifier is preserved");

    databases.ingest.prepare(`UPDATE source_backfill_items SET
      status='verified',article_id=NULL,published_normalization_artifact_id=NULL,
      claimed_attempt_id=?,claimed_fencing_token=?,claimed_phase='publish',lease_expires_at=?,updated_at=?
      WHERE id=?`).run(
      ATTEMPT_ID,FENCE,new Date(Date.now() + 120_000).toISOString(),new Date().toISOString(),ITEM_ID,
    );
    const recovered = await d1CaseBackfillRepository.publishItem({
      itemId: ITEM_ID, authority: authority(), actorId: "test-publisher-recovery", normalizedOutput,
    });
    assert.deepEqual(recovered, publication);
    const docketsAfterRecovery = databases.core.prepare(
      "SELECT COUNT(*) AS count FROM case_identifiers_v1 WHERE article_id=? AND identifier_type='docket'",
    ).get(publication.articleId) as Record<string, unknown>;
    assert.equal(docketsAfterRecovery.count, 1, "recovery never duplicates the docket identifier");
  } finally {
    databases.core.close(); databases.ingest.close(); databases.ops.close();
  }
});

