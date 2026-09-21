import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_BLOB_PROVIDER_ENV,
  type ArtifactBlobR2Bucket,
} from "../lib/storage/blob";
import {
  createR2BindingRuntimeArtifactBlobStore,
  createRuntimeArtifactBlobStore,
} from "../lib/storage/runtime-blob";
import { setRuntimeArtifactBlobR2Binding } from "../lib/storage/runtime-binding";

test("runtime R2 binding store forces the binding transport without S3 credentials", async () => {
  const objects = new Map<string, Uint8Array>();
  const bucket: ArtifactBlobR2Bucket = {
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        size: value.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(value));
            controller.close();
          },
        }),
      };
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength } : null;
    },
  };

  const store = createR2BindingRuntimeArtifactBlobStore(bucket, {
    [ARTIFACT_BLOB_PROVIDER_ENV]: "vercel",
  });
  const bytes = new TextEncoder().encode('{"ok":true}');
  const uploaded = await store.put({ kind: "fetch", sourceKey: "us-scotus", bytes });

  assert.equal(objects.has(uploaded.storageRef), true);
  assert.deepEqual(await store.get(uploaded.storageRef), Buffer.from(bytes));
  assert.deepEqual(await store.head(uploaded.storageRef), { size: bytes.byteLength });
});

test("runtime slot selects the Worker binding and can be cleared back to the host factory", async () => {
  const objects = new Map<string, Uint8Array>();
  const bucket: ArtifactBlobR2Bucket = {
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        size: value.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(value));
            controller.close();
          },
        }),
      };
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength } : null;
    },
  };

  setRuntimeArtifactBlobR2Binding(bucket);
  try {
    const store = createRuntimeArtifactBlobStore({ [ARTIFACT_BLOB_PROVIDER_ENV]: "vercel" });
    const bytes = new TextEncoder().encode('{"worker":true}');
    const uploaded = await store.put({ kind: "normalization", sourceKey: "de-bverfg", bytes });
    assert.equal(objects.has(uploaded.storageRef), true);
  } finally {
    setRuntimeArtifactBlobR2Binding(null);
  }
});
