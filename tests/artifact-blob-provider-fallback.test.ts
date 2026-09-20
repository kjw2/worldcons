import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_BLOB_BUCKET_ENV,
  ARTIFACT_BLOB_PROVIDER_ENV,
  ARTIFACT_BLOB_READ_FALLBACK_ENV,
  ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV,
  ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT,
  ArtifactBlobStore,
  artifactBlobReadFallbackEnabled,
  buildArtifactStorageRef,
  createArtifactBlobFallbackTransport,
  createArtifactBlobStore,
  createArtifactBlobTransport,
  createSupabaseArtifactBlobTransport,
  isSupabaseObjectNotFound,
  resolveArtifactBlobBucket,
  resolveArtifactBlobFallbackProviders,
  resolveArtifactBlobProvider,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobSupabaseBucket,
  type ArtifactBlobSupabaseClient,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const SOURCE_KEY = "es-tribunal-constitucional";
const REF = buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex("payload"));

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
  putError: unknown = null;
  getError: unknown = null;
  headError: unknown = null;

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    if (this.putError) throw this.putError;
    this.puts.push({ pathname, body: Buffer.from(body), options });
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    if (this.getError) throw this.getError;
    const stored = this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    this.heads.push(pathname);
    if (this.headError) throw this.headError;
    const stored = this.objects.get(pathname);
    if (!stored) return { pathname: `${pathname}.missing`, size: 0 };
    return { pathname, size: stored.byteLength };
  }
}

class FakeSupabaseObjects implements ArtifactBlobSupabaseBucket {
  readonly objects = new Map<string, Buffer>();
  readonly uploads: { pathname: string; body: Buffer; options: { contentType: string; upsert: boolean } }[] = [];
  readonly downloads: string[] = [];
  readonly infos: string[] = [];
  uploadPath: string | null = null;
  uploadError: unknown = null;
  uploadThrow: unknown = null;
  downloadError: unknown = null;
  downloadThrow: unknown = null;
  infoError: unknown = null;
  infoThrow: unknown = null;
  infoSizeOverride: number | null = null;

  async upload(pathname: string, body: Buffer, options: { contentType: string; upsert: boolean }) {
    if (this.uploadThrow) throw this.uploadThrow;
    this.uploads.push({ pathname, body: Buffer.from(body), options });
    if (this.uploadError) return { data: null, error: this.uploadError };
    this.objects.set(pathname, Buffer.from(body));
    return { data: { path: this.uploadPath ?? pathname }, error: null };
  }

  async download(pathname: string) {
    this.downloads.push(pathname);
    if (this.downloadThrow) throw this.downloadThrow;
    if (this.downloadError) return { data: null, error: this.downloadError };
    const stored = this.objects.get(pathname);
    if (!stored) return { data: null, error: { message: "Object not found", status: 404, statusCode: "404" } };
    const copy = new Uint8Array(stored.byteLength);
    copy.set(stored);
    return { data: new Blob([copy]), error: null };
  }

  async info(pathname: string) {
    this.infos.push(pathname);
    if (this.infoThrow) throw this.infoThrow;
    if (this.infoError) return { data: null, error: this.infoError };
    const stored = this.objects.get(pathname);
    const size = this.infoSizeOverride ?? stored?.byteLength;
    if (size === undefined) return { data: null, error: { message: "Object not found", status: 404, statusCode: "404" } };
    return { data: { size }, error: null };
  }
}

class FakeSupabaseClient implements ArtifactBlobSupabaseClient {
  readonly bucketIds: string[] = [];
  readonly objects = new FakeSupabaseObjects();
  readonly storage = {
    from: (bucket: string) => {
      this.bucketIds.push(bucket);
      return this.objects;
    },
  };
}

// --- provider selection ----------------------------------------------------

test("provider defaults to vercel and recognizes explicit supabase or r2 selection", () => {
  assert.equal(resolveArtifactBlobProvider({}), "vercel");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "" }), "vercel");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "  " }), "vercel");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "vercel" }), "vercel");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "  Vercel " }), "vercel");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "supabase" }), "supabase");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: " SUPABASE " }), "supabase");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "r2" }), "r2");
  assert.equal(resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: " R2 " }), "r2");
  assert.throws(() => resolveArtifactBlobProvider({ [ARTIFACT_BLOB_PROVIDER_ENV]: "s3" }), /invalid_provider/);
});

test("read fallback is explicit-true only", () => {
  assert.equal(artifactBlobReadFallbackEnabled({}), false);
  assert.equal(artifactBlobReadFallbackEnabled({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "true" }), true);
  assert.equal(artifactBlobReadFallbackEnabled({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: " TRUE " }), true);
  assert.equal(artifactBlobReadFallbackEnabled({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "1" }), false);
  assert.equal(artifactBlobReadFallbackEnabled({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "yes" }), false);
  assert.equal(artifactBlobReadFallbackEnabled({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "false" }), false);
});

test("ordered fallback providers are explicit, validated, and keep the legacy vercel alias", () => {
  assert.deepEqual(resolveArtifactBlobFallbackProviders({}, "vercel"), []);
  assert.deepEqual(
    resolveArtifactBlobFallbackProviders({ [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "true" }, "r2"),
    ["vercel"],
  );
  assert.deepEqual(
    resolveArtifactBlobFallbackProviders(
      { [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "vercel,supabase" },
      "r2",
    ),
    ["vercel", "supabase"],
  );
  assert.throws(
    () => resolveArtifactBlobFallbackProviders(
      { [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "r2" },
      "r2",
    ),
    /invalid_fallback/,
  );
  assert.throws(
    () => resolveArtifactBlobFallbackProviders(
      { [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "vercel,vercel" },
      "r2",
    ),
    /invalid_fallback/,
  );
  assert.throws(
    () => resolveArtifactBlobFallbackProviders(
      { [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "gcs" },
      "r2",
    ),
    /invalid_fallback_provider/,
  );
});

test("bucket name defaults to the private worldcons bucket and rejects invalid names", () => {
  assert.equal(resolveArtifactBlobBucket({}), ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT);
  assert.equal(resolveArtifactBlobBucket({ [ARTIFACT_BLOB_BUCKET_ENV]: "  " }), ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT);
  assert.equal(resolveArtifactBlobBucket({ [ARTIFACT_BLOB_BUCKET_ENV]: "custom-bucket" }), "custom-bucket");
  assert.throws(() => resolveArtifactBlobBucket({ [ARTIFACT_BLOB_BUCKET_ENV]: "Bad Bucket" }), /invalid_bucket/);
  assert.throws(() => resolveArtifactBlobBucket({ [ARTIFACT_BLOB_BUCKET_ENV]: "-leading" }), /invalid_bucket/);
});

test("transport factory keeps vercel the default and only builds supabase on explicit selection", () => {
  const vercelCalls: string[] = [];
  const vercelTransport = new FakeTransport();
  const supabaseClient = new FakeSupabaseClient();

  const defaulted = createArtifactBlobTransport({}, {
    vercelTransport: () => {
      vercelCalls.push("vercel");
      return vercelTransport;
    },
    supabaseClient: () => supabaseClient,
  });
  assert.equal(defaulted, vercelTransport);
  assert.deepEqual(vercelCalls, ["vercel"]);
  assert.deepEqual(supabaseClient.bucketIds, []);

  let supabaseCalls = 0;
  const supabaseTransport = createArtifactBlobTransport(
    { [ARTIFACT_BLOB_PROVIDER_ENV]: "supabase" },
    {
      vercelTransport: () => {
        throw new Error("vercel_transport_must_not_be_built_primary_only");
      },
      supabaseClient: () => {
        supabaseCalls += 1;
        return supabaseClient;
      },
    },
  );
  assert.equal(supabaseCalls, 1);
  assert.equal(typeof supabaseTransport.put, "function");
  assert.deepEqual(supabaseClient.bucketIds, [ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT]);
});

test("transport factory requires service-role credentials when supabase is selected", () => {
  assert.throws(
    () => createArtifactBlobTransport({ [ARTIFACT_BLOB_PROVIDER_ENV]: "supabase" }),
    /supabase_not_configured/,
  );
  assert.throws(
    () => createArtifactBlobTransport({ [ARTIFACT_BLOB_PROVIDER_ENV]: "gcs" }),
    /invalid_provider/,
  );
});

test("transport factory wraps supabase with the read fallback only when enabled", async () => {
  const missingRef = buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex("missing"));
  const supabaseClient = new FakeSupabaseClient();
  supabaseClient.objects.objects.set(REF, Buffer.from("supabase-bytes"));
  const vercelTransport = new FakeTransport();
  vercelTransport.objects.set(missingRef, Buffer.from("vercel-bytes"));

  const fallbackEnabled = createArtifactBlobTransport(
    {
      [ARTIFACT_BLOB_PROVIDER_ENV]: "supabase",
      [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "true",
      [ARTIFACT_BLOB_BUCKET_ENV]: "artifacts-bucket",
    },
    { vercelTransport: () => vercelTransport, supabaseClient: () => supabaseClient },
  );
  assert.deepEqual(supabaseClient.bucketIds, ["artifacts-bucket"]);

  const value = await fallbackEnabled.get(missingRef, { access: "private", useCache: false });
  assert.equal(value?.statusCode, 200);
  assert.deepEqual(vercelTransport.gets, [missingRef]);

  const primaryOnly = createArtifactBlobTransport(
    { [ARTIFACT_BLOB_PROVIDER_ENV]: "supabase" },
    {
      vercelTransport: () => {
        throw new Error("vercel_transport_must_not_be_built_primary_only");
      },
      supabaseClient: () => new FakeSupabaseClient(),
    },
  );
  assert.equal(await primaryOnly.get(missingRef, { access: "private", useCache: false }), null);
});

// --- supabase transport ----------------------------------------------------

test("supabase transport uploads through the private bucket with upsert and content type", async () => {
  const client = new FakeSupabaseClient();
  const transport = createSupabaseArtifactBlobTransport({ client });
  const bytes = Buffer.from("payload-bytes");

  const uploaded = await transport.put(REF, bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });

  assert.deepEqual(uploaded, { pathname: REF });
  assert.deepEqual(client.bucketIds, [ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT]);
  assert.equal(client.objects.uploads.length, 1);
  assert.equal(client.objects.uploads[0].pathname, REF);
  assert.deepEqual(client.objects.uploads[0].options, { contentType: "application/json", upsert: true });
  assert.deepEqual(client.objects.uploads[0].body, bytes);
});

test("supabase transport reports failures as stable codes without leaking configuration", async () => {
  const client = new FakeSupabaseClient();
  const transport = createSupabaseArtifactBlobTransport({ client, bucket: "artifacts-bucket" });
  const bytes = Buffer.from("payload");
  const options: ArtifactBlobPutOptions = {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  };

  client.objects.uploadError = { message: "row level security violation for artifacts-bucket", status: 403 };
  await assert.rejects(() => transport.put(REF, bytes, options), (error: Error) => {
    assert.equal(error.message, "artifact_blob.supabase_put_failed");
    return true;
  });

  client.objects.uploadError = null;
  client.objects.uploadThrow = new Error("fetch failed to https://example.supabase.co");
  await assert.rejects(() => transport.put(REF, bytes, options), /supabase_put_failed/);
});

test("supabase transport mismatched upload path is surfaced by the store as a pathname mismatch", async () => {
  const client = new FakeSupabaseClient();
  client.objects.uploadPath = `${REF}.other`;
  const store = new ArtifactBlobStore(createSupabaseArtifactBlobTransport({ client }));
  await assert.rejects(
    () => store.put({ kind: "fetch", sourceKey: SOURCE_KEY, bytes: Buffer.from("payload") }),
    /artifact_blob\.pathname_mismatch/,
  );
});

test("supabase transport reads bytes and size with a round-trip through the store", async () => {
  const client = new FakeSupabaseClient();
  const store = new ArtifactBlobStore(createSupabaseArtifactBlobTransport({ client }));
  const bytes = Buffer.from(JSON.stringify({ sourceKey: SOURCE_KEY, text: "hello" }));

  const ref = await store.put({ kind: "fetch", sourceKey: SOURCE_KEY, bytes });
  assert.equal(ref.storageRef, buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex(bytes)));
  assert.deepEqual(await store.get(ref.storageRef), bytes);
  assert.equal((await store.head(ref.storageRef)).size, bytes.byteLength);
  assert.deepEqual(client.objects.downloads, [ref.storageRef]);
  assert.deepEqual(client.objects.infos, [ref.storageRef]);
});

test("supabase transport treats only an unambiguous object-level 404 as not-found", async () => {
  assert.equal(isSupabaseObjectNotFound({ status: 404 }), false);
  assert.equal(isSupabaseObjectNotFound({ statusCode: "404" }), false);
  assert.equal(isSupabaseObjectNotFound({ message: "Object not found" }), true);
  assert.equal(isSupabaseObjectNotFound({ message: "Object not found", status: 404, statusCode: "404" }), true);
  assert.equal(isSupabaseObjectNotFound({ message: "Bucket not found", status: 404, statusCode: "404" }), false);
  assert.equal(isSupabaseObjectNotFound({ message: "Bucket not found", status: 400, statusCode: "400" }), false);
  assert.equal(isSupabaseObjectNotFound({ message: "Invalid JWT", status: 401, statusCode: "401" }), false);
  assert.equal(isSupabaseObjectNotFound(new Error("network down")), false);
  assert.equal(isSupabaseObjectNotFound(null), false);

  const client = new FakeSupabaseClient();
  const transport = createSupabaseArtifactBlobTransport({ client });

  assert.equal(await transport.get(REF, { access: "private", useCache: false }), null);
  const head = await transport.head(REF);
  assert.equal(head.pathname, `${REF}.missing`);

  client.objects.downloadError = { message: "Invalid JWT", status: 401, statusCode: "401" };
  await assert.rejects(() => transport.get(REF, { access: "private", useCache: false }), /supabase_get_failed/);

  client.objects.downloadError = null;
  client.objects.downloadThrow = new Error("socket hang up");
  await assert.rejects(() => transport.get(REF, { access: "private", useCache: false }), /supabase_get_failed/);

  client.objects.infoError = { message: "Bucket not found", status: 400, statusCode: "400" };
  await assert.rejects(() => transport.head(REF), /supabase_head_failed/);

  client.objects.infoError = null;
  client.objects.infoThrow = new Error("socket hang up");
  await assert.rejects(() => transport.head(REF), /supabase_head_failed/);
});

test("supabase transport uses a custom bucket name and rejects invalid ones", async () => {
  const client = new FakeSupabaseClient();
  const transport = createSupabaseArtifactBlobTransport({ client, bucket: "worldcons-artifacts-v2" });
  await transport.head(REF);
  assert.deepEqual(client.bucketIds, ["worldcons-artifacts-v2"]);

  assert.throws(
    () => createSupabaseArtifactBlobTransport({ client, bucket: "-bad" }),
    /invalid_bucket/,
  );
});

// --- read fallback ---------------------------------------------------------

test("fallback transport writes only to the primary provider", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  const transport = createArtifactBlobFallbackTransport({ primary, fallback });
  const options: ArtifactBlobPutOptions = {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  };

  await transport.put(REF, Buffer.from("payload"), options);
  assert.equal(primary.puts.length, 1);
  assert.equal(fallback.puts.length, 0);
});

test("fallback transport serves primary hits without consulting the fallback", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  primary.objects.set(REF, Buffer.from("primary-bytes"));
  const transport = createArtifactBlobFallbackTransport({ primary, fallback });

  const getResult = await transport.get(REF, { access: "private", useCache: false });
  assert.equal(getResult?.statusCode, 200);
  assert.equal((await transport.head(REF)).size, Buffer.byteLength("primary-bytes"));
  assert.deepEqual(fallback.gets, []);
  assert.deepEqual(fallback.heads, []);
});

test("fallback transport reads the fallback only on primary not-found", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  fallback.objects.set(REF, Buffer.from("fallback-bytes"));
  const transport = createArtifactBlobFallbackTransport({ primary, fallback });
  const store = new ArtifactBlobStore(transport);

  assert.deepEqual(await store.get(REF), Buffer.from("fallback-bytes"));
  assert.equal((await store.head(REF)).size, Buffer.byteLength("fallback-bytes"));
  assert.deepEqual(fallback.gets, [REF]);
  assert.deepEqual(fallback.heads, [REF]);
});

test("fallback transport never falls back on primary operational errors", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  fallback.objects.set(REF, Buffer.from("fallback-bytes"));
  const transport = createArtifactBlobFallbackTransport({ primary, fallback });

  primary.getError = new Error("primary_get_operational");
  await assert.rejects(() => transport.get(REF, { access: "private", useCache: false }), /primary_get_operational/);
  assert.deepEqual(fallback.gets, []);

  primary.getError = null;
  primary.headError = new Error("primary_head_operational");
  await assert.rejects(() => transport.head(REF), /primary_head_operational/);
  assert.deepEqual(fallback.heads, []);
});

test("fallback transport fails closed when neither provider has the object", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  const store = new ArtifactBlobStore(createArtifactBlobFallbackTransport({ primary, fallback }));

  await assert.rejects(() => store.get(REF), /artifact_blob\.not_found/);
  await assert.rejects(() => store.head(REF), /artifact_blob\.not_found/);
});

test("fallback transport surfaces a fallback operational error unchanged", async () => {
  const primary = new FakeTransport();
  const fallback = new FakeTransport();
  fallback.getError = new Error("fallback_get_operational");
  fallback.headError = new Error("fallback_head_operational");
  const transport = createArtifactBlobFallbackTransport({ primary, fallback });

  await assert.rejects(() => transport.get(REF, { access: "private", useCache: false }), /fallback_get_operational/);
  await assert.rejects(() => transport.head(REF), /fallback_head_operational/);
});

test("existing store contract and content-addressed refs are unchanged by the provider layer", () => {
  const store = createArtifactBlobStore(new FakeTransport());
  assert.ok(store instanceof ArtifactBlobStore);
  assert.equal(
    buildArtifactStorageRef("article_raw", SOURCE_KEY, sha256Hex("x")),
    `artifacts/article_raw/${SOURCE_KEY}/${sha256Hex("x")}.json`,
  );
});
