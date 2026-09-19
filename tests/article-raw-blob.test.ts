import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  ARTICLE_RAW_BLOB_MAX_BYTES,
  articleRawBlobStorageRef,
  decodeArticleRawText,
  encodeArticleRawText,
} from "../lib/article-raw/codec";
import {
  ARTICLE_RAW_BLOB_READ_ENABLED,
  ARTICLE_RAW_BLOB_WRITE_ENABLED,
  articleRawBlobFlagErrors,
  articleRawBlobReadEnabled,
  articleRawBlobReadReady,
  articleRawBlobWriteEnabled,
  articleRawBlobWriteReady,
} from "../lib/article-raw/flags";
import {
  readArticleRawText,
  type ArticleRawBlobReadRow,
} from "../lib/article-raw/reader";
import {
  ArtifactBlobStore,
  isArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";
import { createPostgresArticlePublicationRepository } from "../lib/article-publication/repository";
import type { ArticlePublicationTransitionInput } from "../lib/article-publication/types";
import { hydrateArticleRawText } from "../lib/article-raw/detail-read";
import { externalizeArticleRawText } from "../lib/article-raw/publication";
import type { ArticleDetail } from "../lib/db/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const SOURCE_KEY = "us-scotus";
const EXTERNALIZED_AT = "2026-09-19T00:00:00.000Z";

const queriesPath = path.join(process.cwd(), "lib/db/queries.ts");
const sourceTextRoutePath = path.join(process.cwd(), "app/api/articles/[slug]/source-text/route.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919130000_article_raw_blob_contract.sql",
);

const READ_ON = { [ARTICLE_RAW_BLOB_READ_ENABLED]: "true" };
const BOTH_ON = {
  [ARTICLE_RAW_BLOB_READ_ENABLED]: "true",
  [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true",
};

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

class MemoryTransport implements ArtifactBlobTransport {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  putError: unknown = null;
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer) {
    this.puts.push(pathname);
    if (this.putError) throw this.putError;
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string): Promise<ArtifactBlobGetResult | null> {
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

const articleId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const publicationId = "33333333-3333-4333-8333-333333333333";

class FakeSupabaseClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly fromTables: string[] = [];
  articleSource: { source_key?: string | null; raw_text?: string | null } | null = {
    source_key: SOURCE_KEY,
    raw_text: "raw text",
  };
  articleError: unknown = null;
  rpcError: unknown = null;
  transitionRow: Record<string, unknown> = {
    article_id: articleId,
    version_id: versionId,
    version_revision: 5,
    publication_id: publicationId,
    publication_revision: 8,
    publication_state: "published",
    version_created: true,
    publication_applied: true,
    idempotent: false,
  };

  from(table: string) {
    this.fromTables.push(table);
    const self = this;
    return {
      select() {
        return {
          eq() {
            return { maybeSingle: async () => ({ data: self.articleSource, error: self.articleError }) };
          },
        };
      },
    };
  }

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    return { data: [this.transitionRow], error: null };
  }
}

function publicationRepository(
  client: FakeSupabaseClient,
  environment: Record<string, string | undefined>,
  transport: MemoryTransport,
) {
  return createPostgresArticlePublicationRepository({
    client: () => client as unknown as SupabaseClient,
    blobStore: new ArtifactBlobStore(transport),
    environment,
  });
}

const CAPTURE_INPUT: ArticlePublicationTransitionInput = {
  articleId,
  expectedVersionRevision: 4,
  expectedPublicationRevision: 7,
  idempotencyKey: "capture-key",
  targetState: "published",
  captureLegacy: true,
  actorType: "compatibility",
  reason: "capture legacy row",
};

const LEGACY_CAPTURE_ARGS = {
  p_article_id: articleId,
  p_expected_version_revision: 4,
  p_expected_publication_revision: 7,
  p_idempotency_key: "capture-key",
  p_target_state: "published",
  p_capture_legacy: true,
  p_actor_type: "compatibility",
  p_actor_id: null,
  p_reason: "capture legacy row",
  p_request_id: null,
  p_correlation_id: null,
  p_provenance_actor_type: "human",
  p_provenance_actor_id: null,
  p_model_ref: null,
  p_prompt_ref: null,
  p_safe_metadata: {},
  p_expected_legacy_updated_at: null,
  p_version_id: null,
};


function seedBlob(transport: MemoryTransport, rawText: string) {
  const encoded = encodeArticleRawText(rawText);
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  transport.objects.set(storageRef, encoded.bytes);
  return { storageRef, sha256: encoded.sha256, size: encoded.size };
}

function blobRow(overrides: Partial<ArticleRawBlobReadRow> = {}): ArticleRawBlobReadRow {
  return {
    sourceKey: SOURCE_KEY,
    rawText: null,
    rawTextStorageRef: null,
    rawTextBlobHash: null,
    rawTextBlobSize: null,
    rawTextExternalizedAt: null,
    rawTextBlobContractVersion: null,
    ...overrides,
  };
}

function externalizedRow(storageRef: string, sha256: string, size: number, overrides: Partial<ArticleRawBlobReadRow> = {}) {
  return blobRow({
    rawTextStorageRef: storageRef,
    rawTextBlobHash: sha256,
    rawTextBlobSize: size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    ...overrides,
  });
}

// --- flags -----------------------------------------------------------------

test("article raw blob flags default OFF with no flag errors", () => {
  assert.equal(articleRawBlobReadEnabled({}), false);
  assert.equal(articleRawBlobWriteEnabled({}), false);
  assert.equal(articleRawBlobReadReady({}), false);
  assert.equal(articleRawBlobWriteReady({}), false);
  assert.deepEqual(articleRawBlobFlagErrors({}), []);
});

test("article raw blob read flag is explicit-true only", () => {
  assert.equal(articleRawBlobReadEnabled({ [ARTICLE_RAW_BLOB_READ_ENABLED]: "true" }), true);
  assert.equal(articleRawBlobReadEnabled({ [ARTICLE_RAW_BLOB_READ_ENABLED]: " TRUE " }), true);
  assert.equal(articleRawBlobReadEnabled({ [ARTICLE_RAW_BLOB_READ_ENABLED]: "1" }), false);
  assert.equal(articleRawBlobReadEnabled({ [ARTICLE_RAW_BLOB_READ_ENABLED]: "yes" }), false);
  assert.equal(articleRawBlobReadEnabled({ [ARTICLE_RAW_BLOB_READ_ENABLED]: "false" }), false);
});

test("article raw blob WRITE requires READ", () => {
  const writeOnly = { [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true" };
  assert.equal(articleRawBlobWriteEnabled(writeOnly), true);
  assert.equal(articleRawBlobWriteReady(writeOnly), false);
  assert.equal(articleRawBlobReadReady(writeOnly), false);
  assert.deepEqual(articleRawBlobFlagErrors(writeOnly), [
    `${ARTICLE_RAW_BLOB_WRITE_ENABLED} requires ${ARTICLE_RAW_BLOB_READ_ENABLED}`,
  ]);

  assert.equal(articleRawBlobReadReady(BOTH_ON), true);
  assert.equal(articleRawBlobWriteReady(BOTH_ON), true);
  assert.deepEqual(articleRawBlobFlagErrors(BOTH_ON), []);
});

// --- codec -----------------------------------------------------------------

test("codec encodes raw_text as a deterministic JSON string with SHA-256 and size", () => {
  const value = "헌법 §42 raw\n text";
  const encoded = encodeArticleRawText(value);
  assert.equal(encoded.document, JSON.stringify(value));
  assert.equal(encoded.size, Buffer.byteLength(encoded.document, "utf8"));
  assert.equal(encoded.sha256, sha256Hex(encoded.bytes));

  const repeated = encodeArticleRawText(value);
  assert.equal(repeated.document, encoded.document);
  assert.equal(repeated.sha256, encoded.sha256);
  assert.equal(repeated.size, encoded.size);
});

test("codec round-trips raw_text through UTF-8 bytes", () => {
  const value = "헌법 §42 — emoji 😀 \u2028 newline\n end";
  assert.equal(decodeArticleRawText(encodeArticleRawText(value).bytes), value);
  assert.equal(decodeArticleRawText(encodeArticleRawText("").bytes), "");
});

test("codec enforces the 4 MiB bound in both directions", () => {
  const atLimit = "a".repeat(ARTICLE_RAW_BLOB_MAX_BYTES - 2);
  assert.equal(encodeArticleRawText(atLimit).size, ARTICLE_RAW_BLOB_MAX_BYTES);
  assert.throws(() => encodeArticleRawText("a".repeat(ARTICLE_RAW_BLOB_MAX_BYTES)), /article_raw_blob\.payload_too_large/);
  assert.throws(
    () => decodeArticleRawText(Buffer.alloc(ARTICLE_RAW_BLOB_MAX_BYTES + 1)),
    /article_raw_blob\.payload_too_large/,
  );
});

test("codec rejects non-JSON and non-string documents", () => {
  assert.throws(() => decodeArticleRawText(Buffer.from("not-json{")), /article_raw_blob\.invalid_document/);
  assert.throws(() => decodeArticleRawText(Buffer.from(JSON.stringify({ a: 1 }))), /article_raw_blob\.invalid_document/);
  assert.throws(() => decodeArticleRawText(Buffer.from("42")), /article_raw_blob\.invalid_document/);
});

test("codec storage ref matches the article_raw object contract", () => {
  const encoded = encodeArticleRawText("text");
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  assert.equal(storageRef, `artifacts/article_raw/${SOURCE_KEY}/${encoded.sha256}.json`);
  assert.equal(isArtifactStorageRef(storageRef), true);
});

// --- reader ----------------------------------------------------------------

test("reader returns inline raw_text first and never touches Blob", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob copy");
  const row = externalizedRow(seed.storageRef, seed.sha256, seed.size, { rawText: "inline copy" });

  const resolution = await readArticleRawText(row, { store: new ArtifactBlobStore(transport), environment: BOTH_ON });
  assert.equal(resolution.rawText, "inline copy");
  assert.equal(resolution.source, "inline");
  assert.equal(transport.heads.length, 0);
  assert.equal(transport.gets.length, 0);
});

test("reader falls back to Blob and validates head/get when inline is absent", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const row = externalizedRow(seed.storageRef, seed.sha256, seed.size);

  const resolution = await readArticleRawText(row, { store: new ArtifactBlobStore(transport), environment: READ_ON });
  assert.equal(resolution.rawText, "blob only text");
  assert.equal(resolution.source, "blob");
  assert.equal(resolution.storageRef, seed.storageRef);
  assert.equal(resolution.sha256, seed.sha256);
  assert.equal(resolution.size, seed.size);
  assert.deepEqual(transport.heads, [seed.storageRef]);
  assert.deepEqual(transport.gets, [seed.storageRef]);
});

test("reader fails closed when the read flag is off", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const row = externalizedRow(seed.storageRef, seed.sha256, seed.size);

  await assert.rejects(
    readArticleRawText(row, { store: new ArtifactBlobStore(transport), environment: {} }),
    /article_raw_blob\.read_disabled/,
  );
  assert.equal(transport.heads.length, 0);
  assert.equal(transport.gets.length, 0);
});

test("reader treats write-without-read as read-disabled", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const row = externalizedRow(seed.storageRef, seed.sha256, seed.size);

  await assert.rejects(
    readArticleRawText(row, {
      store: new ArtifactBlobStore(transport),
      environment: { [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true" },
    }),
    /article_raw_blob\.read_disabled/,
  );
  assert.equal(transport.gets.length, 0);
});

test("reader reports unavailable when there is no inline text and no ref", async () => {
  const transport = new MemoryTransport();
  await assert.rejects(
    readArticleRawText(blobRow(), { store: new ArtifactBlobStore(transport), environment: READ_ON }),
    /article_raw_blob\.unavailable/,
  );
});

test("reader rejects dangling externalization metadata without a ref", async () => {
  const transport = new MemoryTransport();
  const row = blobRow({ rawTextBlobHash: "a".repeat(64) });
  await assert.rejects(
    readArticleRawText(row, { store: new ArtifactBlobStore(transport), environment: READ_ON }),
    /article_raw_blob\.metadata_inconsistent/,
  );
});

test("reader rejects an inconsistent ref/hash/size metadata set", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  await assert.rejects(
    readArticleRawText(externalizedRow(seed.storageRef, seed.sha256, seed.size, { rawTextBlobHash: null }), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.metadata_inconsistent/,
  );
  await assert.rejects(
    readArticleRawText(externalizedRow(seed.storageRef, seed.sha256, seed.size, { rawTextBlobSize: null }), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.metadata_inconsistent/,
  );
  assert.equal(transport.gets.length, 0);
});

test("reader rejects a ref whose trailing hash does not equal raw_text_blob_hash", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const otherRef = articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64));
  await assert.rejects(
    readArticleRawText(externalizedRow(otherRef, seed.sha256, seed.size), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.metadata_inconsistent/,
  );
  assert.equal(transport.gets.length, 0);
});

test("reader rejects a malformed storage ref", async () => {
  const transport = new MemoryTransport();
  const row = externalizedRow("https://example.com/raw.json", "a".repeat(64), 10);
  await assert.rejects(
    readArticleRawText(row, { store: new ArtifactBlobStore(transport), environment: READ_ON }),
    /article_raw_blob\.invalid_ref/,
  );
});

test("reader rejects an unsupported contract version", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  await assert.rejects(
    readArticleRawText(externalizedRow(seed.storageRef, seed.sha256, seed.size, {
      rawTextBlobContractVersion: "worldcons-article-raw-blob-v2",
    }), { store: new ArtifactBlobStore(transport), environment: READ_ON }),
    /article_raw_blob\.contract_unsupported/,
  );
});

test("reader rejects a head size mismatch before reading bytes", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  transport.headSizeAdjust = 1;
  await assert.rejects(
    readArticleRawText(externalizedRow(seed.storageRef, seed.sha256, seed.size), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.integrity_mismatch/,
  );
  assert.equal(transport.gets.length, 0);
});

test("reader rejects a SHA-256 mismatch after reading bytes", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  transport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  await assert.rejects(
    readArticleRawText(externalizedRow(seed.storageRef, seed.sha256, seed.size), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.integrity_mismatch/,
  );
});

test("reader fails closed when the Blob object is missing", async () => {
  const transport = new MemoryTransport();
  const ref = articleRawBlobStorageRef(SOURCE_KEY, "c".repeat(64));
  await assert.rejects(
    readArticleRawText(externalizedRow(ref, "c".repeat(64), 10), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.read_failed/,
  );
});

test("reader rejects a Blob document that is not a JSON string", async () => {
  const transport = new MemoryTransport();
  const bytes = Buffer.from("not-json{");
  const hash = sha256Hex(bytes);
  const ref = articleRawBlobStorageRef(SOURCE_KEY, hash);
  transport.objects.set(ref, bytes);
  await assert.rejects(
    readArticleRawText(externalizedRow(ref, hash, bytes.byteLength), {
      store: new ArtifactBlobStore(transport),
      environment: READ_ON,
    }),
    /article_raw_blob\.invalid_document/,
  );
});

// --- static path proofs ----------------------------------------------------

test("raw blob metadata is projected only on detail reads", () => {
  const source = fs.readFileSync(queriesPath, "utf8");
  assert.match(
    source,
    /const ARTICLE_RAW_BLOB_METADATA_SELECT = "raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version";/,
  );
  assert.match(
    source,
    /const ARTICLE_DETAIL_SELECT = `\$\{ARTICLE_PAGE_SELECT\},raw_text,cleaned_text,\$\{ARTICLE_RAW_BLOB_METADATA_SELECT\}`;/,
  );
  assert.match(
    source,
    /const ARTICLE_P3_DETAIL_SELECT = `\$\{ARTICLE_P3_PAGE_SELECT\},raw_text,cleaned_text,\$\{ARTICLE_RAW_BLOB_METADATA_SELECT\}`;/,
  );
});

test("list and source-text clean reads never request raw blob metadata", () => {
  const source = fs.readFileSync(queriesPath, "utf8");
  for (const name of ["ARTICLE_LIST_SELECT", "ARTICLE_P3_LIST_SELECT"]) {
    const body = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join`));
    assert.ok(body, `${name} array not found`);
    assert.equal((body as RegExpMatchArray)[1].includes("raw_text_blob"), false, `${name} must not request raw blob metadata`);
  }
  const sourceTextSelect = source.match(/"slug,status,source_key,source_metadata,original_url,cleaned_text,content_hash"/);
  assert.ok(sourceTextSelect);
  assert.equal((sourceTextSelect as RegExpMatchArray)[0].includes("raw_text_blob"), false);
});

test("queries wire the raw blob dual read only into the article detail path", () => {
  const queriesSource = fs.readFileSync(queriesPath, "utf8");
  assert.ok(queriesSource.includes("@/lib/article-raw/detail-read"));

  const detail = functionBody(queriesSource, "getArticleBySlug");
  assert.ok(detail.includes("hydrateArticleRawText"));
  for (const name of ["getArticlePreviewBySlug", "getArticleSourceTextBySlug"]) {
    const body = functionBody(queriesSource, name);
    assert.equal(body.includes("hydrateArticleRawText"), false, `${name} must not hydrate raw text`);
    assert.equal(body.includes("createArtifactBlobStore"), false, `${name} must never touch Blob`);
  }

  const routeSource = fs.readFileSync(sourceTextRoutePath, "utf8");
  assert.equal(routeSource.includes("article-raw"), false);
  assert.equal(routeSource.toLowerCase().includes("rawtextblob"), false);
});

test("migration uses the dedicated article raw blob contract columns and literal", () => {
  const source = fs.readFileSync(migrationPath, "utf8");
  for (const column of [
    "raw_text_storage_ref",
    "raw_text_blob_hash",
    "raw_text_blob_size",
    "raw_text_externalized_at",
    "raw_text_blob_contract_version",
  ]) {
    assert.match(source, new RegExp(`add column if not exists ${column} `), `missing dedicated column ${column}`);
  }
  assert.equal(source.includes("add column if not exists raw_text_size"), false);
  assert.equal(source.includes("add column if not exists externalized_at"), false);
  assert.equal(source.includes("add column if not exists externalization_contract_version"), false);
  assert.match(source, /worldcons-article-raw-blob-v1/);
  assert.match(source, /\^artifacts\/article_raw\//);
});

// --- publication integration -----------------------------------------------

test("flag-off publication capture calls the legacy RPC with the exact legacy args", async () => {
  const client = new FakeSupabaseClient();
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, {}, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.equal(result.ok, true);
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, "article_publication_transition_p3");
  assert.deepEqual(client.rpcCalls[0].args, LEGACY_CAPTURE_ARGS);
  assert.equal(client.fromTables.length, 0);
  assert.deepEqual(transport.puts, []);
  assert.deepEqual(transport.heads, []);
  assert.deepEqual(transport.gets, []);
});

test("flag-on publication capture uploads first, then calls the blob RPC with exact args", async () => {
  const client = new FakeSupabaseClient();
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, BOTH_ON, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.equal(result.ok, true);
  assert.deepEqual(client.fromTables, ["articles"]);
  const encoded = encodeArticleRawText("raw text");
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  assert.deepEqual(transport.puts, [storageRef]);
  assert.deepEqual(transport.heads, [storageRef]);
  assert.deepEqual(transport.gets, [storageRef]);

  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, "article_publication_transition_p3_blob");
  const { p_version_id, ...legacyWithoutVersion } = LEGACY_CAPTURE_ARGS;
  void p_version_id;
  assert.deepEqual(client.rpcCalls[0].args, {
    ...legacyWithoutVersion,
    p_raw_text_storage_ref: storageRef,
    p_raw_text_blob_hash: encoded.sha256,
    p_raw_text_blob_size: encoded.size,
    p_raw_text_blob_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });
});

test("flag-on capture falls back to the legacy RPC only when there is no inline raw_text", async () => {
  const client = new FakeSupabaseClient();
  client.articleSource = { source_key: SOURCE_KEY, raw_text: null };
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, BOTH_ON, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.equal(result.ok, true);
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, "article_publication_transition_p3");
  assert.deepEqual(transport.puts, []);
});

test("flag-on capture fails closed when the Blob put fails", async () => {
  const client = new FakeSupabaseClient();
  const transport = new MemoryTransport();
  transport.putError = new Error("blob unavailable");
  const repository = publicationRepository(client, BOTH_ON, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.deepEqual(result, { ok: false, error: { code: "unavailable", retryable: true } });
  assert.equal(client.rpcCalls.length, 0);
});

test("flag-on capture fails closed on head/get verification mismatch and never records a version", async () => {
  const headClient = new FakeSupabaseClient();
  const headTransport = new MemoryTransport();
  headTransport.headSizeAdjust = 1;
  const headResult = await publicationRepository(headClient, BOTH_ON, headTransport).transition(CAPTURE_INPUT);
  assert.deepEqual(headResult, { ok: false, error: { code: "unavailable", retryable: true } });
  assert.equal(headClient.rpcCalls.length, 0);

  const hashClient = new FakeSupabaseClient();
  const hashTransport = new MemoryTransport();
  hashTransport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  const hashResult = await publicationRepository(hashClient, BOTH_ON, hashTransport).transition(CAPTURE_INPUT);
  assert.deepEqual(hashResult, { ok: false, error: { code: "unavailable", retryable: true } });
  assert.equal(hashClient.rpcCalls.length, 0);
});

test("flag-on capture fails closed when the source article read errors", async () => {
  const client = new FakeSupabaseClient();
  client.articleError = { message: "boom" };
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, BOTH_ON, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.deepEqual(result, { ok: false, error: { code: "unavailable", retryable: true } });
  assert.equal(client.rpcCalls.length, 0);
  assert.deepEqual(transport.puts, []);
});

test("write-without-read never selects the Blob path and keeps the legacy RPC", async () => {
  const client = new FakeSupabaseClient();
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, { [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true" }, transport);

  const result = await repository.transition(CAPTURE_INPUT);

  assert.equal(result.ok, true);
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, "article_publication_transition_p3");
  assert.deepEqual(client.rpcCalls[0].args, LEGACY_CAPTURE_ARGS);
  assert.deepEqual(transport.puts, []);
});

test("non-capture transitions keep the legacy RPC even with flags on", async () => {
  const client = new FakeSupabaseClient();
  const transport = new MemoryTransport();
  const repository = publicationRepository(client, BOTH_ON, transport);

  const result = await repository.transition({
    ...CAPTURE_INPUT,
    captureLegacy: false,
    versionId,
  });

  assert.equal(result.ok, true);
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, "article_publication_transition_p3");
  assert.equal(client.rpcCalls[0].args.p_version_id, versionId);
  assert.deepEqual(transport.puts, []);
});

test("externalizer verifies the content-addressed ref/hash/size before returning", async () => {
  const transport = new MemoryTransport();
  const externalization = await externalizeArticleRawText(new ArtifactBlobStore(transport), SOURCE_KEY, "raw text");
  const encoded = encodeArticleRawText("raw text");
  assert.equal(externalization.storageRef, articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256));
  assert.equal(externalization.sha256, encoded.sha256);
  assert.equal(externalization.size, encoded.size);
  assert.equal(externalization.contractVersion, ARTICLE_RAW_BLOB_CONTRACT_VERSION);
});

test("M6A migration adds an additive blob capture RPC and leaves the immutable trigger untouched", () => {
  const m6a = fs.readFileSync(migrationPath, "utf8");
  const legacyRpc = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260712200000_article_publication_p3.sql"),
    "utf8",
  );

  assert.match(m6a, /create or replace function article_publication_transition_p3_blob\(/);
  assert.match(m6a, /security definer\r?\nset search_path = public, pg_temp/);
  assert.match(m6a, /ARTICLE_RAW_BLOB_REF_INVALID/);
  assert.match(m6a, /ARTICLE_RAW_BLOB_INLINE_REQUIRED/);
  assert.match(m6a, /article\.version\.capture_noop/);
  assert.match(m6a, /article_cache_outbox_p3_publication_revision_key do nothing/);
  assert.match(
    m6a,
    /grant execute on function article_publication_transition_p3_blob\(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz\) to service_role/,
  );
  assert.equal(m6a.includes("drop trigger if exists article_content_versions_p3_immutable_trigger"), false);
  assert.equal(m6a.includes("create or replace function article_publication_immutable_p3"), false);

  // The legacy capture RPC is neither replaced nor renamed by M6A, and the raw
  // blob RPC, columns, and ledger exist only in the M6A migration.
  assert.match(legacyRpc, /create or replace function article_publication_transition_p3\(/);
  assert.equal(legacyRpc.includes("article_publication_transition_p3_blob"), false);
  assert.equal(legacyRpc.includes("raw_text_storage_ref"), false);
  assert.equal(legacyRpc.includes("raw_text_blob_contract_version"), false);
  assert.equal(legacyRpc.includes("article_raw_externalization_ledger"), false);
  assert.match(m6a, /article_raw_externalization_ledger/);
});

// --- detail hydration ------------------------------------------------------

function detailArticle(overrides: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    slug: "case-1",
    sourceKey: SOURCE_KEY,
    jurisdiction: "United States",
    institutionName: "SCOTUS",
    contentType: "decision",
    originalUrl: "https://example.com/case-1",
    canonicalUrl: "https://example.com/case-1",
    originalLanguage: "en",
    status: "summarized",
    tags: [],
    oneLineSummary: "summary",
    ...overrides,
  };
}

test("detail hydration returns inline raw_text first and never touches Blob", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob copy");
  const article = detailArticle({
    rawText: "inline copy",
    rawTextBlob: {
      storageRef: seed.storageRef,
      blobHash: seed.sha256,
      blobSize: seed.size,
      externalizedAt: EXTERNALIZED_AT,
      contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    },
  });

  const hydrated = await hydrateArticleRawText(article, {
    store: new ArtifactBlobStore(transport),
    environment: BOTH_ON,
  });

  assert.equal(hydrated.rawText, "inline copy");
  assert.deepEqual(transport.heads, []);
  assert.deepEqual(transport.gets, []);
});

test("detail hydration reads the Blob only when inline raw_text is absent and metadata is present", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const article = detailArticle({
    rawText: null,
    rawTextBlob: {
      storageRef: seed.storageRef,
      blobHash: seed.sha256,
      blobSize: seed.size,
      externalizedAt: EXTERNALIZED_AT,
      contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    },
  });

  const hydrated = await hydrateArticleRawText(article, {
    store: new ArtifactBlobStore(transport),
    environment: READ_ON,
  });

  assert.equal(hydrated.rawText, "blob only text");
  assert.deepEqual(transport.heads, [seed.storageRef]);
  assert.deepEqual(transport.gets, [seed.storageRef]);
});

test("detail hydration does nothing without externalization metadata", async () => {
  const transport = new MemoryTransport();
  const article = detailArticle({ rawText: null, rawTextBlob: null });

  const hydrated = await hydrateArticleRawText(article, {
    store: new ArtifactBlobStore(transport),
    environment: BOTH_ON,
  });

  assert.equal(hydrated.rawText, null);
  assert.deepEqual(transport.heads, []);
  assert.deepEqual(transport.gets, []);
});

test("detail hydration is read-disabled without touching Blob", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "blob only text");
  const article = detailArticle({
    rawText: null,
    rawTextBlob: {
      storageRef: seed.storageRef,
      blobHash: seed.sha256,
      blobSize: seed.size,
      externalizedAt: EXTERNALIZED_AT,
      contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    },
  });

  const hydrated = await hydrateArticleRawText(article, {
    store: new ArtifactBlobStore(transport),
    environment: {},
  });

  assert.equal(hydrated.rawText, null);
  assert.deepEqual(transport.heads, []);
  assert.deepEqual(transport.gets, []);
});

test("detail hydration fails closed on size, hash, and non-string decode failures", async () => {
  const metadata = (storageRef: string, sha256: string, size: number) => ({
    storageRef,
    blobHash: sha256,
    blobSize: size,
    externalizedAt: EXTERNALIZED_AT,
    contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });

  const sizeTransport = new MemoryTransport();
  const sizeSeed = seedBlob(sizeTransport, "blob only text");
  sizeTransport.headSizeAdjust = 1;
  const sizeArticle = detailArticle({ rawText: null, rawTextBlob: metadata(sizeSeed.storageRef, sizeSeed.sha256, sizeSeed.size) });
  const sizeHydrated = await hydrateArticleRawText(sizeArticle, {
    store: new ArtifactBlobStore(sizeTransport),
    environment: READ_ON,
  });
  assert.equal(sizeHydrated.rawText, null);

  const hashTransport = new MemoryTransport();
  const hashSeed = seedBlob(hashTransport, "blob only text");
  hashTransport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  const hashArticle = detailArticle({ rawText: null, rawTextBlob: metadata(hashSeed.storageRef, hashSeed.sha256, hashSeed.size) });
  const hashHydrated = await hydrateArticleRawText(hashArticle, {
    store: new ArtifactBlobStore(hashTransport),
    environment: READ_ON,
  });
  assert.equal(hashHydrated.rawText, null);

  const decodeTransport = new MemoryTransport();
  const bytes = Buffer.from("not-json{");
  const hash = sha256Hex(bytes);
  const ref = articleRawBlobStorageRef(SOURCE_KEY, hash);
  decodeTransport.objects.set(ref, bytes);
  const decodeArticle = detailArticle({ rawText: null, rawTextBlob: metadata(ref, hash, bytes.byteLength) });
  const decodeHydrated = await hydrateArticleRawText(decodeArticle, {
    store: new ArtifactBlobStore(decodeTransport),
    environment: READ_ON,
  });
  assert.equal(decodeHydrated.rawText, null);
});

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}
