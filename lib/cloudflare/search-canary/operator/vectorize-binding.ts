import type { VectorizeIndexBinding, VectorizeQueryOptions, VectorizeQueryResult } from "@/lib/cloudflare/search-vector";
import type { VectorizeCli } from "./vectorize-cli";

/**
 * Operator-only adapter from the Wrangler Vectorize CLI to the runtime-neutral
 * M7.4 `VectorizeIndexBinding`, so the unchanged M7.3/M7.4 orchestrators can run
 * against the isolated remote canary index.
 *
 * `createRemoteVectorizeBinding` sends the query values (bounded by the caller's
 * `maxArticles`); `createRemoteVectorIdBinding` instead queries by an indexed
 * vector id, which is used for the bounded retrieval canary where passing 1536
 * floats on a command line is undesirable.
 */
export function createRemoteVectorizeBinding(cli: VectorizeCli, indexName: string): VectorizeIndexBinding {
  return {
    async query(vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      const matches = await cli.query(indexName, {
        vector,
        topK: options.topK,
        returnMetadata: options.returnMetadata ?? "indexed",
        filter: options.filter ?? null,
      });
      return { matches, count: matches.length };
    },
  };
}

export function createRemoteVectorIdBinding(
  cli: VectorizeCli,
  indexName: string,
  vectorId: string,
): VectorizeIndexBinding {
  return {
    async query(_vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      const matches = await cli.query(indexName, {
        vectorId,
        topK: options.topK,
        returnMetadata: options.returnMetadata ?? "indexed",
        filter: options.filter ?? null,
      });
      return { matches, count: matches.length };
    },
  };
}
