import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEmbeddingVector } from "@/lib/ai/embedding-vector";

test("embedding normalization produces a finite unit vector", () => {
  const normalized = normalizeEmbeddingVector([3, 4], 2);
  assert.deepEqual(normalized, [0.6, 0.8]);
  assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12);
});

test("embedding normalization rejects wrong width and invalid vectors", () => {
  assert.throws(() => normalizeEmbeddingVector([1], 2), /expected 2/u);
  assert.throws(() => normalizeEmbeddingVector([0, 0], 2), /zero or invalid norm/u);
  assert.throws(() => normalizeEmbeddingVector([1, Number.NaN], 2), /non-finite/u);
});
