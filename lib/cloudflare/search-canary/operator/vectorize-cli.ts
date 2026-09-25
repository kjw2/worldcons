import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WranglerRunner } from "./remote-d1";

/**
 * Operator-only Wrangler Vectorize CLI adapter for the isolated M7.5 canary.
 *
 * Every operation is idempotent from the caller's perspective: index and
 * metadata-index creation are only attempted after a read confirms absence, and
 * upsert is naturally idempotent by vector id. There is deliberately no delete
 * operation. This module is NOT re-exported from the runtime-neutral barrel and
 * imports `node:*`, so Worker code can never load it.
 */
export interface VectorizeIndexInfo {
  name: string;
  dimensions: number | null;
  metric: string | null;
}

export interface VectorizeIndexDetail {
  dimensions: number;
  vectorCount: number;
  processedUpToMutation: string | null;
  processedUpToDatetime: string | null;
}

export interface VectorizeUpsertResult {
  count: number;
}

export interface VectorizeQueryMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

export interface VectorizeUpsertRecord {
  id: string;
  values: readonly number[];
  metadata: Record<string, unknown>;
}

export interface VectorizeQueryOptions {
  vectorId?: string;
  vector?: readonly number[];
  topK: number;
  returnMetadata?: "none" | "indexed" | "all";
  filter?: Record<string, unknown> | null;
}

export interface VectorizeCli {
  listIndexes(): Promise<VectorizeIndexInfo[]>;
  getIndex(name: string): Promise<VectorizeIndexInfo | null>;
  getInfo(name: string): Promise<VectorizeIndexDetail>;
  createIndex(input: { name: string; dimensions: number; metric: "cosine" | "euclidean" | "dot-product" }): Promise<void>;
  listMetadataIndexes(name: string): Promise<string[]>;
  createMetadataIndex(input: { name: string; propertyName: string; type: "string" | "number" }): Promise<void>;
  upsert(name: string, records: readonly VectorizeUpsertRecord[]): Promise<VectorizeUpsertResult>;
  query(name: string, options: VectorizeQueryOptions): Promise<VectorizeQueryMatch[]>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, label: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some current Wrangler commands (notably `vectorize query`) do not expose
    // `--json`; they print a human banner followed by a JSON object. Preserve
    // strict parsing while allowing that documented CLI shape.
    const objectStart = trimmed.indexOf("{");
    if (objectStart >= 0) {
      try {
        return JSON.parse(trimmed.slice(objectStart));
      } catch {
        // fall through to the bounded error below
      }
    }
    throw new Error(`${label} did not return JSON`);
  }
}

function toIndexInfo(entry: unknown): VectorizeIndexInfo {
  if (!isPlainObject(entry) || typeof entry.name !== "string") throw new Error("vectorize list entry is malformed");
  const config = isPlainObject(entry.config) ? entry.config : {};
  return {
    name: entry.name,
    dimensions: typeof config.dimensions === "number" ? config.dimensions : null,
    metric: typeof config.metric === "string" ? config.metric : null,
  };
}

/** Accepts either `["prop"]` or `[{ propertyName: "prop" }]` metadata-index output. */
export function parseMetadataIndexNames(stdout: string): string[] {
  const parsed = parseJson(stdout, "vectorize list-metadata-index");
  if (!Array.isArray(parsed)) throw new Error("vectorize list-metadata-index did not return a JSON array");
  const names: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") names.push(entry);
    else if (isPlainObject(entry) && typeof entry.propertyName === "string") names.push(entry.propertyName);
    else if (isPlainObject(entry) && typeof entry.name === "string") names.push(entry.name);
    else throw new Error("vectorize list-metadata-index entry is malformed");
  }
  return names;
}

/** Accepts either `{ matches: [...] }` or a bare match array. */
export function parseVectorizeMatches(stdout: string): VectorizeQueryMatch[] {
  const parsed = parseJson(stdout, "vectorize query");
  const matches = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.matches) ? parsed.matches : null;
  if (matches === null) throw new Error("vectorize query did not return a match array");
  return matches.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
      throw new Error("vectorize query match is malformed");
    }
    const metadata = isPlainObject(entry.metadata) ? entry.metadata : null;
    return { id: entry.id, score: entry.score, metadata };
  });
}

export function parseVectorizeIndexDetail(stdout: string): VectorizeIndexDetail {
  const parsed = parseJson(stdout, "vectorize info");
  if (!isPlainObject(parsed) || typeof parsed.dimensions !== "number" || typeof parsed.vectorCount !== "number") {
    throw new Error("vectorize info did not return dimensions/vectorCount");
  }
  return {
    dimensions: parsed.dimensions,
    vectorCount: parsed.vectorCount,
    processedUpToMutation: typeof parsed.processedUpToMutation === "string" ? parsed.processedUpToMutation : null,
    processedUpToDatetime: typeof parsed.processedUpToDatetime === "string" ? parsed.processedUpToDatetime : null,
  };
}

export function parseVectorizeUpsertResult(stdout: string): VectorizeUpsertResult {
  const parsed = parseJson(stdout, "vectorize upsert");
  if (!isPlainObject(parsed) || typeof parsed.count !== "number" || !Number.isInteger(parsed.count) || parsed.count < 0) {
    throw new Error("vectorize upsert did not return a valid count");
  }
  return { count: parsed.count };
}

export function createVectorizeCli(runner: WranglerRunner): VectorizeCli {
  return {
    async listIndexes() {
      const parsed = parseJson(await runner(["vectorize", "list", "--json"]), "vectorize list");
      if (!Array.isArray(parsed)) throw new Error("vectorize list did not return a JSON array");
      return parsed.map(toIndexInfo);
    },
    async getIndex(name) {
      const indexes = await this.listIndexes();
      return indexes.find((index) => index.name === name) ?? null;
    },
    async getInfo(name) {
      return parseVectorizeIndexDetail(await runner(["vectorize", "info", name, "--json"]));
    },
    async createIndex(input) {
      await runner([
        "vectorize",
        "create",
        input.name,
        "--dimensions",
        String(input.dimensions),
        "--metric",
        input.metric,
        "--json",
      ]);
    },
    async listMetadataIndexes(name) {
      return parseMetadataIndexNames(await runner(["vectorize", "list-metadata-index", name, "--json"]));
    },
    async createMetadataIndex(input) {
      // NOTE: `create-metadata-index --json` crashes on some Wrangler builds, so
      // this intentionally omits `--json` and is accepted by the runner exit code.
      await runner([
        "vectorize",
        "create-metadata-index",
        input.name,
        "--propertyName",
        input.propertyName,
        "--type",
        input.type,
      ]);
    },
    async upsert(name, records) {
      if (records.length === 0) return { count: 0 };
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worldcons-canary-vectors-"));
      const file = path.join(directory, "vectors.ndjson");
      try {
        const lines = records.map((record) =>
          JSON.stringify({ id: record.id, values: [...record.values], metadata: record.metadata }),
        );
        fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
        const result = parseVectorizeUpsertResult(await runner(["vectorize", "upsert", name, "--file", file, "--json"]));
        if (result.count !== records.length) {
          throw new Error(`vectorize upsert accepted ${result.count} of ${records.length} records`);
        }
        return result;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    async query(name, options) {
      const args = ["vectorize", "query", name];
      if (options.vectorId !== undefined) args.push("--vector-id", options.vectorId);
      else if (options.vector !== undefined) args.push("--vector", ...options.vector.map((value) => String(value)));
      else throw new Error("vectorize query requires a vectorId or vector");
      args.push("--top-k", String(options.topK));
      args.push("--return-metadata", options.returnMetadata ?? "indexed");
      if (options.filter !== undefined && options.filter !== null) {
        args.push("--filter", JSON.stringify(options.filter));
      }
      // Wrangler 4.135.0 has no `vectorize query --json` option. Passing it can
      // terminate the Windows CLI abnormally; stdout is a human banner followed
      // by a JSON object and `parseVectorizeMatches` handles that shape.
      return parseVectorizeMatches(await runner(args));
    },
  };
}
