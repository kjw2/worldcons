import assert from "node:assert/strict";
import test from "node:test";
import {
  getRuntimeD1Binding,
  setRuntimeD1Bindings,
  D1_RUNTIME_BINDING_NAMES,
  type D1RuntimeBindings,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import {
  D1_SHADOW_COMPARE_ENV,
  D1_SHADOW_READ_ENV,
  resolveD1ShadowConfig,
  setRuntimeD1ShadowConfig,
  getRuntimeD1ShadowConfig,
  D1_SHADOW_DEFAULT_MAX_ROWS,
  D1_SHADOW_DEFAULT_SAMPLE_RATE,
  D1_SHADOW_DEFAULT_TIMEOUT_MS,
  D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
  type D1ShadowConfig,
} from "../lib/cloudflare/d1/shadow/config";
import { resetShadowInFlight } from "../lib/cloudflare/d1/shadow/inflight";
import type { D1ShadowEvent } from "../lib/cloudflare/d1/shadow/events";
import type { RuntimeBackgroundScheduler } from "../lib/runtime/background";
import { referenceReadShadowCoveredMethods, withReferenceReadShadow } from "../lib/reference-reads/shadow";
import type { ReferenceReadRepository } from "../lib/reference-reads/types";

/**
 * M6.1 reference-read shadow orchestration tests: gate behavior, comparison,
 * backpressure, timeouts and authoritative-result preservation. Every test
 * injects its config, binding, scheduler, sampler and sink so nothing depends on
 * ambient environment or wall-clock timing.
 */

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

function createFakeD1(rowsByTable: Record<string, Record<string, unknown>[]>, delayMs = 0) {
  const calls: CapturedStatement[] = [];
  const database: D1RuntimeDatabase = {
    prepare(query: string): D1RuntimePreparedStatement {
      const record: CapturedStatement = { sql: query, params: [] };
      calls.push(record);
      const statement: D1RuntimePreparedStatement = {
        bind(...params: unknown[]) {
          record.params = params;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const name = Object.keys(rowsByTable).find((table) => query.includes(` from ${table}`));
          let rows = name ? rowsByTable[name] : [];
          const where = / where ([a-z_][a-z0-9_]*) = \?/.exec(query);
          if (where) rows = rows.filter((row) => row[where[1]] === record.params[0]);
          return { success: true, results: rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

function createCollectorScheduler() {
  const tasks: Promise<unknown>[] = [];
  const scheduler: RuntimeBackgroundScheduler = {
    schedule(task: Promise<unknown>) {
      tasks.push(task);
      return true;
    },
  };
  return {
    scheduler,
    async flush() {
      await Promise.allSettled(tasks);
    },
    count: () => tasks.length,
  };
}

const PRIMARY_SOURCES = [
  { id: "de-bverfg", sourceKey: "de-bverfg", name: "BVerfG", jurisdiction: "Germany", baseUrl: "https://b", language: "de", isActive: true },
  { id: "fr-conseil", sourceKey: "fr-conseil", name: "Conseil", jurisdiction: "France", baseUrl: "https://c", language: "fr", isActive: true },
];

const PRIMARY_TERM = {
  slug: "qpc",
  term: "Question prioritaire de constitutionnalite",
  koreanTerm: "우선적 위헌심사절차",
  definition: "프랑스의 사후적 위헌심사 절차",
  jurisdiction: "France",
  relatedTags: ["QPC"],
};

const PRIMARY_TAG = {
  id: "tag-1",
  slug: "qpc",
  name: "QPC",
  normalizedName: "QPC",
  type: "procedure" as const,
  description: null,
  articleCount: 3,
  latestArticleAt: "2026-05-02T00:00:00.000Z",
  confidence: undefined,
};

const PRIMARY_RUNS = [
  {
    id: "run-1",
    sourceKey: "us-scotus",
    startedAt: "2026-05-08T00:00:00.000Z",
    finishedAt: "2026-05-08T00:02:31.000Z",
    status: "completed",
    discoveredCount: 12,
    fetchedCount: 4,
    summarizedCount: 2,
    failedCount: 0,
    errorMessage: null,
    metadata: { mode: "mock" },
  },
];

const PRIMARY_COUNTS = { France: 1, Germany: 1 };

function createAuthoritative(overrides: Partial<ReferenceReadRepository> = {}): ReferenceReadRepository {
  return {
    async listSources() {
      return PRIMARY_SOURCES;
    },
    async listGlossaryTerms() {
      return [PRIMARY_TERM];
    },
    async getGlossaryTerm(slug: string) {
      return slug === "qpc" ? PRIMARY_TERM : null;
    },
    async listTags() {
      return [PRIMARY_TAG];
    },
    async listJurisdictionArticleCounts(jurisdictions: string[] = []) {
      if (jurisdictions.length === 0) return PRIMARY_COUNTS;
      return Object.fromEntries(jurisdictions.map((jurisdiction) => [jurisdiction, PRIMARY_COUNTS[jurisdiction as keyof typeof PRIMARY_COUNTS] ?? 0]));
    },
    async listIngestionRuns() {
      return PRIMARY_RUNS;
    },
    async getTagBySlug(slug: string) {
      return slug === "qpc" ? PRIMARY_TAG : null;
    },
    ...overrides,
  };
}

const D1_SOURCES = [
  {
    id: "de-bverfg",
    source_key: "de-bverfg",
    name: "BVerfG",
    jurisdiction: "Germany",
    base_url: "https://b",
    language: "de",
    is_active: 1,
  },
  {
    id: "fr-conseil",
    source_key: "fr-conseil",
    name: "Conseil",
    jurisdiction: "France",
    base_url: "https://c",
    language: "fr",
    is_active: 1,
  },
];

const D1_GLOSSARY = [
  {
    slug: "qpc",
    term: "Question prioritaire de constitutionnalite",
    korean_term: "우선적 위헌심사절차",
    definition: "프랑스의 사후적 위헌심사 절차",
    jurisdiction: "France",
    related_tags: '["QPC"]',
  },
];

const D1_TAGS = [
  {
    id: "tag-1",
    slug: "qpc",
    name: "QPC",
    normalized_name: "QPC",
    type: "procedure",
    description: null,
    article_count: 3,
    latest_article_at: "2026-05-02T00:00:00.000Z",
  },
];

const D1_RUNS = [
  {
    id: "run-1",
    source_key: "us-scotus",
    started_at: "2026-05-08T00:00:00.000Z",
    finished_at: "2026-05-08T00:02:31.000Z",
    status: "completed",
    discovered_count: 12,
    fetched_count: 4,
    summarized_count: 2,
    failed_count: 0,
    error_message: null,
    metadata: { mode: "mock" },
  },
];

const D1_ARTICLES = [
  { jurisdiction: "France", status: "summarized", source_metadata: { collection: { publishable: true } } },
  { jurisdiction: "Germany", status: "summarized", source_metadata: { collection: { publishable: true } } },
  { jurisdiction: "France", status: "summarized", source_metadata: { collection: { publishable: false } } },
];

function baseConfig(overrides: Partial<D1ShadowConfig> = {}): D1ShadowConfig {
  return {
    readEnabled: true,
    compareEnabled: true,
    surfaces: new Set(["reference"]),
    timeoutMs: D1_SHADOW_DEFAULT_TIMEOUT_MS,
    maxRows: D1_SHADOW_DEFAULT_MAX_ROWS,
    maxInFlight: D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
    sampleRate: 1,
    ...overrides,
  };
}

function captureEvents() {
  const events: D1ShadowEvent[] = [];
  return { events, sink: (event: D1ShadowEvent) => events.push(event) };
}

test("resolveD1ShadowConfig keeps every flag off by default and parses overrides", () => {
  const off = resolveD1ShadowConfig({});
  assert.equal(off.readEnabled, false);
  assert.equal(off.compareEnabled, false);
  assert.deepEqual([...off.surfaces], ["reference"]);
  assert.equal(off.timeoutMs, D1_SHADOW_DEFAULT_TIMEOUT_MS);
  assert.equal(off.maxRows, D1_SHADOW_DEFAULT_MAX_ROWS);
  assert.equal(off.maxInFlight, D1_SHADOW_DEFAULT_MAX_IN_FLIGHT);
  assert.equal(off.sampleRate, D1_SHADOW_DEFAULT_SAMPLE_RATE);

  const on = resolveD1ShadowConfig({
    [D1_SHADOW_READ_ENV]: "true",
    [D1_SHADOW_COMPARE_ENV]: "true",
  });
  assert.equal(on.readEnabled, true);
  assert.equal(on.compareEnabled, true);

  // compare cannot be enabled without the read flag.
  const compareOnly = resolveD1ShadowConfig({ [D1_SHADOW_COMPARE_ENV]: "true" });
  assert.equal(compareOnly.compareEnabled, false);
});

test("runtime D1 bindings round-trip for core/ingest/ops/search and clear", () => {
  const bindings: D1RuntimeBindings = {
    worldcons_core: { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: [] }) }) }) },
  } as unknown as D1RuntimeBindings;
  setRuntimeD1Bindings(bindings);
  try {
    assert.ok(getRuntimeD1Binding("worldcons_core"));
    assert.equal(getRuntimeD1Binding("worldcons_ops"), null);
    assert.deepEqual(Object.values(D1_RUNTIME_BINDING_NAMES).sort(), [
      "WORLDCONS_CORE",
      "WORLDCONS_INGEST",
      "WORLDCONS_OPS",
      "WORLDCONS_SEARCH",
    ]);
  } finally {
    setRuntimeD1Bindings({ worldcons_core: null, worldcons_ingest: null, worldcons_ops: null, worldcons_search: null });
  }
});

test("all flags off does zero shadow work and returns the authoritative result", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ readEnabled: false, compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  const result = await repository.listSources();
  assert.deepEqual(result, PRIMARY_SOURCES);
  assert.equal(result, PRIMARY_SOURCES, "the exact authoritative object must be returned unchanged");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
  assert.equal(events.length, 0);
});

test("read-on compare-off runs the background D1 read but returns the primary result", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  const result = await repository.listSources();
  assert.deepEqual(result, PRIMARY_SOURCES, "the authoritative result must be returned immediately");
  assert.equal(d1.calls.length, 1, "the D1 read must still run");
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "disabled");
  assert.equal(events[0].reason, "compare_disabled");
  assert.equal(events[0].compared, false);
  assert.equal(events[0].readOutcome, "success");
  assert.equal(typeof events[0].latencyMs, "number");
});

test("compare-on match emits matched with counts and hashes but never row content", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listSources();
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].compared, true);
  assert.equal(events[0].orderMatches, true);
  assert.equal(events[0].primaryCount, 2);
  assert.equal(events[0].shadowCount, 2);
  assert.equal(typeof events[0].primaryHash, "string");
  assert.equal(events[0].primaryHash, events[0].shadowHash);
  assert.equal(events[0].diffPath, null);
  assert.equal(JSON.stringify(events[0]).includes("BVerfG"), false, "no row content may be logged");
});

test("compare-on mismatch emits mismatched with a bounded diff path", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({
    sources: D1_SOURCES.map((row) => (row.source_key === "fr-conseil" ? { ...row, name: "Changed" } : row)),
  });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listSources();
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "mismatched");
  assert.equal(events[0].reason, "result_mismatch");
  assert.equal(events[0].compared, true);
  assert.ok(events[0].diffPath && events[0].diffPath.startsWith("listSources["));
  assert.notEqual(events[0].primaryHash, events[0].shadowHash);
});

test("a reordered array is equal but records orderMatches false", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: [...D1_SOURCES].reverse() });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listSources();
  await collector.flush();
  assert.equal(events[0].outcome, "matched");
  assert.equal(events[0].orderMatches, false);
  assert.equal(events[0].primaryHash, events[0].shadowHash);
});

test("getGlossaryTerm compares an object contract and resolves a missing term", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ glossary_terms: D1_GLOSSARY });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  assert.deepEqual(await repository.getGlossaryTerm("qpc"), PRIMARY_TERM);
  await collector.flush();
  assert.equal(events[0].outcome, "matched");
  assert.equal(events[0].method, "getGlossaryTerm");

  const desyncEvents = captureEvents();
  const desync = withReferenceReadShadow(
    createAuthoritative({ getGlossaryTerm: async () => PRIMARY_TERM }),
    {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink: desyncEvents.sink,
    },
  );
  assert.deepEqual(await desync.getGlossaryTerm("missing"), PRIMARY_TERM);
  await collector.flush();
  assert.equal(desyncEvents.events[0].outcome, "mismatched");
  assert.equal(desyncEvents.events[0].primaryCount, 1);
  assert.equal(desyncEvents.events[0].shadowCount, 0, "the D1 query is bounded to the requested slug, so it returns nothing");
});

test("D1 read errors and timeouts are swallowed into events and preserve the primary", async () => {
  resetShadowInFlight();
  const failing: D1RuntimeDatabase = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          throw Object.assign(new Error("d1 unavailable"), { code: "d1_runtime_read.query_failed" });
        },
      } as unknown as D1RuntimePreparedStatement;
    },
  };
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: failing,
    scheduler: collector.scheduler,
    sink,
  });

  assert.deepEqual(await repository.listSources(), PRIMARY_SOURCES);
  await collector.flush();
  assert.equal(events[0].outcome, "error");
  assert.equal(events[0].errorCode, "d1_runtime_read.query_failed");
  assert.equal(events[0].readOutcome, "error");

  resetShadowInFlight();
  const slow = createFakeD1({ sources: D1_SOURCES }, 40);
  const timeoutCollector = createCollectorScheduler();
  const timeoutEvents = captureEvents();
  const timeoutRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ timeoutMs: 1 }),
    binding: slow.database,
    scheduler: timeoutCollector.scheduler,
    sink: timeoutEvents.sink,
  });
  assert.deepEqual(await timeoutRepository.listSources(), PRIMARY_SOURCES);
  await timeoutCollector.flush();
  assert.equal(timeoutEvents.events[0].outcome, "timeout");
  assert.equal(timeoutEvents.events[0].readOutcome, "timeout");
});

test("missing binding, missing scheduler, disallowed surface and sampling all skip", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES });
  const collector = createCollectorScheduler();

  const noBinding = captureEvents();
  const bindingRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: null,
    scheduler: collector.scheduler,
    sink: noBinding.sink,
  });
  await bindingRepository.listSources();
  assert.equal(noBinding.events[0].reason, "no_binding");
  assert.equal(d1.calls.length, 0);

  const noScheduler = captureEvents();
  const schedulerRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: null,
    sink: noScheduler.sink,
  });
  await schedulerRepository.listSources();
  assert.equal(noScheduler.events[0].reason, "no_scheduler");
  assert.equal(collector.count(), 0);
  assert.equal(d1.calls.length, 0);

  const wrongSurface = captureEvents();
  const surfaceRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ surfaces: new Set(["search"]) }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: wrongSurface.sink,
  });
  await surfaceRepository.listSources();
  assert.equal(wrongSurface.events[0].reason, "surface_not_allowed");

  const sampledOut = captureEvents();
  const sampleRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ sampleRate: 0.1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: sampledOut.sink,
    random: () => 0.9,
  });
  await sampleRepository.listSources();
  assert.equal(sampledOut.events[0].reason, "sampled_out");
  assert.equal(d1.calls.length, 0);
});

test("per-isolate max in-flight applies backpressure to a second read", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES }, 20);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ maxInFlight: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listSources();
  await repository.listSources();
  await collector.flush();
  const outcomes = events.map((event) => event.reason);
  assert.ok(outcomes.includes("backpressure"), `expected backpressure, got ${outcomes.join(",")}`);
  assert.equal(d1.calls.length, 1, "the backpressured read must not touch D1");
});

test("M6.2 covers every remaining method while keeping the M6.1 methods shadowed", () => {
  const covered = referenceReadShadowCoveredMethods();
  for (const method of [
    "listSources",
    "listGlossaryTerms",
    "getGlossaryTerm",
    "listTags",
    "getTagBySlug",
    "listIngestionRuns",
    "listJurisdictionArticleCounts",
  ]) {
    assert.ok(covered.includes(method), `${method} must be shadow-covered`);
  }
});

test("M6.1 methods remain shadowed and return authoritative identity after M6.2", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ sources: D1_SOURCES, glossary_terms: D1_GLOSSARY });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
  });

  assert.equal(await repository.listSources(), PRIMARY_SOURCES);
  assert.equal(await repository.getGlossaryTerm("qpc"), PRIMARY_TERM);
  await collector.flush();
  assert.deepEqual(
    events.map((event) => `${event.method}:${event.outcome}`),
    ["listSources:matched", "getGlossaryTerm:matched"],
  );
});

test("legacy listTags shadows, compares and returns the authoritative array by identity", async () => {
  resetShadowInFlight();
  const primary = [PRIMARY_TAG];
  const d1 = createFakeD1({ tags: D1_TAGS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative({ listTags: async () => primary }), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
  });

  const result = await repository.listTags({ limit: 5 });
  assert.equal(result, primary, "the exact authoritative array must be returned unchanged");
  assert.equal(d1.calls.length, 1);
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].method, "listTags");
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].compared, true);
  assert.equal(events[0].primaryCount, 1);
  assert.equal(events[0].shadowCount, 1);
  assert.equal(events[0].primaryHash, events[0].shadowHash);
});

test("listTags skips with zero D1 calls in projection mode and when unbounded or over maxRows", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ tags: D1_TAGS });
  const collector = createCollectorScheduler();

  const projected = captureEvents();
  const projectedRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: projected.sink,
    projection: true,
  });
  await projectedRepository.listTags({ limit: 5 });
  assert.equal(projected.events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 0);

  const unbounded = captureEvents();
  const unboundedRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: unbounded.sink,
    projection: false,
  });
  await unboundedRepository.listTags();
  assert.equal(unbounded.events[0].reason, "unbounded");
  assert.equal(d1.calls.length, 0);

  const exceeds = captureEvents();
  const exceedsRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 3 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: exceeds.sink,
    projection: false,
  });
  await exceedsRepository.listTags({ limit: 5 });
  assert.equal(exceeds.events[0].reason, "limit_exceeds_max_rows");
  assert.equal(d1.calls.length, 0);
});

test("a direct wrapper construction defaults to the conservative projection tag skip", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ tags: D1_TAGS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listTags({ limit: 5 });
  assert.equal(events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 0);
});

test("getTagBySlug shadows in legacy mode, returns authoritative identity and skips in projection mode", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ tags: D1_TAGS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
  });

  assert.equal(await repository.getTagBySlug("qpc"), PRIMARY_TAG);
  await collector.flush();
  assert.equal(events[0].method, "getTagBySlug");
  assert.equal(events[0].outcome, "matched");

  resetShadowInFlight();
  const projected = captureEvents();
  const projectedRepository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: projected.sink,
    projection: true,
  });
  assert.equal(await projectedRepository.getTagBySlug("qpc"), PRIMARY_TAG);
  assert.equal(projected.events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 1, "projection mode must not add a tags D1 read");
});

test("listIngestionRuns skips when the ingest binding is missing even though core exists", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ tags: D1_TAGS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: null,
    scheduler: collector.scheduler,
    sink,
  });

  assert.equal(await repository.listIngestionRuns(5), PRIMARY_RUNS);
  assert.equal(events[0].reason, "no_binding");
  assert.equal(events[0].db, "worldcons_ingest");
  assert.equal(core.calls.length, 0);
});

test("listIngestionRuns reads the ingest binding, compares and returns identity", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ tags: D1_TAGS });
  const ingest = createFakeD1({ ingestion_runs: D1_RUNS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: ingest.database,
    scheduler: collector.scheduler,
    sink,
  });

  assert.equal(await repository.listIngestionRuns(5), PRIMARY_RUNS);
  await collector.flush();
  assert.equal(events[0].method, "listIngestionRuns");
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(core.calls.length, 0, "ingestion runs must never read worldcons_core");
  assert.equal(ingest.calls.length, 1);
});

test("listJurisdictionArticleCounts skips in projection mode and matches the legacy grouping otherwise", async () => {
  resetShadowInFlight();
  const primary = { France: 1, Spain: 0 };
  const d1 = createFakeD1({ articles: D1_ARTICLES });
  const collector = createCollectorScheduler();

  const projected = captureEvents();
  const projectedRepository = withReferenceReadShadow(
    createAuthoritative({ listJurisdictionArticleCounts: async () => primary }),
    {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink: projected.sink,
      projection: true,
    },
  );
  assert.equal(await projectedRepository.listJurisdictionArticleCounts(["France", "Spain"]), primary);
  assert.equal(projected.events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 0);

  resetShadowInFlight();
  const legacy = captureEvents();
  const legacyRepository = withReferenceReadShadow(
    createAuthoritative({ listJurisdictionArticleCounts: async () => primary }),
    {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink: legacy.sink,
      projection: false,
    },
  );
  assert.equal(await legacyRepository.listJurisdictionArticleCounts(["France", "Spain"]), primary);
  await collector.flush();
  assert.equal(legacy.events[0].method, "listJurisdictionArticleCounts");
  assert.equal(legacy.events[0].outcome, "matched", `diffPath=${legacy.events[0].diffPath ?? "null"}`);
  assert.equal(d1.calls.length, 1);
});

test("listJurisdictionArticleCounts overflow is a skip, never a partial comparison", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: D1_ARTICLES });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withReferenceReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
  });

  await repository.listJurisdictionArticleCounts(["France"]);
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].compared, false);
  assert.equal(events[0].readOutcome, "success");
});

test("runtime shadow config slot round-trips", () => {
  const config = baseConfig();
  setRuntimeD1ShadowConfig(config);
  try {
    assert.equal(getRuntimeD1ShadowConfig(), config);
  } finally {
    setRuntimeD1ShadowConfig(null);
  }
  assert.equal(getRuntimeD1ShadowConfig(), null);
});
