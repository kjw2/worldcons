import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../lib/backfill/canonical-json";
import {
  planArtifactExternalization,
  runArtifactExternalizationBatch,
  type CaseBackfillExternalizationDependencies,
} from "../lib/backfill/externalization";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  AttachArtifactExternalizationInput,
  CaseBackfillExternalizationCandidate,
} from "../lib/backfill/types";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");
const servicePath = path.join(process.cwd(), "lib/backfill/service.ts");
const externalizationPath = path.join(process.cwd(), "lib/backfill/externalization.ts");
const canonicalPath = path.join(process.cwd(), "lib/backfill/canonical-json.ts");
const scriptPath = path.join(process.cwd(), "scripts/externalize-artifacts-to-blob.ts");
const migrationRoot = path.join(process.cwd(), "supabase/migrations");
const migrationPath = path.join(migrationRoot, "20260919100000_artifact_blob_externalization_backfill.sql");
const gate1MigrationPath = path.join(migrationRoot, "20260903120000_constitutional_case_backfill_gate1.sql");

const SOURCE_KEY = "es-tribunal-constitucional";

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
  readonly puts: { pathname: string; body: Buffer; options: ArtifactBlobPutOptions }[] = [];
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  putPathnameSuffix: string | null = null;
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    if (this.putPathnameSuffix) {
      const suffix = this.putPathnameSuffix;
      this.putPathnameSuffix = null;
      return { pathname: `${pathname}${suffix}` };
    }
    this.puts.push({ pathname, body: Buffer.from(body), options });
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    const stored = this.getBytesOverride ? this.getBytesOverride(pathname) : this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    this.heads.push(pathname);
    const stored = this.objects.get(pathname);
    if (!stored) return { pathname: `${pathname}.missing`, size: 0 };
    return { pathname, size: stored.byteLength + this.headSizeAdjust };
  }
}

function fetchDocument() {
  return {
    sourceKey: SOURCE_KEY,
    url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    contentType: "decision",
    text: "official text",
  };
}

function normalizedDocument() {
  return {
    sourceKey: SOURCE_KEY,
    jurisdiction: "Spain",
    contentType: "decision",
    originalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    metadata: { resolutionType: "SENTENCIA" },
  };
}

function fetchCandidate(overrides: Partial<CaseBackfillExternalizationCandidate> = {}): CaseBackfillExternalizationCandidate {
  const document = canonicalJson(fetchDocument());
  return {
    artifactTable: "source_fetch_artifacts",
    artifactId: "66666666-6666-4666-8666-666666666667",
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "fetch",
    inlinePayload: fetchDocument(),
    storedHash: sha256Hex(document),
    storedSize: Buffer.byteLength(document),
    ...overrides,
  };
}

function normalizationCandidate(overrides: Partial<CaseBackfillExternalizationCandidate> = {}): CaseBackfillExternalizationCandidate {
  const document = canonicalJson(normalizedDocument());
  return {
    artifactTable: "source_normalization_artifacts",
    artifactId: "77777777-7777-4777-8777-777777777778",
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "normalization",
    inlinePayload: normalizedDocument(),
    storedHash: sha256Hex(document),
    storedSize: null,
    ...overrides,
  };
}

function fakeRepository(
  candidates: CaseBackfillExternalizationCandidate[],
  overrides: {
    attach?: (input: AttachArtifactExternalizationInput) => Promise<{ artifactId: string; idempotent: boolean }>;
  } = {},
) {
  const attachCalls: AttachArtifactExternalizationInput[] = [];
  const listCalls: { kind: string; sourceKey: string | null; limit: number; afterArtifactId: string | null }[] = [];
  const repository: Pick<
    CaseBackfillRepository,
    "listArtifactExternalizationCandidates" | "attachArtifactExternalization"
  > = {
    listArtifactExternalizationCandidates: async (input) => {
      listCalls.push({
        kind: input.kind,
        sourceKey: input.sourceKey ?? null,
        limit: input.limit,
        afterArtifactId: input.afterArtifactId ?? null,
      });
      const after = input.afterArtifactId ?? null;
      return candidates
        .filter((candidate) => (after ? candidate.artifactId > after : true))
        .slice(0, input.limit);
    },
    attachArtifactExternalization: async (input) => {
      attachCalls.push(input);
      if (overrides.attach) return overrides.attach(input);
      return { artifactId: input.artifactId, idempotent: false };
    },
  };
  return { repository, attachCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
): CaseBackfillExternalizationDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport };
}

test("plan recomputes the exact canonical document, hash, and size", () => {
  const candidate = fetchCandidate();
  const plan = planArtifactExternalization(candidate);
  assert.equal(plan.document, canonicalJson(fetchDocument()));
  assert.equal(plan.contentHash, candidate.storedHash);
  assert.equal(plan.contentSize, candidate.storedSize);
});

test("dry run plans storage refs without uploading or mutating", async () => {
  const { repository, attachCalls } = fakeRepository([fetchCandidate()]);
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.externalized, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "planned");
  assert.equal(
    result.outcomes[0].storageRef,
    buildArtifactStorageRef("fetch", SOURCE_KEY, fetchCandidate().storedHash),
  );
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("execute uploads, verifies size and SHA-256, then attaches while preserving inline content", async () => {
  const candidate = fetchCandidate();
  const { repository, attachCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 1);
  assert.equal(result.failed.length, 0);
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, "externalized");
  assert.equal(outcome.storageRef, buildArtifactStorageRef("fetch", SOURCE_KEY, candidate.storedHash));

  assert.equal(deps.transport.puts.length, 1);
  assert.equal(deps.transport.puts[0].options.access, "private");
  assert.equal(deps.transport.puts[0].options.addRandomSuffix, false);
  assert.equal(deps.transport.puts[0].options.allowOverwrite, true);
  assert.equal(sha256Hex(deps.transport.puts[0].body), candidate.storedHash);
  assert.deepEqual(deps.transport.gets, [outcome.storageRef]);
  assert.deepEqual(deps.transport.heads, [outcome.storageRef]);

  assert.deepEqual(attachCalls, [{
    artifactTable: "source_fetch_artifacts",
    artifactId: candidate.artifactId,
    storageRef: outcome.storageRef,
    contentHash: candidate.storedHash,
    contentSize: candidate.storedSize,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const attachInput = attachCalls[0] as unknown as Record<string, unknown>;
  assert.equal("boundedReplayPayload" in attachInput, false);
  assert.equal("clearInline" in attachInput, false);
  assert.equal("normalizedOutput" in attachInput, false);
});

test("normalization externalizes with a computed size when none was stored", async () => {
  const candidate = normalizationCandidate();
  const document = canonicalJson(normalizedDocument());
  const { repository, attachCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "normalization", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 1);
  assert.equal(attachCalls[0].artifactTable, "source_normalization_artifacts");
  assert.equal(attachCalls[0].contentSize, Buffer.byteLength(document));
  assert.match(attachCalls[0].storageRef, /^artifacts\/normalization\//);
});

test("a hash mismatch fails closed before upload and before any DB mutation", async () => {
  const candidate = fetchCandidate({ storedHash: sha256Hex("tampered") });
  const { repository, attachCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.deepEqual(result.failed, [{ artifactId: candidate.artifactId, errorCode: "artifact_externalization.hash_mismatch" }]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("a stored size mismatch fails closed before upload and before any DB mutation", async () => {
  const candidate = fetchCandidate();
  const candidateWithBadSize = { ...candidate, storedSize: (candidate.storedSize ?? 0) + 1 };
  const { repository, attachCalls } = fakeRepository([candidateWithBadSize]);
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.deepEqual(result.failed, [{ artifactId: candidate.artifactId, errorCode: "artifact_externalization.size_mismatch" }]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("an upload verification failure fails closed before the attach RPC", async () => {
  const { repository, attachCalls } = fakeRepository([fetchCandidate()]);
  const deps = dependencies(repository);
  deps.transport.putPathnameSuffix = ".mismatch";
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.equal(result.failed[0].errorCode, "artifact_blob.pathname_mismatch");
  assert.equal(attachCalls.length, 0);
});

test("a head size mismatch fails closed before get and before the attach RPC", async () => {
  const { repository, attachCalls } = fakeRepository([fetchCandidate()]);
  const deps = dependencies(repository);
  deps.transport.headSizeAdjust = 1;
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_externalization.head_verification_failed");
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("tampered stored bytes fail closed before the attach RPC", async () => {
  const { repository, attachCalls } = fakeRepository([fetchCandidate()]);
  const deps = dependencies(repository);
  deps.transport.getBytesOverride = () => Buffer.from("tampered");
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_externalization.get_verification_failed");
  assert.equal(attachCalls.length, 0);
});

test("an identical rerun is reported as idempotent", async () => {
  const { repository, attachCalls } = fakeRepository([fetchCandidate()], {
    attach: async (input) => ({ artifactId: input.artifactId, idempotent: true }),
  });
  const deps = dependencies(repository);
  const result = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.externalized, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(attachCalls.length, 1);
});

test("batches stay bounded and advance with a keyset cursor", async () => {
  const candidates = Array.from({ length: 3 }, (_, index) => fetchCandidate({
    artifactId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(candidates);
  const deps = dependencies(repository);
  const first = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArtifactId, candidates[1].artifactId);
  const second = await runArtifactExternalizationBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false, afterArtifactId: first.lastArtifactId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArtifactId, candidates[2].artifactId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[1].afterArtifactId, candidates[1].artifactId);
});

test("repository selects inline ref-less candidates and routes to the externalize RPC", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /source_backfill_artifact_externalize_v1/);
  assert.match(source, /listArtifactExternalizationCandidates/);
  assert.match(source, /\.is\("bounded_replay_storage_ref", null\)/);
  assert.match(source, /\.not\("bounded_replay_payload", "is", null\)/);
  assert.match(source, /\.is\("normalized_output_storage_ref", null\)/);
  assert.match(source, /\.not\("normalized_output", "is", null\)/);
  assert.match(source, /source_inventory_snapshots!inner\(source_key\)/);
  assert.match(source, /source_backfill_items!source_fetch_artifacts_item_id_fkey!inner\(snapshot_id, source_inventory_snapshots!inner\(source_key\)\)/);
  assert.match(source, /source_backfill_items!source_normalization_artifacts_item_id_fkey!inner\(snapshot_id, source_inventory_snapshots!inner\(source_key\)\)/);
  assert.doesNotMatch(source, /source_backfill_items!inner\(/);
  assert.match(source, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(source, /\.gt\("id", input\.afterArtifactId\)/);
  assert.match(source, /\.eq\("source_backfill_items\.source_inventory_snapshots\.source_key", input\.sourceKey\)/);
});

test("service and externalization share one canonicalization implementation", () => {
  const service = fs.readFileSync(servicePath, "utf8");
  const canonical = fs.readFileSync(canonicalPath, "utf8");
  const externalization = fs.readFileSync(externalizationPath, "utf8");
  assert.match(service, /import \{ canonicalJson \} from "@\/lib\/backfill\/canonical-json"/);
  assert.doesNotMatch(service, /function canonicalJson\(/);
  assert.match(canonical, /export function canonicalJson/);
  assert.match(externalization, /canonicalJson\(candidate\.inlinePayload\)/);
  assert.match(externalization, /sha256Hex\(document\)/);
});

test("externalization lib verifies via head and get before calling the repository", () => {
  const source = fs.readFileSync(externalizationPath, "utf8");
  const putIndex = source.indexOf("await dependencies.store.put(");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const attachIndex = source.indexOf("await dependencies.repository.attachArtifactExternalization(");
  assert.ok(putIndex >= 0 && headIndex > putIndex && getIndex > headIndex && attachIndex > getIndex);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await externalizeArtifactPlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
});

test("script defaults to dry run and requires an explicit execute flag", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const KINDS: readonly CaseBackfillArtifactExternalizationKind\[\] = \["fetch", "normalization"\]/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /optionalSourceKey\(\)/);
  assert.match(source, /createArtifactBlobStore\(\)/);
  assert.match(source, /runArtifactExternalizationBatch\(/);
  assert.doesNotMatch(source, /store\.put\(/);
});

test("migration is additive, narrows the guard, and leaves no generic bypass", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const gate1 = fs.readFileSync(gate1MigrationPath, "utf8");

  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /source_backfill_fetch_artifact_record_v1/);
  assert.doesNotMatch(sql, /source_backfill_normalization_artifact_record_v1/);

  assert.match(sql, /create table if not exists source_artifact_externalization_permits/);
  assert.match(sql, /create or replace function case_backfill_artifact_externalization_guard_v1/);
  assert.match(sql, /create or replace function source_backfill_artifact_externalize_v1/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, extensions, pg_temp/);
  assert.match(sql, /CASE_BACKFILL_IMMUTABLE/);

  assert.match(sql, /drop trigger if exists source_fetch_artifacts_immutable_trigger on source_fetch_artifacts/);
  assert.match(sql, /drop trigger if exists source_normalization_artifacts_immutable_trigger on source_normalization_artifacts/);
  assert.match(sql, /execute function case_backfill_artifact_externalization_guard_v1\(\)/);

  assert.match(sql, /from source_artifact_externalization_permits p/);
  assert.match(sql, /if not found then/);
  assert.match(sql, /delete from source_artifact_externalization_permits/);
  assert.match(sql, /v_expected_ref/);
  assert.match(sql, /join source_inventory_snapshots s on s\.id = i\.snapshot_id/);

  assert.match(sql, /set bounded_replay_storage_ref = v_ref,/);
  assert.match(sql, /set normalized_output_storage_ref = v_ref,/);
  assert.match(sql, /normalized_output_size = p_content_size,/);
  assert.doesNotMatch(sql, /bounded_replay_payload\s*=/);
  assert.doesNotMatch(sql, /normalized_output\s*=/);
  assert.doesNotMatch(sql, /set\s+bounded_replay_payload/i);
  assert.doesNotMatch(sql, /\binline\s*=\s*null/i);

  assert.match(sql, /insert into source_artifact_externalization_ledger/);
  assert.match(sql, /on conflict \(artifact_table, artifact_id, externalization_contract_version\) do nothing/);
  assert.match(sql, /revoke all on table source_artifact_externalization_permits from service_role/);
  assert.match(sql, /grant execute on function source_backfill_artifact_externalize_v1/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);

  assert.match(gate1, /create or replace function case_backfill_prevent_mutation_v1/);
  assert.match(gate1, /source_fetch_artifacts_immutable_trigger/);
  assert.match(gate1, /source_normalization_artifacts_immutable_trigger/);
});

test("externalization RPC accepts only the exact supported contract version", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function source_backfill_artifact_externalize_v1(");
  assert.ok(rpcStart >= 0, "externalization RPC must be defined");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  assert.ok(rpcEnd > rpcStart, "externalization RPC body must terminate");
  const rpc = sql.slice(rpcStart, rpcEnd);

  // The literal comes from the shared TS contract constant; only it is accepted.
  assert.match(
    rpc,
    new RegExp(`p_externalization_contract_version\\s+is distinct from\\s+'${ARTIFACT_BLOB_CONTRACT_VERSION}'`),
  );
  assert.match(rpc, /CASE_BACKFILL_EXTERNALIZATION_CONTRACT_VERSION_INVALID/);
  // The old arbitrary non-empty gate must be gone, so no other value can pass.
  assert.doesNotMatch(rpc, /length\(p_externalization_contract_version\)/);
  assert.doesNotMatch(rpc, /nullif\(trim\(coalesce\(p_externalization_contract_version/);

  // The version gate must run before the permit write and before either artifact update.
  const versionGateIndex = rpc.search(/p_externalization_contract_version\s+is distinct from/);
  assert.ok(versionGateIndex >= 0, "version gate must exist");
  const permitIndex = rpc.indexOf("insert into source_artifact_externalization_permits");
  assert.ok(permitIndex > versionGateIndex, "version gate must precede the permit insert");
  assert.ok(rpc.indexOf("update source_fetch_artifacts") > versionGateIndex, "version gate must precede the fetch update");
  assert.ok(rpc.indexOf("update source_normalization_artifacts") > versionGateIndex, "version gate must precede the normalization update");
});
