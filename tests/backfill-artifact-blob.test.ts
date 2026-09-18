import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ARTIFACT_BLOB_ACCESS,
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  isArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";
import {
  CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG,
  CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG,
  caseBackfillArtifactBlobFlagErrors,
  caseBackfillArtifactBlobReadEnabled,
  caseBackfillArtifactBlobReadReady,
  caseBackfillArtifactBlobWriteEnabled,
  caseBackfillArtifactBlobWriteReady,
} from "../lib/backfill/flags";

const migrationRoot = path.join(process.cwd(), "supabase/migrations");
const contractMigrationPath = path.join(migrationRoot, "20260918100000_artifact_blob_storage_contract.sql");
const gate1MigrationPath = path.join(migrationRoot, "20260903120000_constitutional_case_backfill_gate1.sql");

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

class FakeTransport implements ArtifactBlobTransport {
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: { pathname: string; body: Buffer; options: ArtifactBlobPutOptions }[] = [];
  mismatchNextPut = false;

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    if (this.mismatchNextPut) {
      this.mismatchNextPut = false;
      return { pathname: `${pathname}.mismatch` };
    }
    this.putCalls.push({ pathname, body: Buffer.from(body), options });
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    const stored = this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    const stored = this.objects.get(pathname);
    if (!stored) return { pathname: `${pathname}.missing`, size: 0 };
    return { pathname, size: stored.byteLength };
  }
}

test("artifact blob flags default to disabled and write requires read", () => {
  assert.equal(caseBackfillArtifactBlobWriteEnabled({}), false);
  assert.equal(caseBackfillArtifactBlobReadEnabled({}), false);
  assert.deepEqual(caseBackfillArtifactBlobFlagErrors({}), []);
  assert.equal(caseBackfillArtifactBlobWriteReady({}), false);
  assert.equal(caseBackfillArtifactBlobReadReady({}), false);

  const writeOnly = { [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true" };
  assert.equal(caseBackfillArtifactBlobWriteEnabled(writeOnly), true);
  assert.deepEqual(caseBackfillArtifactBlobFlagErrors(writeOnly), [
    `${CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG} requires ${CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG}`,
  ]);
  assert.equal(caseBackfillArtifactBlobWriteReady(writeOnly), false);

  const both = {
    [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true",
    [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true",
  };
  assert.equal(caseBackfillArtifactBlobWriteReady(both), true);
  assert.equal(caseBackfillArtifactBlobReadReady(both), true);
});

test("artifact storage refs are content addressed and reject non-ref values", () => {
  const hash = sha256Hex("hello");
  assert.equal(hash.length, 64);
  const ref = buildArtifactStorageRef("fetch", "es-tribunal-constitucional", hash);
  assert.equal(ref, `artifacts/fetch/es-tribunal-constitucional/${hash}.json`);
  assert.equal(isArtifactStorageRef(ref), true);
  assert.equal(isArtifactStorageRef("artifacts/fetch/es-tribunal-constitucional/nothex.json"), false);
  assert.equal(isArtifactStorageRef("https://store.private.blob.vercel-storage.com/token/abc"), false);
  assert.equal(isArtifactStorageRef("artifacts/fetch/secret-store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"), false);
  assert.throws(() => buildArtifactStorageRef("fetch", "Bad Source", hash), /invalid_source_key/);
  assert.throws(() => buildArtifactStorageRef("fetch", "es-tribunal-constitucional", "nope"), /invalid_sha256/);
  assert.throws(() => buildArtifactStorageRef("fetch", "token-store", hash), /insecure_ref/);
});

test("artifact blob store writes private content-addressed objects without URLs", async () => {
  const transport = new FakeTransport();
  const store = new ArtifactBlobStore(transport);
  const bytes = Buffer.from(JSON.stringify({ sourceKey: "es-tribunal-constitucional", text: "hello" }));
  const result = await store.put({ kind: "fetch", sourceKey: "es-tribunal-constitucional", bytes });

  assert.equal(result.sha256, sha256Hex(bytes));
  assert.equal(result.size, bytes.byteLength);
  assert.equal(result.storageRef, buildArtifactStorageRef("fetch", "es-tribunal-constitucional", result.sha256));
  assert.equal(result.contentType, "application/json");
  assert.equal(result.contractVersion, ARTIFACT_BLOB_CONTRACT_VERSION);
  assert.equal("url" in result, false);
  assert.equal("downloadUrl" in result, false);
  assert.doesNotMatch(result.storageRef, /https?:|blob\.vercel-storage\.com/);

  assert.equal(transport.putCalls.length, 1);
  assert.equal(transport.putCalls[0].options.access, ARTIFACT_BLOB_ACCESS);
  assert.equal(transport.putCalls[0].options.access, "private");
  assert.equal(transport.putCalls[0].options.addRandomSuffix, false);
  assert.equal(transport.putCalls[0].options.allowOverwrite, true);
  assert.equal(transport.putCalls[0].options.contentType, "application/json");
  assert.deepEqual(transport.putCalls[0].body, bytes);
});

test("artifact blob store reads by ref and fails closed", async () => {
  const transport = new FakeTransport();
  const store = new ArtifactBlobStore(transport);
  const bytes = Buffer.from("payload-bytes");
  const { storageRef } = await store.put({ kind: "normalization", sourceKey: "fr-conseil-constitutionnel", bytes });

  assert.deepEqual(await store.get(storageRef), bytes);
  assert.equal((await store.head(storageRef)).size, bytes.byteLength);

  await assert.rejects(() => store.get("artifacts/fetch/ok/nothex.json"), /invalid_ref/);
  const missing = buildArtifactStorageRef("normalization", "fr-conseil-constitutionnel", sha256Hex("missing"));
  await assert.rejects(() => store.get(missing), /not_found/);
  await assert.rejects(() => store.head("not-a-ref"), /invalid_ref/);
  await assert.rejects(() => store.head(`${missing}.missing`), /invalid_ref/);
});

test("artifact blob store refuses oversized payloads and mismatched uploads", async () => {
  const transport = new FakeTransport();
  const store = new ArtifactBlobStore(transport);
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);
  await assert.rejects(
    () => store.put({ kind: "fetch", sourceKey: "es-tribunal-constitucional", bytes: oversized }),
    /payload_too_large/,
  );
  assert.equal(transport.putCalls.length, 0);

  transport.mismatchNextPut = true;
  await assert.rejects(
    () => store.put({ kind: "fetch", sourceKey: "es-tribunal-constitucional", bytes: Buffer.from("x") }),
    /pathname_mismatch/,
  );
});

test("artifact blob migration is additive and preserves v1 fencing policies", () => {
  const sql = fs.readFileSync(contractMigrationPath, "utf8");
  const gate1 = fs.readFileSync(gate1MigrationPath, "utf8");

  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /source_backfill_fetch_artifact_record_v1/);
  assert.doesNotMatch(sql, /source_backfill_normalization_artifact_record_v1/);

  assert.match(sql, /add column if not exists bounded_replay_storage_ref text/);
  assert.match(sql, /add column if not exists normalized_output_storage_ref text/);
  assert.match(sql, /add column if not exists normalized_output_size bigint/);
  assert.match(sql, /create table if not exists source_artifact_externalization_ledger/);
  assert.match(sql, /create or replace function source_backfill_fetch_artifact_record_v2/);
  assert.match(sql, /create or replace function source_backfill_normalization_artifact_record_v2/);
  assert.match(sql, /source_backfill_assert_attempt_v1\(p_p1_attempt_id, p_p1_fencing_token, v_item\.snapshot_id, 'fetch'\)/);
  assert.match(sql, /source_backfill_assert_attempt_v1\(p_p1_attempt_id, p_p1_fencing_token, v_item\.snapshot_id, 'normalize'\)/);
  assert.match(sql, /CASE_BACKFILL_ITEM_LEASE_LOST/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, extensions, pg_temp/);
  assert.match(sql, /grant select on table source_artifact_externalization_ledger to service_role/);
  assert.match(sql, /grant execute on function source_backfill_fetch_artifact_record_v2/);
  assert.match(sql, /grant execute on function source_backfill_normalization_artifact_record_v2/);
  assert.match(sql, /artifacts\/fetch\/\[a-z\]/);
  assert.match(sql, /artifacts\/normalization\/\[a-z\]/);
  assert.match(sql, /!~\* '\(token\|secret\|signature\|credential\)'/);
  assert.match(sql, /source_fetch_artifacts_replay_check/);
  assert.match(sql, /source_normalization_artifacts_json_check/);

  assert.match(gate1, /create or replace function source_backfill_fetch_artifact_record_v1/);
  assert.match(gate1, /create or replace function source_backfill_normalization_artifact_record_v1/);
});
