import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV,
  WORLDCONS_WRANGLER_BIN_ENV,
  createOperatorArtifactBlobStore,
  createWranglerR2ArtifactBlobTransport,
  resolveWranglerBinary,
  type WranglerR2Runner,
} from "../lib/storage/operator-blob";
import {
  ARTIFACT_BLOB_BUCKET_ENV,
  ARTIFACT_BLOB_PROVIDER_ENV,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  sha256Hex,
} from "../lib/storage/blob";

const SOURCE = "fr-conseil-constitutionnel";
const BODY = Buffer.from(JSON.stringify({ hello: "r2-operator" }));
const REF = buildArtifactStorageRef("fetch", SOURCE, sha256Hex(BODY));

function fakeWranglerRunner(objects: Map<string, Buffer>): WranglerR2Runner {
  return async (args) => {
    const operation = args[2];
    const objectPath = args[3];
    const fileIndex = args.indexOf("--file");
    const file = fileIndex >= 0 ? args[fileIndex + 1] : null;
    if (!objectPath || !file) throw new Error("bad_test_args");
    if (operation === "put") {
      objects.set(objectPath, await readFile(file));
      return;
    }
    if (operation === "get") {
      const body = objects.get(objectPath);
      if (!body) throw new Error("missing");
      await writeFile(file, body);
      return;
    }
    throw new Error("unsupported");
  };
}

test("Wrangler R2 operator transport round-trips private artifact bytes", async () => {
  const objects = new Map<string, Buffer>();
  const transport = createWranglerR2ArtifactBlobTransport({
    bucket: "worldcons-artifacts",
    runner: fakeWranglerRunner(objects),
  });
  const store = new ArtifactBlobStore(transport);

  const uploaded = await store.put({ kind: "fetch", sourceKey: SOURCE, bytes: BODY });
  assert.equal(uploaded.storageRef, REF);
  assert.deepEqual(await store.get(REF), BODY);
  assert.equal((await store.head(REF)).size, BODY.byteLength);
  assert.deepEqual(objects.get(`worldcons-artifacts/${REF}`), BODY);
});

test("Wrangler R2 operator transport returns stable errors without runner details", async () => {
  const secret = "must-not-leak";
  const runner: WranglerR2Runner = async () => {
    throw new Error(secret);
  };
  const transport = createWranglerR2ArtifactBlobTransport({
    bucket: "worldcons-artifacts",
    runner,
  });
  const store = new ArtifactBlobStore(transport);

  await assert.rejects(
    () => store.put({ kind: "fetch", sourceKey: SOURCE, bytes: BODY }),
    (error: Error) => {
      assert.equal(error.message, "artifact_blob.r2_wrangler_put_failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  await assert.rejects(
    () => store.get(REF),
    (error: Error) => {
      assert.equal(error.message, "artifact_blob.r2_wrangler_get_failed");
      return true;
    },
  );
  await assert.rejects(
    () => store.head(REF),
    (error: Error) => {
      assert.equal(error.message, "artifact_blob.r2_wrangler_head_failed");
      return true;
    },
  );
});

test("operator store uses Wrangler only for explicit R2 operator mode", () => {
  assert.throws(
    () => createOperatorArtifactBlobStore({
      [ARTIFACT_BLOB_PROVIDER_ENV]: "vercel",
      [ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV]: "wrangler",
    }),
    /r2_operator_requires_r2_provider/,
  );
  assert.throws(
    () => createOperatorArtifactBlobStore({
      [ARTIFACT_BLOB_PROVIDER_ENV]: "r2",
      [ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV]: "unknown",
    }),
    /invalid_r2_operator_transport/,
  );
  const store = createOperatorArtifactBlobStore({
    [ARTIFACT_BLOB_PROVIDER_ENV]: "r2",
    [ARTIFACT_BLOB_BUCKET_ENV]: "worldcons-artifacts",
    [ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV]: "wrangler",
  });
  assert.ok(store instanceof ArtifactBlobStore);
});

test("explicit Wrangler binary override is used without PATH lookup", async () => {
  const candidate = process.execPath;
  assert.equal(
    await resolveWranglerBinary({ [WORLDCONS_WRANGLER_BIN_ENV]: candidate }),
    candidate,
  );
});
