import {
  VECTOR_METADATA_INDEX_MANIFEST,
  type VectorMetadataIndexDefinition,
  type VectorizeProjectionRecord,
} from "@/lib/cloudflare/search-vector";
import { boundedMessage, materializeError } from "./errors";
import {
  SEARCH_MATERIALIZE_VECTOR_DELETE_BATCH_SIZE,
  SEARCH_MATERIALIZE_VECTOR_DIMENSIONS,
  SEARCH_MATERIALIZE_VECTOR_INDEX,
  SEARCH_MATERIALIZE_VECTOR_LIST_MAX_PAGES,
  SEARCH_MATERIALIZE_VECTOR_METRIC,
  SEARCH_MATERIALIZE_VECTOR_MUTATION_POLL_MS,
  SEARCH_MATERIALIZE_VECTOR_MUTATION_TIMEOUT_MS,
  SEARCH_MATERIALIZE_VECTOR_UPSERT_BATCH_SIZE,
  type VectorizeIndexConfig,
  type VectorizeMaterializationResult,
  type VectorizeMetadataIndexState,
  type VectorizePlanReport,
  type VectorizePreflight,
} from "./types";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DEFAULT_TIMEOUT_MS = 120_000;
const VECTORIZE_LIST_PAGE_SIZE = 1_000;

export interface VectorizeRestClientOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface VectorizeRestClient {
  listIndexes(): Promise<VectorizeIndexConfig[]>;
  createIndex(name: string): Promise<void>;
  listMetadataIndexes(name: string): Promise<VectorizeMetadataIndexState[]>;
  createMetadataIndex(name: string, definition: VectorMetadataIndexDefinition): Promise<string>;
  listVectorIds(name: string): Promise<{ ids: string[]; vectorCount: number }>;
  upsert(name: string, records: readonly VectorizeProjectionRecord[]): Promise<string>;
  deleteByIds(name: string, ids: readonly string[]): Promise<string>;
  mutationProcessed(name: string, mutationId: string): Promise<{ processed: boolean; vectorCount: number | null }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * Reads a non-empty scalar as a string. A mutation identifier is documented as a
 * string (maxLength 36) by the Vectorize v2 REST API, so it is compared exactly;
 * a numeric value is accepted only for the older binding-style shape.
 */
function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function parseIndexConfig(entry: Record<string, unknown>): VectorizeIndexConfig | null {
  const name = nonEmptyString(entry.name);
  const config = asRecord(entry.config) ?? entry;
  const dimensions = numberField(config, "dimensions");
  const metric = nonEmptyString(config.metric) ?? nonEmptyString(config.similarity_metric);
  if (name === null || dimensions === null || metric === null) return null;
  return { name, dimensions, metric: metric.toLowerCase() };
}

export function createVectorizeRestClient(options: VectorizeRestClientOptions): VectorizeRestClient {
  const { accountId, apiToken } = options;
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("invalid cloudflare account id");
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) throw new Error("invalid cloudflare api token");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid vectorize timeout");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes`;

  const request = async (
    method: string,
    url: string,
    body?: BodyInit | null,
    contentType?: string,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(contentType === undefined ? {} : { "Content-Type": contentType }),
          },
          body: body ?? undefined,
          signal: controller.signal,
        });
      } catch {
        throw controller.signal.aborted
          ? materializeError("vector_apply_failed", "vectorize request timed out")
          : materializeError("vector_apply_failed", "vectorize request failed");
      }
      if (!response.ok) {
        throw materializeError("vector_apply_failed", `vectorize http status ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw materializeError("vector_response_invalid", "vectorize response was not json");
      }
      const record = asRecord(payload);
      if (record === null || record.success !== true) {
        throw materializeError("vector_response_invalid", "vectorize response was not a successful envelope");
      }
      return record.result;
    } finally {
      clearTimeout(timer);
    }
  };

  const applyBody = {
    dimensions: SEARCH_MATERIALIZE_VECTOR_DIMENSIONS,
    metric: SEARCH_MATERIALIZE_VECTOR_METRIC,
  };

  return {
    listIndexes: async () => {
      const result = await request("GET", base);
      const entries = asArray(result) ?? asArray(asRecord(result)?.indexes);
      if (entries === null) throw materializeError("vector_response_invalid", "vectorize index list was not an array");
      const indexes: VectorizeIndexConfig[] = [];
      for (const entry of entries) {
        const record = asRecord(entry);
        if (record === null) continue;
        const config = parseIndexConfig(record);
        if (config !== null) indexes.push(config);
      }
      return indexes;
    },
    createIndex: async (name) => {
      await request("POST", base, JSON.stringify({ name, config: applyBody }), "application/json");
    },
    listMetadataIndexes: async (name) => {
      const result = await request("GET", `${base}/${name}/metadata_index/list`);
      const record = asRecord(result);
      const entries = record === null ? null : asArray(record.metadataIndexes ?? record.metadata_indexes);
      if (entries === null) throw materializeError("vector_response_invalid", "metadata index list was not an array");
      const indexes: VectorizeMetadataIndexState[] = [];
      for (const entry of entries) {
        const item = asRecord(entry);
        const propertyName = item === null ? null : nonEmptyString(item.propertyName ?? item.property_name);
        const type = item === null ? null : nonEmptyString(item.indexType ?? item.index_type);
        if (propertyName === null || type === null) {
          throw materializeError("vector_response_invalid", "metadata index entry was missing propertyName/indexType");
        }
        indexes.push({ propertyName, type: type.toLowerCase() });
      }
      return indexes;
    },
    createMetadataIndex: async (name, definition) => {
      const result = await request(
        "POST",
        `${base}/${name}/metadata_index/create`,
        JSON.stringify({ propertyName: definition.propertyName, indexType: definition.type }),
        "application/json",
      );
      const record = asRecord(result);
      const mutationId = record === null ? null : stringField(record, "mutationId", "mutation_id");
      if (mutationId === null) {
        throw materializeError("vector_response_invalid", "metadata index create returned no mutationId");
      }
      return mutationId;
    },
    listVectorIds: async (name) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let vectorCount: number | null = null;
      for (let page = 0; page < SEARCH_MATERIALIZE_VECTOR_LIST_MAX_PAGES; page += 1) {
        // The v2 endpoint is a GET with `count`/`cursor` query parameters and
        // returns identifiers only (never values).
        const search = new URLSearchParams({ count: String(VECTORIZE_LIST_PAGE_SIZE) });
        if (cursor !== null) search.set("cursor", cursor);
        const result = await request("GET", `${base}/${name}/list?${search.toString()}`);
        const record = asRecord(result);
        if (record === null) throw materializeError("vector_response_invalid", "vectorize list response was not an object");
        const vectors = asArray(record.vectors);
        if (vectors === null) throw materializeError("vector_response_invalid", "vectorize list response had no vectors array");
        for (const entry of vectors) {
          const vector = asRecord(entry);
          const id = vector === null ? null : nonEmptyString(vector.id);
          if (id === null) throw materializeError("vector_response_invalid", "vectorize list entry had no id");
          ids.push(id);
        }
        const total = numberField(record, "totalCount", "total_count");
        if (total !== null) vectorCount = total;
        cursor = nonEmptyString(record.nextCursor ?? record.next_cursor);
        if (cursor === null) break;
      }
      if (cursor !== null) {
        throw materializeError("vector_response_invalid", "vectorize list pagination exceeded the safe page ceiling");
      }
      return { ids, vectorCount: vectorCount ?? ids.length };
    },
    upsert: async (name, records) => {
      // The NDJSON is built here, handed to fetch once and never stored or logged.
      const ndjson = records
        .map((record) => JSON.stringify({ id: record.id, values: record.values, metadata: record.metadata }))
        .join("\n");
      const result = await request("POST", `${base}/${name}/upsert`, ndjson, "application/x-ndjson");
      const record = asRecord(result);
      const mutationId = record === null ? null : stringField(record, "mutationId", "mutation_id");
      if (mutationId === null) throw materializeError("vector_response_invalid", "vectorize upsert returned no mutationId");
      return mutationId;
    },
    deleteByIds: async (name, ids) => {
      const result = await request(
        "POST",
        `${base}/${name}/delete_by_ids`,
        JSON.stringify({ ids: [...ids] }),
        "application/json",
      );
      const record = asRecord(result);
      const mutationId = record === null ? null : stringField(record, "mutationId", "mutation_id");
      if (mutationId === null) throw materializeError("vector_response_invalid", "vectorize delete returned no mutationId");
      return mutationId;
    },
    mutationProcessed: async (name, mutationId) => {
      // `processedUpToMutation` is the identifier of the most recently processed
      // mutation (a string, maxLength 36). Polling waits for it to become exactly
      // the mutation this run submitted; a numeric id is compared numerically.
      const result = await request("GET", `${base}/${name}/info`);
      const record = asRecord(result) ?? {};
      const vectorCount = numberField(record, "vectorCount", "vectorsCount", "vectors_count");
      const processedRaw = stringField(record, "processedUpToMutation", "processed_up_to_mutation");
      if (processedRaw === null) return { processed: false, vectorCount };
      const numericMatch =
        /^\d+$/.test(processedRaw) && /^\d+$/.test(mutationId) && Number(processedRaw) >= Number(mutationId);
      return { processed: processedRaw === mutationId || numericMatch, vectorCount };
    },
  };
}

/** Resolves the exact target index and its metadata/vector state, fail-closed. */
export async function preflightVectorize(client: VectorizeRestClient): Promise<VectorizePreflight> {
  const indexes = await client.listIndexes();
  const matches = indexes.filter((index) => index.name === SEARCH_MATERIALIZE_VECTOR_INDEX);
  if (matches.length > 1) {
    throw materializeError("vector_index_mismatch", "multiple vectorize indexes share the target name");
  }
  const index = matches[0] ?? null;
  if (index === null) {
    return { index: null, metadataIndexes: [], vectorIds: [], vectorCount: 0 };
  }
  if (index.dimensions !== SEARCH_MATERIALIZE_VECTOR_DIMENSIONS || index.metric !== SEARCH_MATERIALIZE_VECTOR_METRIC) {
    throw materializeError(
      "vector_index_mismatch",
      `target index config is ${index.dimensions}/${index.metric}, expected ${SEARCH_MATERIALIZE_VECTOR_DIMENSIONS}/${SEARCH_MATERIALIZE_VECTOR_METRIC}`,
    );
  }
  const metadataIndexes = await client.listMetadataIndexes(index.name);
  const listed = await client.listVectorIds(index.name);
  return { index, metadataIndexes, vectorIds: listed.ids, vectorCount: listed.vectorCount };
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** Whether every expected metadata index exists with the exact expected type. */
export function assessMetadataIndexes(present: readonly VectorizeMetadataIndexState[]): {
  present: string[];
  missing: string[];
  wrongType: { propertyName: string; expected: string; actual: string }[];
} {
  const byName = new Map(present.map((entry) => [entry.propertyName, entry.type]));
  const presentNames: string[] = [];
  const missing: string[] = [];
  const wrongType: { propertyName: string; expected: string; actual: string }[] = [];
  for (const definition of VECTOR_METADATA_INDEX_MANIFEST) {
    const actual = byName.get(definition.propertyName);
    if (actual === undefined) {
      missing.push(definition.propertyName);
    } else if (actual !== definition.type) {
      wrongType.push({ propertyName: definition.propertyName, expected: definition.type, actual });
    } else {
      presentNames.push(definition.propertyName);
    }
  }
  return { present: presentNames, missing, wrongType };
}

export function planVectorizeMaterialization(
  records: readonly VectorizeProjectionRecord[],
  preflight: VectorizePreflight,
  upsertBatchSize: number = SEARCH_MATERIALIZE_VECTOR_UPSERT_BATCH_SIZE,
  deleteBatchSize: number = SEARCH_MATERIALIZE_VECTOR_DELETE_BATCH_SIZE,
): { plan: VectorizePlanReport; deletes: string[] } {
  const desiredIds = new Set(records.map((record) => record.id));
  const remoteIds = new Set(preflight.vectorIds);
  const deletes = sortIds([...remoteIds].filter((id) => !desiredIds.has(id)));
  const upserts = sortIds([...desiredIds]);
  const upsertBatchCount = Math.ceil(upserts.length / upsertBatchSize);
  const deleteBatchCount = Math.ceil(deletes.length / deleteBatchSize);
  const operation = upserts.length === 0 && deletes.length === 0 ? "none" : deletes.length > 0 ? "upsert+delete" : "upsert";
  return {
    plan: {
      operation,
      upsertCount: upserts.length,
      deleteCount: deletes.length,
      upsertBatchCount,
      deleteBatchCount,
      upsertBatchSize,
      deleteBatchSize,
    },
    deletes,
  };
}

async function pollMutation(
  client: VectorizeRestClient,
  name: string,
  mutationId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await client.mutationProcessed(name, mutationId);
    if (status.processed) return;
    if (now() >= deadline) {
      throw materializeError("vector_mutation_timeout", `mutation ${mutationId} was not processed before timeout`);
    }
    await sleep(SEARCH_MATERIALIZE_VECTOR_MUTATION_POLL_MS);
  }
}

export interface ApplyVectorizeOptions {
  client: VectorizeRestClient;
  records: readonly VectorizeProjectionRecord[];
  preflight: VectorizePreflight;
  provisionIndex: boolean;
  createMetadataIndexes: boolean;
  indexName?: string;
  upsertBatchSize?: number;
  deleteBatchSize?: number;
  mutationTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Explicitly applies the vector projection. An absent index is created only when
 * `provisionIndex` is true; missing metadata indexes are created only when
 * `createMetadataIndexes` is true; a wrong type always refuses. Existing records
 * are idempotently upserted and remote-only ids deleted. Every mutation is
 * awaited until processed.
 */
export async function applyVectorizeMaterialization(
  options: ApplyVectorizeOptions,
): Promise<VectorizeMaterializationResult> {
  const {
    client,
    records,
    preflight,
    provisionIndex,
    createMetadataIndexes,
    upsertBatchSize = SEARCH_MATERIALIZE_VECTOR_UPSERT_BATCH_SIZE,
    deleteBatchSize = SEARCH_MATERIALIZE_VECTOR_DELETE_BATCH_SIZE,
    mutationTimeoutMs = SEARCH_MATERIALIZE_VECTOR_MUTATION_TIMEOUT_MS,
  } = options;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const name = options.indexName ?? SEARCH_MATERIALIZE_VECTOR_INDEX;
  const mutationIds: string[] = [];
  const createdMetadata: string[] = [];

  let config = preflight.index;
  if (config === null) {
    if (!provisionIndex) {
      throw materializeError("vector_confirmation_required", "target vectorize index is absent; pass --provision-vector-index");
    }
    await client.createIndex(name);
    config = { name, dimensions: SEARCH_MATERIALIZE_VECTOR_DIMENSIONS, metric: SEARCH_MATERIALIZE_VECTOR_METRIC };
  }

  let assessment = assessMetadataIndexes(preflight.metadataIndexes);
  if (assessment.wrongType.length > 0) {
    throw materializeError(
      "vector_metadata_index_mismatch",
      `metadata index type mismatch for ${assessment.wrongType.map((entry) => entry.propertyName).join(", ")}`,
    );
  }
  if (assessment.missing.length > 0) {
    if (!createMetadataIndexes) {
      throw materializeError(
        "vector_metadata_index_mismatch",
        `missing metadata indexes ${assessment.missing.join(", ")}; explicit apply required`,
      );
    }
    for (const definition of VECTOR_METADATA_INDEX_MANIFEST) {
      if (!assessment.missing.includes(definition.propertyName)) continue;
      // Metadata index creation is an asynchronous mutation; it must be awaited
      // (like every other mutation) before verifying the manifest or upserting.
      const mutationId = await client.createMetadataIndex(name, definition);
      mutationIds.push(mutationId);
      await pollMutation(client, name, mutationId, mutationTimeoutMs, sleep, now);
      createdMetadata.push(definition.propertyName);
    }
    // Re-list so the returned manifest reflects the indexes just created (and any
    // concurrent change) rather than the pre-apply snapshot.
    assessment = assessMetadataIndexes(await client.listMetadataIndexes(name));
  }

  const { plan, deletes } = planVectorizeMaterialization(records, preflight, upsertBatchSize, deleteBatchSize);
  const desiredById = new Map(records.map((record) => [record.id, record]));
  const sortedUpserts = sortIds(records.map((record) => record.id)).map((id) => desiredById.get(id)!);

  for (let start = 0; start < sortedUpserts.length; start += upsertBatchSize) {
    const group = sortedUpserts.slice(start, start + upsertBatchSize);
    const mutationId = await client.upsert(name, group);
    mutationIds.push(mutationId);
    await pollMutation(client, name, mutationId, mutationTimeoutMs, sleep, now);
  }
  for (let start = 0; start < deletes.length; start += deleteBatchSize) {
    const group = deletes.slice(start, start + deleteBatchSize);
    const mutationId = await client.deleteByIds(name, group);
    mutationIds.push(mutationId);
    await pollMutation(client, name, mutationId, mutationTimeoutMs, sleep, now);
  }

  return {
    attempted: true,
    applied: true,
    verified: false,
    state: plan.operation === "none" ? "noop" : "applied",
    config,
    current: { vectorCount: preflight.vectorCount, idCount: preflight.vectorIds.length, idHash: "" },
    desired: { recordCount: records.length, hash: "", missingCount: 0, staleCount: 0 },
    metadataIndexes: {
      expected: VECTOR_METADATA_INDEX_MANIFEST.map((entry) => ({ ...entry })),
      present: assessment.present,
      missing: assessment.missing,
      wrongType: assessment.wrongType,
      created: createdMetadata,
    },
    plan,
    mutationIds,
    verification: null,
    errors: [],
  };
}

export interface VerifyVectorizeOptions {
  client: VectorizeRestClient;
  records: readonly VectorizeProjectionRecord[];
  indexName?: string;
}

/** Re-lists ids, index info and metadata indexes and requires an exact match. */
export async function verifyVectorizeMaterialization(
  options: VerifyVectorizeOptions,
): Promise<VectorizeMaterializationResult["verification"]> {
  const name = options.indexName ?? SEARCH_MATERIALIZE_VECTOR_INDEX;
  const desiredIds = sortIds(options.records.map((record) => record.id));
  const listed = await options.client.listVectorIds(name);
  const actualIds = sortIds(listed.ids);
  const idsOk = desiredIds.length === actualIds.length && desiredIds.every((id, index) => id === actualIds[index]);
  const vectorCountOk = listed.vectorCount === desiredIds.length;
  const indexes = await options.client.listIndexes();
  const config = indexes.find((index) => index.name === name) ?? null;
  const metadata = await options.client.listMetadataIndexes(name);
  const assessment = assessMetadataIndexes(metadata);
  const metadataIndexesOk = assessment.missing.length === 0 && assessment.wrongType.length === 0;
  const dimensions = config?.dimensions ?? null;
  const metric = config?.metric ?? null;
  return {
    ok:
      idsOk &&
      vectorCountOk &&
      metadataIndexesOk &&
      dimensions === SEARCH_MATERIALIZE_VECTOR_DIMENSIONS &&
      metric === SEARCH_MATERIALIZE_VECTOR_METRIC,
    idCount: actualIds.length,
    vectorCount: listed.vectorCount,
    metadataIndexesOk,
    dimensions,
    metric,
  };
}

/** Builds a deterministic skipped/refused vector result. */
export function refusedVectorResult(
  state: VectorizeMaterializationResult["state"],
  errors: string[],
  partial: Partial<VectorizeMaterializationResult> = {},
): VectorizeMaterializationResult {
  return {
    attempted: false,
    applied: false,
    verified: false,
    state,
    config: null,
    current: { vectorCount: 0, idCount: 0, idHash: "" },
    desired: { recordCount: 0, hash: "", missingCount: 0, staleCount: 0 },
    metadataIndexes: {
      expected: VECTOR_METADATA_INDEX_MANIFEST.map((entry) => ({ ...entry })),
      present: [],
      missing: [],
      wrongType: [],
      created: [],
    },
    plan: null,
    mutationIds: [],
    verification: null,
    errors,
    ...partial,
  };
}

export function vectorizeFailure(error: unknown, partial: Partial<VectorizeMaterializationResult> = {}): VectorizeMaterializationResult {
  return refusedVectorResult("failed", [boundedMessage(error)], { attempted: true, ...partial });
}
