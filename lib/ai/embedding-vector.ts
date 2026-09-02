/**
 * Validates and L2-normalizes an embedding before it crosses a storage or RPC
 * boundary. Gemini's reduced-dimension output is not guaranteed to be unit
 * length, while WorldCons compares vectors with cosine distance.
 */
export function normalizeEmbeddingVector(values: readonly number[], expectedDimensions: number) {
  if (values.length !== expectedDimensions) {
    throw new Error(`Embedding returned ${values.length} dimensions, expected ${expectedDimensions}.`);
  }

  let squaredNorm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite value.");
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding has a zero or invalid norm.");
  return values.map((value) => value / norm);
}
