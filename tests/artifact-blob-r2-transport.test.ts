import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_BLOB_PROVIDER_ENV,
  ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  createArtifactBlobFallbackTransport,
  createArtifactBlobTransport,
  createR2BindingArtifactBlobTransport,
  createR2S3ArtifactBlobTransport,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobR2Bucket,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const SOURCE_KEY = "fr-conseil-constitutionnel";
const PAYLOAD = Buffer.from(JSON.stringify({ sourceKey: SOURCE_KEY, value: "hello" }));
const REF = buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex(PAYLOAD));

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
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  readonly puts: string[] = [];
  getError: Error | null = null;
  headError: Error | null = null;

  async put(pathname: string, body: Buffer, _options: ArtifactBlobPutOptions) {
    this.puts.push(pathname);
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    if (this.getError) throw this.getError;
    const body = this.objects.get(pathname);
    return body ? { statusCode: 200, stream: streamOf(body), size: body.byteLength } : null;
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    this.heads.push(pathname);
    if (this.headError) throw this.headError;
    const body = this.objects.get(pathname);
    return body ? { pathname, size: body.byteLength } : { pathname: `${pathname}.missing`, size: 0 };
  }
}

function r2Options(
  signedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return {
    endpoint: "https://example-account.r2.cloudflarestorage.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    bucket: "worldcons-artifacts",
    signedFetch,
  };
}

test("R2 S3 transport round-trips put/get/head without changing storageRef", async () => {
  const calls: { url: string; method: string; contentType?: string }[] = [];
  const signedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, contentType: headers.get("content-type") ?? undefined });
    if (method === "PUT") return new Response(null, { status: 200 });
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(PAYLOAD.byteLength) } });
    }
    return new Response(PAYLOAD, {
      status: 200,
      headers: { "content-length": String(PAYLOAD.byteLength), "content-type": "application/json" },
    });
  };

  const transport = createR2S3ArtifactBlobTransport(r2Options(signedFetch));
  const store = new ArtifactBlobStore(transport);
  const uploaded = await store.put({ kind: "fetch", sourceKey: SOURCE_KEY, bytes: PAYLOAD });

  assert.equal(uploaded.storageRef, REF);
  assert.deepEqual(await store.get(REF), PAYLOAD);
  assert.equal((await store.head(REF)).size, PAYLOAD.byteLength);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].contentType, "application/json");
  assert.ok(calls.every((call) => call.url.includes("/worldcons-artifacts/artifacts/fetch/")));
  assert.ok(calls.every((call) => !call.url.includes("test-secret-key")));
});

test("R2 GET maps only NoSuchKey to object not-found", async () => {
  const noSuchKey = createR2S3ArtifactBlobTransport(r2Options(async () =>
    new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
  ));
  assert.equal(await noSuchKey.get(REF, { access: "private", useCache: false }), null);

  const noSuchBucket = createR2S3ArtifactBlobTransport(r2Options(async () =>
    new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })
  ));
  await assert.rejects(
    () => noSuchBucket.get(REF, { access: "private", useCache: false }),
    /artifact_blob\.r2_get_failed/,
  );
});

test("R2 HEAD probes an ambiguous 404 and only treats NoSuchKey as missing", async () => {
  let calls = 0;
  const missing = createR2S3ArtifactBlobTransport(r2Options(async (_input, init) => {
    calls += 1;
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }));
  const head = await missing.head(REF);
  assert.equal(head.pathname, `${REF}.missing`);
  assert.equal(calls, 2);

  const bucketMissing = createR2S3ArtifactBlobTransport(r2Options(async (_input, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
  }));
  await assert.rejects(() => bucketMissing.head(REF), /artifact_blob\.r2_head_failed/);
});

test("R2 auth, provider, network and 5xx errors fail closed with stable non-secret codes", async () => {
  const secret = "do-not-leak-this-secret";
  const cases = [
    async () => new Response(`<Error><Code>AccessDenied</Code><Message>${secret}</Message></Error>`, { status: 403 }),
    async () => new Response("<Error><Code>SlowDown</Code></Error>", { status: 429 }),
    async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }),
    async () => { throw new Error(`network failed ${secret}`); },
  ];

  for (const signedFetch of cases) {
    const transport = createR2S3ArtifactBlobTransport(r2Options(signedFetch));
    await assert.rejects(
      () => transport.get(REF, { access: "private", useCache: false }),
      (error: Error) => {
        assert.equal(error.message, "artifact_blob.r2_get_failed");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
});

test("R2 factory requires explicit credentials unless a Worker binding is injected", () => {
  assert.throws(
    () => createArtifactBlobTransport({ [ARTIFACT_BLOB_PROVIDER_ENV]: "r2" }),
    /artifact_blob\.r2_not_configured/,
  );

  const binding: ArtifactBlobR2Bucket = {
    async put() { return {}; },
    async get() { return null; },
    async head() { return null; },
  };
  const transport = createArtifactBlobTransport(
    { [ARTIFACT_BLOB_PROVIDER_ENV]: "r2" },
    { r2Binding: binding },
  );
  assert.equal(typeof transport.put, "function");
});

test("Worker R2 binding transport preserves private content type and object-missing semantics", async () => {
  const objects = new Map<string, Buffer>();
  const contentTypes = new Map<string, string | undefined>();
  const binding: ArtifactBlobR2Bucket = {
    async put(key, value, options) {
      objects.set(key, Buffer.from(value));
      contentTypes.set(key, options?.httpMetadata?.contentType);
      return {};
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: streamOf(value), size: value.byteLength } : null;
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength } : null;
    },
  };
  const store = new ArtifactBlobStore(createR2BindingArtifactBlobTransport({ bucket: binding }));
  const uploaded = await store.put({ kind: "fetch", sourceKey: SOURCE_KEY, bytes: PAYLOAD });
  assert.equal(uploaded.storageRef, REF);
  assert.equal(contentTypes.get(REF), "application/json");
  assert.deepEqual(await store.get(REF), PAYLOAD);

  const missing = buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex("missing"));
  await assert.rejects(() => store.get(missing), /artifact_blob\.not_found/);
  await assert.rejects(() => store.head(missing), /artifact_blob\.not_found/);
});

test("ordered fallback chain stops at first hit and writes only to primary", async () => {
  const primary = new MemoryTransport();
  const fallback1 = new MemoryTransport();
  const fallback2 = new MemoryTransport();
  fallback2.objects.set(REF, PAYLOAD);
  const transport = createArtifactBlobFallbackTransport({ primary, fallbacks: [fallback1, fallback2] });
  const store = new ArtifactBlobStore(transport);

  assert.deepEqual(await store.get(REF), PAYLOAD);
  assert.deepEqual(primary.gets, [REF]);
  assert.deepEqual(fallback1.gets, [REF]);
  assert.deepEqual(fallback2.gets, [REF]);

  await transport.put(REF, PAYLOAD, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  assert.deepEqual(primary.puts, [REF]);
  assert.deepEqual(fallback1.puts, []);
  assert.deepEqual(fallback2.puts, []);
});

test("ordered fallback chain never masks operational errors", async () => {
  const primary = new MemoryTransport();
  const fallback1 = new MemoryTransport();
  const fallback2 = new MemoryTransport();
  fallback2.objects.set(REF, PAYLOAD);
  fallback1.getError = new Error("legacy-provider-suspended");
  const transport = createArtifactBlobFallbackTransport({ primary, fallbacks: [fallback1, fallback2] });

  await assert.rejects(
    () => transport.get(REF, { access: "private", useCache: false }),
    /legacy-provider-suspended/,
  );
  assert.deepEqual(fallback2.gets, []);
});

test("factory can select R2 and ordered legacy fallback without provider details in refs", async () => {
  const r2 = new MemoryTransport();
  const vercel = new MemoryTransport();
  vercel.objects.set(REF, PAYLOAD);
  const transport = createArtifactBlobTransport(
    {
      [ARTIFACT_BLOB_PROVIDER_ENV]: "r2",
      [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "vercel",
    },
    { r2Transport: () => r2, vercelTransport: () => vercel },
  );
  const store = new ArtifactBlobStore(transport);
  assert.deepEqual(await store.get(REF), PAYLOAD);
  assert.equal(REF.startsWith("artifacts/fetch/"), true);
  assert.equal(REF.includes("r2"), false);
  assert.equal(REF.includes("vercel"), false);
});
