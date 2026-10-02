import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { clearRuntimeD1Bindings, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import {
  GERMANY_2023_BACKFILL_SNAPSHOT_ID,
  GERMANY_2024_BACKFILL_SNAPSHOT_ID,
  germanyBackfillSourcePolicyVersion,
  isGermanyBackfillRetryableError,
  parseGermanyBackfillFetchPayload,
  runGermanyBackfillFetchPass,
  type GermanyBackfillFetchEnv,
} from "../workers/async-pipeline/src/backfill-fetch";
import {
  parseGermanyBackfillNormalizePayload,
  runGermanyBackfillNormalizePass,
  type GermanyBackfillNormalizeEnv,
} from "../workers/async-pipeline/src/backfill-normalize";
import {
  parseGermanyBackfillVerifyPayload,
  runGermanyBackfillVerifyPass,
  type GermanyBackfillVerifyEnv,
} from "../workers/async-pipeline/src/backfill-verify";
import { parseGermanyBackfillPublishPayload } from "../workers/async-pipeline/src/backfill-publish";
import type { ArtifactBlobR2Bucket } from "../lib/storage/blob";

function d1(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async all<T>() {
          try {
            return {
              success: true,
              results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
              meta: { changes: 0 },
            };
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
      return statement;
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

function databases() {
  const core = new DatabaseSync(":memory:");
  const ingest = new DatabaseSync(":memory:");
  const ops = new DatabaseSync(":memory:");

  core.exec(`
    CREATE TABLE source_corpus_policies (
      source_key TEXT NOT NULL, policy_version TEXT NOT NULL, normalize_replay_policy TEXT NOT NULL,
      bounded_replay_fields TEXT NOT NULL, min_request_delay_ms INTEGER NOT NULL, max_concurrency INTEGER NOT NULL,
      review_due_at TEXT NOT NULL, authority_hosts TEXT NOT NULL, redirect_hosts TEXT NOT NULL, external_index_hosts TEXT NOT NULL
    );
  `);
  core.prepare("INSERT INTO source_corpus_policies VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "de-bverfg", "bverfg-unattended-canary-v2", "bounded_evidence",
    JSON.stringify(["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"]),
    30_000, 1, "2027-03-15T00:00:00.000Z",
    JSON.stringify(["www.bundesverfassungsgericht.de"]), JSON.stringify(["www.bverfg.de"]), JSON.stringify(["dejure.org"]),
  );

  ops.exec(`
    CREATE TABLE admin_commands (
      id TEXT PRIMARY KEY, command_type TEXT NOT NULL, payload_ref TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT NOT NULL,
      requested_by TEXT, priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE admin_command_runs (
      id TEXT PRIMARY KEY, command_id TEXT NOT NULL, run_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      dedupe_key TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, max_attempts INTEGER NOT NULL DEFAULT 3,
      retry_backoff_base_seconds INTEGER NOT NULL DEFAULT 15, retry_backoff_cap_seconds INTEGER NOT NULL DEFAULT 900,
      retry_count INTEGER NOT NULL DEFAULT 0, current_attempt_id TEXT, abort_requested_at TEXT, abort_requested_by TEXT, abort_reason TEXT,
      started_at TEXT, finished_at TEXT, terminal_error_code TEXT, terminal_error_message TEXT, result_summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_command_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, worker_id TEXT NOT NULL,
      fencing_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      failure_disposition TEXT, error_code TEXT, error_message TEXT, result_summary TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_command_events (
      id TEXT PRIMARY KEY, command_id TEXT NOT NULL, run_id TEXT, attempt_id TEXT, event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, safe_details TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL
    );
  `);

  ingest.exec(`
    CREATE TABLE source_inventory_snapshots (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL, scope_from TEXT, scope_to TEXT, document_type TEXT NOT NULL, discovery_method TEXT NOT NULL,
      parser_version TEXT NOT NULL, source_policy_version TEXT NOT NULL, coverage_assurance TEXT NOT NULL, expected_count INTEGER,
      expected_count_basis TEXT, coverage_evidence TEXT NOT NULL DEFAULT '{}', discovered_count INTEGER NOT NULL DEFAULT 0,
      manifest_hash TEXT, status TEXT NOT NULL DEFAULT 'open', exclusions TEXT NOT NULL DEFAULT '[]', opened_at TEXT NOT NULL,
      closed_at TEXT, created_by TEXT NOT NULL, enumeration_manifest_hash TEXT
    );
    CREATE TABLE source_backfill_runs (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, command_run_id TEXT, p1_attempt_id TEXT, p1_fencing_token TEXT,
      phase TEXT NOT NULL, pass_number INTEGER NOT NULL, status TEXT NOT NULL, claimed_count INTEGER NOT NULL DEFAULT 0,
      succeeded_count INTEGER NOT NULL DEFAULT 0, retryable_failed_count INTEGER NOT NULL DEFAULT 0, terminal_failed_count INTEGER NOT NULL DEFAULT 0,
      cursor_in TEXT, cursor_out TEXT, page_manifest_hash TEXT, heartbeat_at TEXT, started_at TEXT NOT NULL, completed_at TEXT,
      last_error_code TEXT, last_error_summary TEXT
    );
    CREATE TABLE source_backfill_items (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, source_key TEXT NOT NULL, stable_item_key TEXT NOT NULL, source_record_id TEXT,
      discovered_url TEXT NOT NULL, authority_url TEXT, document_type TEXT, discovered_decision_date_hint TEXT, status TEXT NOT NULL DEFAULT 'discovered',
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, retry_phase TEXT, claimed_attempt_id TEXT, claimed_fencing_token TEXT,
      claimed_phase TEXT, lease_expires_at TEXT, http_status INTEGER, source_etag TEXT, source_last_modified_at TEXT, payload_hash TEXT,
      parser_version TEXT, current_fetch_artifact_id TEXT, current_normalization_artifact_id TEXT, verified_normalization_artifact_id TEXT,
      published_normalization_artifact_id TEXT, article_id TEXT, duplicate_of_item_id TEXT, exclusion_code TEXT, error_code TEXT, error_summary TEXT,
      waived_by TEXT, waived_at TEXT, waiver_reason TEXT, waiver_expires_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, inventory_metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE source_fetch_artifacts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, source_policy_version TEXT NOT NULL, authority_url TEXT NOT NULL, http_status INTEGER NOT NULL,
      response_headers_allowlist TEXT NOT NULL DEFAULT '{}', source_etag TEXT, source_last_modified_at TEXT, payload_hash TEXT NOT NULL,
      payload_size TEXT NOT NULL, replayability TEXT NOT NULL, immutable_storage_ref TEXT, bounded_replay_payload TEXT, fetched_at TEXT NOT NULL,
      fetch_contract_version TEXT NOT NULL, created_at TEXT NOT NULL, bounded_replay_storage_ref TEXT, externalized_at TEXT,
      externalization_contract_version TEXT
    );
    CREATE TABLE source_normalization_artifacts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, fetch_artifact_id TEXT NOT NULL, parser_version TEXT NOT NULL,
      normalization_contract_version TEXT NOT NULL, normalized_output TEXT, normalized_output_hash TEXT NOT NULL, validation_status TEXT NOT NULL,
      validation_errors TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, normalized_output_storage_ref TEXT, normalized_output_size TEXT,
      externalized_at TEXT, externalization_contract_version TEXT
    );
    CREATE TABLE source_backfill_item_events (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, attempt_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('item_discovered','item_claimed','item_lease_extended','fetch_recorded','normalization_recorded','item_completed','item_failed','claim_released','verification_noop','item_excluded','catalog_published')),
      phase TEXT, safe_details TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL
    );
    CREATE TABLE source_request_governor_states (
      source_key TEXT PRIMARY KEY, last_request_started_at TEXT, next_request_not_before TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE source_request_permits (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL, source_policy_version TEXT NOT NULL, snapshot_id TEXT NOT NULL, phase TEXT NOT NULL,
      p1_attempt_id TEXT NOT NULL, p1_fencing_token TEXT NOT NULL, request_origin TEXT NOT NULL, acquired_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL, released_at TEXT
    );
  `);

  const now = new Date().toISOString();
  ingest.prepare(`INSERT INTO source_inventory_snapshots
    (id,source_key,scope_from,scope_to,document_type,discovery_method,parser_version,source_policy_version,coverage_assurance,
     coverage_evidence,discovered_count,status,exclusions,opened_at,closed_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    GERMANY_2023_BACKFILL_SNAPSHOT_ID, "de-bverfg", "2023-01-01", "2023-12-31", "DECISION", "external_index_dejure_paged_listing",
    "bverfg-normalize-v1", "bverfg-unattended-canary-v2", "external_index_assisted", "{}", 1, "closed", "[]", now, now, "test",
  );
  const officialUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2023/06/rk20230620_2bvr016616.html";
  ingest.prepare(`INSERT INTO source_backfill_items
    (id,snapshot_id,source_key,stable_item_key,discovered_url,document_type,discovered_decision_date_hint,status,first_seen_at,last_seen_at,updated_at,inventory_metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "item-1", GERMANY_2023_BACKFILL_SNAPSHOT_ID, "de-bverfg", "dejure:2023-06-20:2bvr16616", officialUrl,
    "DECISION", "2023-06-20", "discovered", now, now, now,
    JSON.stringify({ decisionDate: "2023-06-20", docket: "2 BvR 166/16", officialUrlCandidates: [officialUrl] }),
  );

  const env: GermanyBackfillFetchEnv = {
    WORLDCONS_CORE: d1(core), WORLDCONS_INGEST: d1(ingest), WORLDCONS_OPS: d1(ops), CASE_CATALOG_GERMANY_HISTORY_ENABLED: "true",
  };
  return { core, ingest, ops, env, officialUrl };
}

function memoryR2(): ArtifactBlobR2Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
      return {};
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        size: value.byteLength,
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } }),
      };
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength } : null;
    },
  };
}

function seedFetchedForNormalize(state: ReturnType<typeof databases>, sourceUrlVerified = true) {
  const now = new Date().toISOString();
  const fetchArtifactId = "normalize-fetch-artifact-1";
  const raw = {
    sourceKey: "de-bverfg",
    url: state.officialUrl,
    canonicalUrl: state.officialUrl,
    title: "2 BvR 166/16",
    publishedAt: "2023-06-20T00:00:00.000Z",
    contentType: "decision",
    text: "Entscheidungstext ".repeat(80),
    metadata: {
      collection: { sourceUrlVerified, publishable: sourceUrlVerified, sourceTextAvailable: sourceUrlVerified },
      sourceInventory: { decisionDate: "2023-06-20", docket: "2 BvR 166/16" },
    },
  };
  const document = JSON.stringify(raw);
  const hash = createHash("sha256").update(document).digest("hex");
  state.ingest.prepare(`INSERT INTO source_fetch_artifacts
    (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,payload_hash,payload_size,replayability,
     bounded_replay_payload,fetched_at,fetch_contract_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fetchArtifactId, "item-1", "bverfg-unattended-canary-v2", state.officialUrl, 200, "{}", hash, String(Buffer.byteLength(document)),
    "bounded_evidence", document, now, "bverfg-official-fetch-v1", now,
  );
  state.ingest.prepare("UPDATE source_backfill_items SET status='fetched',current_fetch_artifact_id=? WHERE id='item-1'").run(fetchArtifactId);
}

afterEach(() => clearRuntimeD1Bindings());

test("Workflow payload normalization accepts Cloudflare API JSON-string params and rejects extra fields", () => {
  const parsed = parseGermanyBackfillFetchPayload(JSON.stringify({
    snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
    phase: "fetch",
    passNumber: 90,
    batchLimit: 1,
    maxPasses: 4,
    fetchContractVersion: "bverfg-official-fetch-v1",
    requestedBy: "api",
  }));
  assert.ok(parsed);
  assert.equal(parsed.passNumber, 90);
  assert.equal(parsed.maxPasses, 4);
  assert.equal(parseGermanyBackfillFetchPayload(JSON.stringify({ ...parsed, unexpected: true })), null);
  assert.equal(parseGermanyBackfillFetchPayload(JSON.stringify({ ...parsed, maxPasses: 0 })), null);
  assert.equal(parseGermanyBackfillFetchPayload(JSON.stringify({ ...parsed, maxPasses: 26 })), null);
  assert.ok(parseGermanyBackfillFetchPayload(JSON.stringify({ ...parsed, snapshotId: GERMANY_2024_BACKFILL_SNAPSHOT_ID })));
});

test("permit wait exhaustion is retryable rather than terminal", () => {
  assert.equal(isGermanyBackfillRetryableError(new Error("case_backfill.request_permit_wait_exhausted")), true);
});

test("Germany backfill snapshot policy mapping preserves historical snapshot policy versions", () => {
  assert.equal(germanyBackfillSourcePolicyVersion(GERMANY_2023_BACKFILL_SNAPSHOT_ID), "bverfg-unattended-canary-v2");
  assert.equal(germanyBackfillSourcePolicyVersion(GERMANY_2024_BACKFILL_SNAPSHOT_ID), "bverfg-unattended-canary-v1");
  assert.equal(germanyBackfillSourcePolicyVersion("11111111-1111-4111-8111-111111111111"), null);
});

test("Germany 2023 Workflow executor closes one bounded D1 fetch pass end-to-end", async () => {
  const state = databases();
  try {
    const result = await runGermanyBackfillFetchPass(state.env, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "fetch",
      passNumber: 1,
      batchLimit: 1,
      fetchContractVersion: "bverfg-official-fetch-v1",
      requestedBy: "test",
    }, {
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        assert.equal(String(input), state.officialUrl);
        return new Response(`<html><head><title>Bundesverfassungsgericht - 2 BvR 166/16</title></head><body><main><h1>2 BvR 166/16</h1><p>${"Entscheidungstext ".repeat(80)}</p></main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", etag: "test-etag" },
        });
      },
    });

    assert.equal(result.claimed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.retryableFailed, 0);
    assert.equal(result.terminalFailed, 0);
    assert.equal(result.backlogRemaining, false);

    const item = state.ingest.prepare("SELECT status,current_fetch_artifact_id,claimed_attempt_id,payload_hash FROM source_backfill_items WHERE id='item-1'").get() as Record<string, unknown>;
    assert.equal(item.status, "fetched");
    assert.equal(item.claimed_attempt_id, null);
    assert.equal(typeof item.current_fetch_artifact_id, "string");
    assert.match(String(item.payload_hash), /^[0-9a-f]{64}$/);

    const artifact = state.ingest.prepare("SELECT source_policy_version,authority_url,replayability,fetch_contract_version,bounded_replay_payload FROM source_fetch_artifacts LIMIT 1").get() as Record<string, unknown>;
    assert.equal(artifact.source_policy_version, "bverfg-unattended-canary-v2");
    assert.equal(artifact.authority_url, state.officialUrl);
    assert.equal(artifact.replayability, "bounded_evidence");
    assert.equal(artifact.fetch_contract_version, "bverfg-official-fetch-v1");
    const replay = JSON.parse(String(artifact.bounded_replay_payload)) as Record<string, unknown>;
    assert.equal(replay.sourceKey, "de-bverfg");
    assert.equal((replay.metadata as Record<string, unknown>).sourceInventory instanceof Object, true);

    const backfillRun = state.ingest.prepare("SELECT status,claimed_count,succeeded_count FROM source_backfill_runs LIMIT 1").get() as Record<string, unknown>;
    assert.equal(backfillRun.status, "succeeded");
    assert.equal(backfillRun.claimed_count, 1);
    assert.equal(backfillRun.succeeded_count, 1);

    const commandRun = state.ops.prepare("SELECT status,result_summary FROM admin_command_runs LIMIT 1").get() as Record<string, unknown>;
    assert.equal(commandRun.status, "succeeded");
    assert.equal(JSON.parse(String(commandRun.result_summary)).succeeded, 1);

    const permits = state.ingest.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN released_at IS NOT NULL THEN 1 ELSE 0 END) AS released FROM source_request_permits").get() as Record<string, unknown>;
    assert.equal(permits.total, 1);
    assert.equal(permits.released, 1);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("Germany fetch Workflow fails closed outside the approved Germany snapshots", async () => {
  const state = databases();
  try {
    await assert.rejects(() => runGermanyBackfillFetchPass(state.env, {
      snapshotId: "11111111-1111-4111-8111-111111111111",
      phase: "fetch",
      passNumber: 1,
    }), /germany_snapshot_not_approved/);
    assert.equal((state.ops.prepare("SELECT COUNT(*) AS count FROM admin_commands").get() as { count: number }).count, 0);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("Germany fetch records metadata-only evidence instead of terminal failure for an unavailable official detail", async () => {
  const state = databases();
  try {
    const result = await runGermanyBackfillFetchPass(state.env, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "fetch",
      passNumber: 1,
      batchLimit: 1,
      fetchContractVersion: "bverfg-official-fetch-v1",
      requestedBy: "test-metadata-only",
    }, {
      sleep: async () => undefined,
      fetchImpl: async () => new Response("blocked", { status: 400, headers: { "content-type": "text/html" } }),
    });
    assert.equal(result.succeeded, 1);
    assert.equal(result.terminalFailed, 0);
    const item = state.ingest.prepare("SELECT status,error_code,current_fetch_artifact_id FROM source_backfill_items WHERE id='item-1'").get() as Record<string, unknown>;
    assert.equal(item.status, "fetched");
    assert.equal(item.error_code, null);
    const artifact = state.ingest.prepare("SELECT bounded_replay_payload FROM source_fetch_artifacts WHERE id=?").get(String(item.current_fetch_artifact_id)) as Record<string, unknown>;
    const replay = JSON.parse(String(artifact.bounded_replay_payload)) as { metadata: { collection: { sourceUrlVerified: boolean; publishable: boolean } } };
    assert.equal(replay.metadata.collection.sourceUrlVerified, false);
    assert.equal(replay.metadata.collection.publishable, false);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("Germany fetch does not spend another governed request on the BVerfG error redirect", async () => {
  const state = databases();
  let calls = 0;
  try {
    const result = await runGermanyBackfillFetchPass(state.env, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "fetch",
      passNumber: 1,
      batchLimit: 1,
      fetchContractVersion: "bverfg-official-fetch-v1",
      requestedBy: "test-error-redirect",
    }, {
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 303,
          headers: { location: "https://www.bundesverfassungsgericht.de/error_path/400.html?test=1" },
        });
      },
    });
    assert.equal(result.succeeded, 1);
    assert.equal(result.terminalFailed, 0);
    assert.equal(calls, 1);
    const artifact = state.ingest.prepare("SELECT bounded_replay_payload FROM source_fetch_artifacts LIMIT 1").get() as Record<string, unknown>;
    const replay = JSON.parse(String(artifact.bounded_replay_payload)) as { metadata: { authorityFetchError: string } };
    assert.equal(replay.metadata.authorityFetchError, "case_backfill.bverfg_error_redirect");
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("normalize Workflow payload accepts bounded Germany normalize passes only", () => {
  const parsed = parseGermanyBackfillNormalizePayload(JSON.stringify({
    snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
    phase: "normalize",
    passNumber: 1,
    batchLimit: 25,
    maxPasses: 4,
    parserVersion: "bverfg-official-normalize-v2",
    normalizationContractVersion: "case-normalized-v1",
  }));
  assert.ok(parsed);
  assert.equal(parsed.batchLimit, 25);
  assert.ok(parseGermanyBackfillNormalizePayload(JSON.stringify({ ...parsed, snapshotId: GERMANY_2024_BACKFILL_SNAPSHOT_ID })));
  assert.equal(parseGermanyBackfillNormalizePayload(JSON.stringify({ ...parsed, batchLimit: 51 })), null);
  assert.equal(parseGermanyBackfillNormalizePayload(JSON.stringify({ ...parsed, parserVersion: "other" })), null);
});

test("Germany normalize executor externalizes a valid normalized artifact to R2", async () => {
  const state = databases();
  const bucket = memoryR2();
  seedFetchedForNormalize(state, true);
  try {
    const env: GermanyBackfillNormalizeEnv = { ...state.env, WORLDCONS_RAW: bucket };
    const result = await runGermanyBackfillNormalizePass(env, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "normalize",
      passNumber: 1,
      batchLimit: 1,
      parserVersion: "bverfg-official-normalize-v2",
      normalizationContractVersion: "case-normalized-v1",
      requestedBy: "test-normalize",
    });
    assert.equal(result.claimed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.terminalFailed, 0);
    const item = state.ingest.prepare("SELECT status,current_normalization_artifact_id,parser_version,claimed_attempt_id FROM source_backfill_items WHERE id='item-1'").get() as Record<string, unknown>;
    assert.equal(item.status, "normalized");
    assert.equal(item.parser_version, "bverfg-official-normalize-v2");
    assert.equal(item.claimed_attempt_id, null);
    const artifact = state.ingest.prepare("SELECT normalized_output,normalized_output_storage_ref,externalization_contract_version,validation_status FROM source_normalization_artifacts WHERE id=?").get(String(item.current_normalization_artifact_id)) as Record<string, unknown>;
    assert.equal(artifact.normalized_output, null);
    assert.match(String(artifact.normalized_output_storage_ref), /^artifacts\/normalization\/de-bverfg\/[0-9a-f]{64}\.json$/);
    assert.equal(artifact.externalization_contract_version, "worldcons-artifact-blob-v1");
    assert.equal(artifact.validation_status, "valid");
    assert.equal(bucket.objects.size, 1);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("Germany normalize executor explicitly excludes metadata-only official source failures", async () => {
  const state = databases();
  const bucket = memoryR2();
  seedFetchedForNormalize(state, false);
  try {
    const env: GermanyBackfillNormalizeEnv = { ...state.env, WORLDCONS_RAW: bucket };
    const result = await runGermanyBackfillNormalizePass(env, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "normalize",
      passNumber: 1,
      batchLimit: 1,
      requestedBy: "test-normalize-exclusion",
    });
    assert.equal(result.succeeded, 1);
    const item = state.ingest.prepare("SELECT status,exclusion_code,current_normalization_artifact_id FROM source_backfill_items WHERE id='item-1'").get() as Record<string, unknown>;
    assert.equal(item.status, "excluded");
    assert.equal(item.exclusion_code, "official_source_unavailable");
    assert.equal(item.current_normalization_artifact_id, null);
    assert.equal(bucket.objects.size, 0);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

test("verify Workflow payload accepts bounded Germany verify passes only", () => {
  const parsed = parseGermanyBackfillVerifyPayload(JSON.stringify({
    snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
    phase: "verify",
    passNumber: 1,
    batchLimit: 25,
    maxPasses: 4,
    requestedBy: "test-verify",
  }));
  assert.ok(parsed);
  assert.equal(parsed.batchLimit, 25);
  assert.equal(parsed.maxPasses, 4);
  assert.ok(parseGermanyBackfillVerifyPayload(JSON.stringify({ ...parsed, snapshotId: GERMANY_2024_BACKFILL_SNAPSHOT_ID })));
  assert.equal(parseGermanyBackfillVerifyPayload(JSON.stringify({ ...parsed, batchLimit: 51 })), null);
  assert.equal(parseGermanyBackfillVerifyPayload(JSON.stringify({ ...parsed, maxPasses: 26 })), null);
  assert.equal(parseGermanyBackfillVerifyPayload(JSON.stringify({ ...parsed, phase: "publish" })), null);
});

test("publish Workflow payload keeps Germany publication batches tightly bounded", () => {
  const parsed = parseGermanyBackfillPublishPayload(JSON.stringify({
    snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
    phase: "publish",
    passNumber: 1,
    batchLimit: 10,
    maxPasses: 2,
    requestedBy: "test-publish",
  }));
  assert.ok(parsed);
  assert.equal(parsed.batchLimit, 10);
  assert.equal(parsed.maxPasses, 2);
  assert.ok(parseGermanyBackfillPublishPayload(JSON.stringify({ ...parsed, snapshotId: GERMANY_2024_BACKFILL_SNAPSHOT_ID })));
  assert.equal(parseGermanyBackfillPublishPayload(JSON.stringify({ ...parsed, batchLimit: 26 })), null);
  assert.equal(parseGermanyBackfillPublishPayload(JSON.stringify({ ...parsed, maxPasses: 11 })), null);
  assert.equal(parseGermanyBackfillPublishPayload(JSON.stringify({ ...parsed, phase: "verify" })), null);
});

test("Germany verify executor validates R2 normalization evidence and transitions normalized to verified", async () => {
  const state = databases();
  const bucket = memoryR2();
  seedFetchedForNormalize(state, true);
  try {
    const normalizeEnv: GermanyBackfillNormalizeEnv = { ...state.env, WORLDCONS_RAW: bucket };
    const normalized = await runGermanyBackfillNormalizePass(normalizeEnv, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "normalize",
      passNumber: 1,
      batchLimit: 1,
      requestedBy: "test-normalize-before-verify",
    });
    assert.equal(normalized.succeeded, 1);

    const verifyEnv: GermanyBackfillVerifyEnv = { ...state.env, WORLDCONS_RAW: bucket };
    const verified = await runGermanyBackfillVerifyPass(verifyEnv, {
      snapshotId: GERMANY_2023_BACKFILL_SNAPSHOT_ID,
      phase: "verify",
      passNumber: 1,
      batchLimit: 1,
      requestedBy: "test-verify",
    });
    assert.equal(verified.claimed, 1);
    assert.equal(verified.succeeded, 1);
    assert.equal(verified.retryableFailed, 0);
    assert.equal(verified.terminalFailed, 0);
    assert.equal(verified.backlogRemaining, false);

    const item = state.ingest.prepare(`
      SELECT status,current_normalization_artifact_id,verified_normalization_artifact_id,claimed_attempt_id
      FROM source_backfill_items WHERE id='item-1'
    `).get() as Record<string, unknown>;
    assert.equal(item.status, "verified");
    assert.equal(item.verified_normalization_artifact_id, item.current_normalization_artifact_id);
    assert.equal(item.claimed_attempt_id, null);
    const verifyRun = state.ingest.prepare("SELECT status,claimed_count,succeeded_count FROM source_backfill_runs WHERE phase='verify' LIMIT 1").get() as Record<string, unknown>;
    assert.equal(verifyRun.status, "succeeded");
    assert.equal(verifyRun.claimed_count, 1);
    assert.equal(verifyRun.succeeded_count, 1);
  } finally {
    state.core.close(); state.ingest.close(); state.ops.close();
  }
});

