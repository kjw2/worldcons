import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  articleRawBlobStorageRef,
  encodeArticleRawText,
} from "../lib/article-raw/codec";
import type { ArticleRawExternalizationCandidate } from "../lib/article-raw/externalization";
import {
  ARTICLE_RAW_BLOB_READ_ENABLED,
  ARTICLE_RAW_BLOB_WRITE_ENABLED,
} from "../lib/article-raw/flags";
import {
  ARTICLE_RAW_READINESS_INLINE_RESTORE,
  runArticleRawReadiness,
  type ArticleRawReadinessDependencies,
  type ArticleRawReadinessTable,
} from "../lib/article-raw/readiness";
import {
  ARTICLE_RAW_READINESS_RPC,
  createPostgresArticleRawReadinessRepository,
  type ArticleRawReadinessAggregate,
} from "../lib/article-raw/readiness-repository";
import {
  ArtifactBlobStore,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const modulePath = path.join(process.cwd(), "lib/article-raw/readiness.ts");
const scriptPath = path.join(process.cwd(), "scripts/article-raw-readiness.ts");
const repositoryPath = path.join(process.cwd(), "lib/article-raw/readiness-repository.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919170000_article_raw_readiness_observability.sql",
);

const SOURCE_KEY = "us-scotus";
const VERSION_SOURCE_KEY = "fr-conseil-constitutionnel";
const SENSITIVE_MARKER = "SENSITIVE-MARKER-9f3a";
const RAW_TEXT = `헌법 §42 raw ${SENSITIVE_MARKER}\n text`;

const ARTICLE_ROW_ID_1 = "00000001-0000-4000-8000-000000000001";
const ARTICLE_ROW_ID_2 = "00000001-0000-4000-8000-000000000002";
const ARTICLE_ROW_ID_3 = "00000001-0000-4000-8000-000000000003";
const VERSION_ROW_ID_1 = "00000002-0000-4000-8000-000000000001";

const READ_ON = { [ARTICLE_RAW_BLOB_READ_ENABLED]: "true" };
const BOTH_ON = {
  [ARTICLE_RAW_BLOB_READ_ENABLED]: "true",
  [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true",
};

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
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, _options: ArtifactBlobPutOptions) {
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    const stored = this.getBytesOverride ? this.getBytesOverride(pathname) : this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    this.heads.push(pathname);
    const stored = this.objects.get(pathname);
    if (!stored) return { pathname: `${pathname}.missing`, size: 0 };
    return { pathname, size: stored.byteLength + this.headSizeAdjust };
  }
}

interface AggregateCall {
  articleTable: ArticleRawReadinessTable;
  sourceKey: string | null;
}

class FakeAggregateReadinessRepository {
  readonly calls: AggregateCall[] = [];
  readonly byTable: Record<ArticleRawReadinessTable, ArticleRawReadinessAggregate>;
  readonly failTables = new Set<ArticleRawReadinessTable>();

  constructor(byTable: Partial<Record<ArticleRawReadinessTable, ArticleRawReadinessAggregate>> = {}) {
    this.byTable = {
      articles: aggregate(),
      article_content_versions_p3: aggregate(),
      ...byTable,
    };
  }

  async readArticleRawReadiness(input: {
    articleTable: ArticleRawReadinessTable;
    sourceKey?: string | null;
  }): Promise<ArticleRawReadinessAggregate> {
    this.calls.push({ articleTable: input.articleTable, sourceKey: input.sourceKey ?? null });
    if (this.failTables.has(input.articleTable)) throw new Error("article_raw_readiness.test_failure");
    return this.byTable[input.articleTable];
  }
}

interface CandidateCall {
  articleTable: ArticleRawReadinessTable;
  sourceKey: string | null;
  limit: number;
  afterArticleRowId: string | null;
}

class FakeCandidateRepository {
  readonly calls: CandidateCall[] = [];

  constructor(private readonly candidates: ArticleRawExternalizationCandidate[]) {}

  async listArticleRawExternalizationCandidates(input: {
    articleTable: ArticleRawReadinessTable;
    sourceKey?: string | null;
    limit: number;
    afterArticleRowId?: string | null;
  }): Promise<ArticleRawExternalizationCandidate[]> {
    this.calls.push({
      articleTable: input.articleTable,
      sourceKey: input.sourceKey ?? null,
      limit: input.limit,
      afterArticleRowId: input.afterArticleRowId ?? null,
    });
    return this.candidates
      .filter((candidate) => candidate.articleTable === input.articleTable)
      .filter((candidate) => (input.sourceKey ? candidate.sourceKey === input.sourceKey : true))
      .filter((candidate) =>
        input.afterArticleRowId ? candidate.articleRowId > input.afterArticleRowId : true,
      )
      .sort((left, right) =>
        left.articleRowId < right.articleRowId ? -1 : left.articleRowId > right.articleRowId ? 1 : 0,
      )
      .slice(0, input.limit);
  }
}

class FakeAggregateRpcClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  data: Record<string, unknown>[] | null = [];
  rpcError: unknown = null;

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    return { data: this.data, error: null };
  }
}

function aggregate(overrides: Partial<ArticleRawReadinessAggregate> = {}): ArticleRawReadinessAggregate {
  return {
    totalRows: 0,
    inlinePresent: 0,
    inlineMissing: 0,
    metadataAbsent: 0,
    metadataComplete: 0,
    metadataInconsistent: 0,
    dualCopy: 0,
    blobOnly: 0,
    inlineOnly: 0,
    exactLedgerCovered: 0,
    ledgerMissingOrConflicting: 0,
    clearableRows: 0,
    inlineBlobBytesEstimated: 0,
    ...overrides,
  };
}

function externalizationCandidate(
  rawText: string,
  overrides: Partial<ArticleRawExternalizationCandidate> = {},
): ArticleRawExternalizationCandidate {
  const sourceKey = overrides.sourceKey ?? SOURCE_KEY;
  const encoded = encodeArticleRawText(rawText);
  return {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID_1,
    articleId: ARTICLE_ROW_ID_1,
    sourceKey,
    rawText,
    rawTextStorageRef: articleRawBlobStorageRef(sourceKey, encoded.sha256),
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: "2026-09-19T00:00:00.000Z",
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

function seedText(transport: FakeTransport, storageRef: string, rawText: string) {
  transport.objects.set(storageRef, encodeArticleRawText(rawText).bytes);
}

function dependencies(
  repository: FakeAggregateReadinessRepository,
  candidates: FakeCandidateRepository = new FakeCandidateRepository([]),
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = {},
): ArticleRawReadinessDependencies & { transport: FakeTransport; candidates: FakeCandidateRepository } {
  return {
    repository,
    candidates,
    store: new ArtifactBlobStore(transport),
    transport,
    environment,
  };
}

// --- aggregate-only default run ---------------------------------------------

test("default aggregate run reports counts and never touches per-row or Blob reads", async () => {
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 10,
      inlinePresent: 8,
      inlineMissing: 2,
      metadataAbsent: 3,
      metadataComplete: 5,
      metadataInconsistent: 2,
      dualCopy: 4,
      blobOnly: 1,
      inlineOnly: 1,
      exactLedgerCovered: 4,
      ledgerMissingOrConflicting: 1,
      clearableRows: 4,
      inlineBlobBytesEstimated: 2048,
    }),
    article_content_versions_p3: aggregate({
      totalRows: 3,
      inlinePresent: 3,
      metadataAbsent: 3,
      ledgerMissingOrConflicting: 0,
    }),
  });
  const candidates = new FakeCandidateRepository([]);
  const deps = dependencies(repository, candidates);

  const report = await runArticleRawReadiness({ batchSize: 25, maxBatches: 10 }, deps);

  assert.equal(report.event, "article_raw_readiness");
  assert.equal(report.readOnly, true);
  assert.equal(report.machineReadable, true);
  assert.deepEqual(report.tables, ["articles", "article_content_versions_p3"]);
  assert.deepEqual(repository.calls, [
    { articleTable: "articles", sourceKey: null },
    { articleTable: "article_content_versions_p3", sourceKey: null },
  ]);
  assert.equal(candidates.calls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);

  assert.equal(report.articles.totalRows, 10);
  assert.equal(report.articles.dualCopyRows, 4);
  assert.equal(report.articles.blobOnlyRows, 1);
  assert.equal(report.articles.externalizedRows, 5);
  assert.equal(report.articles.clearableRows, 4);
  assert.equal(report.articles.inlineBytesEstimated, 2048);
  assert.equal(report.article_content_versions_p3.totalRows, 3);
  assert.equal(report.combined.totalRows, 13);
  assert.equal(report.combined.externalizedRows, 5);
  assert.equal(report.combined.metadataInconsistentRows, 2);
  assert.equal(report.articles.ledgerMissingOrConflictingRows, 1);
  assert.equal(report.article_content_versions_p3.ledgerMissingOrConflictingRows, 0);
  assert.equal(report.combined.ledgerMissingOrConflictingRows, 1);

  assert.equal(report.verification.requested, false);
  assert.equal(report.verification.sampled, 0);
  assert.equal(report.gates.readEnabled, false);
  assert.equal(report.gates.externalizationReady, false);
  assert.equal(report.gates.newWriteReady, false);
  assert.equal(report.writeFlagsDefaultOff, true);
  assert.equal(report.inlineRestore, ARTICLE_RAW_READINESS_INLINE_RESTORE);
  assert.equal(report.storageRefsEmitted, 0);
  assert.equal(report.perRowPayloadsEmitted, 0);
  assert.equal(report.blobObjectsDeleted, 0);
});

test("a default run needs neither a candidate repository nor a Blob store", async () => {
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({ totalRows: 1, inlinePresent: 1, metadataAbsent: 1, ledgerMissingOrConflicting: 1 }),
  });
  const report = await runArticleRawReadiness({ batchSize: 10, maxBatches: 10 }, { repository });
  assert.equal(report.articles.totalRows, 1);
  assert.equal(report.verification.requested, false);
});

test("an aggregate RPC failure fails readiness closed instead of reading per-row", async () => {
  const repository = new FakeAggregateReadinessRepository({ articles: aggregate({ totalRows: 5 }) });
  repository.failTables.add("articles");
  const candidates = new FakeCandidateRepository([]);
  const deps = dependencies(repository, candidates, new FakeTransport(), BOTH_ON);

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10 },
    deps,
  );

  assert.equal(report.gates.aggregateComplete, false);
  assert.deepEqual(report.gates.aggregateFailures, ["articles"]);
  assert.equal(report.gates.externalizationReady, false);
  assert.equal(report.gates.newWriteReady, false);
  assert.ok(report.gates.blocking.includes("aggregate_read_failed"));
  assert.equal(candidates.calls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
});

test("a single selected table is aggregated alone", async () => {
  const repository = new FakeAggregateReadinessRepository({
    article_content_versions_p3: aggregate({
      totalRows: 4,
      inlinePresent: 4,
      metadataAbsent: 4,
      ledgerMissingOrConflicting: 4,
    }),
  });
  const report = await runArticleRawReadiness(
    { tables: ["article_content_versions_p3"], batchSize: 10, maxBatches: 10 },
    dependencies(repository),
  );
  assert.deepEqual(report.tables, ["article_content_versions_p3"]);
  assert.deepEqual(repository.calls, [{ articleTable: "article_content_versions_p3", sourceKey: null }]);
  assert.equal(report.article_content_versions_p3.totalRows, 4);
  assert.equal(report.articles.totalRows, 0);
});

// --- gates ------------------------------------------------------------------

test("EXTERNALIZATION_READY needs the read flag; APPLICATION_WRITE_READY adds write", async () => {
  const repository = () =>
    new FakeAggregateReadinessRepository({
      articles: aggregate({ totalRows: 2, inlinePresent: 2, metadataAbsent: 2, ledgerMissingOrConflicting: 2 }),
    });

  const flagsOff = await runArticleRawReadiness({ batchSize: 10, maxBatches: 10 }, dependencies(repository()));
  assert.equal(flagsOff.gates.externalizationReady, false);
  assert.ok(flagsOff.gates.blocking.includes("read_flag_disabled"));
  assert.ok(flagsOff.gates.blocking.includes("write_flag_disabled"));

  const readOnly = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(repository(), new FakeCandidateRepository([]), new FakeTransport(), READ_ON),
  );
  assert.equal(readOnly.gates.externalizationReady, true);
  assert.equal(readOnly.gates.applicationWriteReady, false);
  assert.equal(readOnly.gates.newWriteReady, false);
  assert.ok(readOnly.gates.blocking.includes("write_flag_disabled"));

  const writeWithoutRead = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(repository(), new FakeCandidateRepository([]), new FakeTransport(), {
      [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true",
    }),
  );
  assert.equal(writeWithoutRead.gates.writeWithoutRead, true);
  assert.equal(writeWithoutRead.gates.externalizationReady, false);
  assert.equal(writeWithoutRead.gates.flagErrors.length, 1);

  const bothOn = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(repository(), new FakeCandidateRepository([]), new FakeTransport(), BOTH_ON),
  );
  assert.equal(bothOn.gates.externalizationReady, true);
  assert.equal(bothOn.gates.applicationWriteReady, true);
  assert.equal(bothOn.gates.newWriteReady, bothOn.gates.applicationWriteReady);
  assert.equal(bothOn.gates.metadataCritical, false);
  assert.equal(bothOn.gates.critical, false);
  assert.equal(bothOn.gates.inlineClearReady, false);
  assert.ok(bothOn.gates.blocking.includes("verification_not_requested"));
});

test("metadata inconsistency blocks EXTERNALIZATION_READY and is critical", async () => {
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 1,
      inlinePresent: 1,
      metadataInconsistent: 1,
      ledgerMissingOrConflicting: 1,
    }),
  });
  const report = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(repository, new FakeCandidateRepository([]), new FakeTransport(), BOTH_ON),
  );
  assert.equal(report.gates.metadataCritical, true);
  assert.equal(report.gates.externalizationReady, false);
  assert.equal(report.gates.applicationWriteReady, false);
  assert.equal(report.gates.newWriteReady, false);
  assert.equal(report.gates.critical, true);
  assert.ok(report.gates.blocking.includes("metadata_inconsistent_rows"));
});

test("ledger coverage of every externalized row is required for inline clear", async () => {
  const clearable = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 2,
      inlinePresent: 2,
      metadataComplete: 2,
      dualCopy: 2,
      exactLedgerCovered: 1,
      ledgerMissingOrConflicting: 1,
      clearableRows: 1,
    }),
  });
  const transport = new FakeTransport();
  seedText(transport, clearable.rawTextStorageRef as string, RAW_TEXT);
  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
    dependencies(repository, new FakeCandidateRepository([clearable]), transport, BOTH_ON),
  );
  assert.equal(report.combined.externalizedRows, 2);
  assert.equal(report.combined.ledgerCoveredRows, 1);
  assert.equal(report.gates.ledgerCoverageReady, false);
  assert.equal(report.gates.verificationReady, true);
  assert.equal(report.gates.inlineClearReady, false);
  assert.ok(report.gates.blocking.includes("ledger_coverage_incomplete"));
  assert.equal(report.gates.critical, false);
});

test("inline-only metadata-absent rows never count as a ledger gap", async () => {
  // Two inline-only rows with no externalization metadata at all: they must not be
  // reported as ledger-missing. The one metadata-complete row is exactly covered.
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 3,
      inlinePresent: 3,
      metadataAbsent: 2,
      metadataComplete: 1,
      dualCopy: 1,
      inlineOnly: 2,
      exactLedgerCovered: 1,
      ledgerMissingOrConflicting: 0,
      clearableRows: 1,
    }),
  });
  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10 },
    dependencies(repository, new FakeCandidateRepository([]), new FakeTransport(), READ_ON),
  );
  assert.equal(report.articles.metadataAbsentRows, 2);
  assert.equal(report.articles.ledgerMissingOrConflictingRows, 0);
  assert.equal(report.combined.ledgerMissingOrConflictingRows, 0);
  assert.equal(report.gates.ledgerCoverageReady, true);
  assert.equal(report.gates.blocking.includes("ledger_coverage_incomplete"), false);
});

test("a metadata-complete row missing its exact ledger entry is the only ledger gap", async () => {
  // Same two inline-only metadata-absent rows, but now the single metadata-complete
  // row lacks its exact ledger match: only that complete row counts as missing.
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 3,
      inlinePresent: 3,
      metadataAbsent: 2,
      metadataComplete: 1,
      dualCopy: 1,
      inlineOnly: 2,
      exactLedgerCovered: 0,
      ledgerMissingOrConflicting: 1,
      clearableRows: 0,
    }),
  });
  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10 },
    dependencies(repository, new FakeCandidateRepository([]), new FakeTransport(), READ_ON),
  );
  assert.equal(report.articles.metadataAbsentRows, 2);
  assert.equal(report.articles.ledgerMissingOrConflictingRows, 1);
  assert.equal(report.combined.ledgerMissingOrConflictingRows, 1);
  assert.equal(report.gates.ledgerCoverageReady, false);
  assert.ok(report.gates.blocking.includes("ledger_coverage_incomplete"));
});

// --- verification -----------------------------------------------------------

const CLEARABLE_ARTICLES = aggregate({
  totalRows: 1,
  inlinePresent: 1,
  metadataComplete: 1,
  dualCopy: 1,
  exactLedgerCovered: 1,
  clearableRows: 1,
});
const CLEARABLE_VERSIONS = aggregate({
  totalRows: 1,
  inlinePresent: 1,
  metadataComplete: 1,
  dualCopy: 1,
  exactLedgerCovered: 1,
  clearableRows: 1,
});

test("verification head/get/size/SHA/decode/text-verifies coherent dual-copy candidates", async () => {
  const articleCandidate = externalizationCandidate(RAW_TEXT);
  const versionCandidate = externalizationCandidate(RAW_TEXT, {
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID_1,
    articleId: "00000003-0000-4000-8000-000000000003",
    sourceKey: VERSION_SOURCE_KEY,
  });
  const repository = new FakeAggregateReadinessRepository({
    articles: CLEARABLE_ARTICLES,
    article_content_versions_p3: CLEARABLE_VERSIONS,
  });
  const transport = new FakeTransport();
  seedText(transport, articleCandidate.rawTextStorageRef as string, RAW_TEXT);
  seedText(transport, versionCandidate.rawTextStorageRef as string, RAW_TEXT);
  const deps = dependencies(
    repository,
    new FakeCandidateRepository([articleCandidate, versionCandidate]),
    transport,
    BOTH_ON,
  );

  const report = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 2 },
    deps,
  );

  assert.equal(report.verification.requested, true);
  assert.equal(report.verification.sampleSize, 2);
  assert.equal(report.verification.candidatesConsidered, 2);
  assert.equal(report.verification.sampled, 2);
  assert.equal(report.verification.verifiedOk, 2);
  assert.equal(report.verification.readErrors, 0);
  assert.equal(report.verification.sizeMismatches, 0);
  assert.equal(report.verification.hashMismatches, 0);
  assert.equal(report.verification.invalidDocuments, 0);
  assert.equal(report.verification.textMismatches, 0);
  assert.equal(report.verification.sampledByTable.articles, 1);
  assert.equal(report.verification.sampledByTable.article_content_versions_p3, 1);
  assert.equal(report.gates.verificationTableCoverageReady, true);
  assert.equal(report.gates.verificationReady, true);
  assert.equal(report.gates.ledgerCoverageReady, true);
  assert.equal(report.gates.inlineClearReady, true);
  assert.equal(report.gates.critical, false);
  assert.equal(transport.heads.length, 2);
  assert.equal(transport.gets.length, 2);
});

test("verification ignores candidates that are not coherent metadata-complete dual copies", async () => {
  const good = externalizationCandidate(RAW_TEXT);
  const noRef = externalizationCandidate(RAW_TEXT, {
    articleRowId: ARTICLE_ROW_ID_2,
    rawTextStorageRef: null,
  });
  const badContract = externalizationCandidate(RAW_TEXT, {
    articleRowId: ARTICLE_ROW_ID_3,
    rawTextBlobContractVersion: "worldcons-article-raw-blob-v2",
  });
  const repository = new FakeAggregateReadinessRepository({
    articles: aggregate({
      totalRows: 3,
      inlinePresent: 3,
      metadataComplete: 3,
      dualCopy: 3,
      exactLedgerCovered: 3,
      clearableRows: 3,
    }),
  });
  const transport = new FakeTransport();
  seedText(transport, good.rawTextStorageRef as string, RAW_TEXT);
  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([good, noRef, badContract]), transport, BOTH_ON),
  );

  assert.equal(report.verification.candidatesConsidered, 1);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.verification.verifiedOk, 1);
  assert.equal(transport.heads.length, 1);
});

test("candidate paging honors batchSize and maxBatches bounds", async () => {
  const first = externalizationCandidate(`${RAW_TEXT}-one`, { articleRowId: ARTICLE_ROW_ID_1 });
  const second = externalizationCandidate(`${RAW_TEXT}-two`, { articleRowId: ARTICLE_ROW_ID_2 });
  const third = externalizationCandidate(`${RAW_TEXT}-three`, { articleRowId: ARTICLE_ROW_ID_3 });
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const candidates = new FakeCandidateRepository([first, second, third]);
  const transport = new FakeTransport();
  for (const item of [first, second, third]) {
    seedText(transport, item.rawTextStorageRef as string, item.rawText);
  }

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 1, maxBatches: 2, verificationSampleSize: 3 },
    dependencies(repository, candidates, transport, BOTH_ON),
  );

  assert.equal(candidates.calls.length, 2);
  assert.deepEqual(candidates.calls.map((call) => call.limit), [1, 1]);
  assert.equal(candidates.calls[0].afterArticleRowId, null);
  assert.equal(candidates.calls[1].afterArticleRowId, first.articleRowId);
  assert.equal(report.verification.candidatesConsidered, 2);
  assert.equal(report.verification.sampled, 2);
});

test("a small cap attempts one candidate per clearable table before filling slots", async () => {
  const articleCandidate = externalizationCandidate(RAW_TEXT);
  const versionCandidate = externalizationCandidate(RAW_TEXT, {
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID_1,
    sourceKey: VERSION_SOURCE_KEY,
  });
  const repository = new FakeAggregateReadinessRepository({
    articles: CLEARABLE_ARTICLES,
    article_content_versions_p3: CLEARABLE_VERSIONS,
  });
  const transport = new FakeTransport();
  seedText(transport, articleCandidate.rawTextStorageRef as string, RAW_TEXT);
  seedText(transport, versionCandidate.rawTextStorageRef as string, RAW_TEXT);
  const candidates = new FakeCandidateRepository([articleCandidate, versionCandidate]);

  const report = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 2 },
    dependencies(repository, candidates, transport, BOTH_ON),
  );
  assert.equal(report.verification.sampled, 2);
  assert.equal(report.verification.sampledByTable.articles, 1);
  assert.equal(report.verification.sampledByTable.article_content_versions_p3, 1);
  assert.equal(report.gates.inlineClearReady, true);
});

test("a cap too small to reach a clearable table stays unsampled and blocks inline clear", async () => {
  const articleCandidate = externalizationCandidate(RAW_TEXT);
  const versionCandidate = externalizationCandidate(RAW_TEXT, {
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID_1,
    sourceKey: VERSION_SOURCE_KEY,
  });
  const repository = new FakeAggregateReadinessRepository({
    articles: CLEARABLE_ARTICLES,
    article_content_versions_p3: CLEARABLE_VERSIONS,
  });
  const transport = new FakeTransport();
  seedText(transport, articleCandidate.rawTextStorageRef as string, RAW_TEXT);
  seedText(transport, versionCandidate.rawTextStorageRef as string, RAW_TEXT);

  const report = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
    dependencies(repository, new FakeCandidateRepository([articleCandidate, versionCandidate]), transport, BOTH_ON),
  );

  assert.equal(report.verification.sampled, 1);
  assert.equal(report.verification.sampledByTable.articles, 1);
  assert.equal(report.verification.sampledByTable.article_content_versions_p3, 0);
  assert.equal(report.gates.verificationTableCoverageReady, false);
  assert.equal(report.gates.inlineClearReady, false);
  assert.equal(report.gates.critical, false);
  assert.ok(report.gates.blocking.includes("verification_clearable_table_unsampled_article_content_versions_p3"));
  assert.equal(report.gates.blocking.includes("verification_clearable_table_unsampled_articles"), false);
});

test("a clearable table with no coherent candidate is explicitly unsampled", async () => {
  const articleCandidate = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({
    articles: CLEARABLE_ARTICLES,
    article_content_versions_p3: CLEARABLE_VERSIONS,
  });
  const transport = new FakeTransport();
  seedText(transport, articleCandidate.rawTextStorageRef as string, RAW_TEXT);

  const report = await runArticleRawReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([articleCandidate]), transport, BOTH_ON),
  );

  assert.equal(report.verification.sampledByTable.article_content_versions_p3, 0);
  assert.equal(report.gates.verificationTableCoverageReady, false);
  assert.ok(report.gates.blocking.includes("verification_clearable_table_unsampled_article_content_versions_p3"));
  assert.equal(report.gates.inlineClearReady, false);
});

test("a single selected table only requires its own verified sample", async () => {
  const versionCandidate = externalizationCandidate(RAW_TEXT, {
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID_1,
    sourceKey: VERSION_SOURCE_KEY,
  });
  const repository = new FakeAggregateReadinessRepository({
    articles: CLEARABLE_ARTICLES,
    article_content_versions_p3: CLEARABLE_VERSIONS,
  });
  const transport = new FakeTransport();
  seedText(transport, versionCandidate.rawTextStorageRef as string, RAW_TEXT);

  const report = await runArticleRawReadiness(
    {
      tables: ["article_content_versions_p3"],
      batchSize: 10,
      maxBatches: 10,
      verificationSampleSize: 5,
    },
    dependencies(repository, new FakeCandidateRepository([versionCandidate]), transport, BOTH_ON),
  );

  assert.equal(report.articles.totalRows, 0);
  assert.equal(report.verification.sampledByTable.articles, 0);
  assert.equal(report.verification.sampledByTable.article_content_versions_p3, 1);
  assert.equal(report.gates.verificationTableCoverageReady, true);
  assert.equal(report.gates.inlineClearReady, true);
  assert.equal(report.gates.critical, false);
});

// --- verification failures --------------------------------------------------

test("a decoded text that disagrees with the inline rawText is critical", async () => {
  const storedText = `${RAW_TEXT}stored-different`;
  const encoded = encodeArticleRawText(storedText);
  const row = externalizationCandidate(RAW_TEXT, {
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
  });
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const transport = new FakeTransport();
  seedText(transport, row.rawTextStorageRef as string, storedText);

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), transport, BOTH_ON),
  );

  assert.equal(report.verification.textMismatches, 1);
  assert.equal(report.verification.verifiedOk, 0);
  assert.equal(report.gates.critical, true);
  assert.equal(report.gates.inlineClearReady, false);
  assert.ok(report.gates.blocking.includes("blob_text_mismatches"));
});

test("a sampled hash mismatch is critical", async () => {
  const row = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const transport = new FakeTransport();
  seedText(transport, row.rawTextStorageRef as string, RAW_TEXT);
  transport.getBytesOverride = () => Buffer.alloc(row.rawTextBlobSize as number, 0x61);

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), transport, BOTH_ON),
  );

  assert.equal(report.verification.sizeMismatches, 0);
  assert.equal(report.verification.hashMismatches, 1);
  assert.equal(report.verification.verifiedOk, 0);
  assert.equal(report.gates.critical, true);
  assert.equal(report.gates.inlineClearReady, false);
  assert.ok(report.gates.blocking.includes("blob_hash_mismatches"));
});

test("a sampled size mismatch is critical", async () => {
  const row = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const transport = new FakeTransport();
  seedText(transport, row.rawTextStorageRef as string, RAW_TEXT);
  transport.headSizeAdjust = 1;

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), transport, BOTH_ON),
  );

  assert.equal(report.verification.sizeMismatches, 1);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.gates.critical, true);
  assert.ok(report.gates.blocking.includes("blob_size_mismatches"));
});

test("an invalid sampled document is critical", async () => {
  const bytes = Buffer.from("not-json{", "utf8");
  const hash = sha256Hex(bytes);
  const row = externalizationCandidate(RAW_TEXT, {
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, hash),
    rawTextBlobHash: hash,
    rawTextBlobSize: bytes.byteLength,
  });
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const transport = new FakeTransport();
  transport.objects.set(row.rawTextStorageRef as string, bytes);

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), transport, BOTH_ON),
  );

  assert.equal(report.verification.hashMismatches, 0);
  assert.equal(report.verification.invalidDocuments, 1);
  assert.equal(report.gates.critical, true);
  assert.ok(report.gates.blocking.includes("blob_invalid_documents"));
});

test("a Blob read error makes the verification gate not-ready but is not critical", async () => {
  const row = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), new FakeTransport(), BOTH_ON),
  );

  assert.equal(report.verification.readErrors, 1);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.gates.verificationReady, false);
  assert.equal(report.gates.inlineClearReady, false);
  assert.equal(report.gates.critical, false);
  assert.ok(report.gates.blocking.includes("blob_read_errors"));
});

// --- redaction & bounds -----------------------------------------------------

test("the readiness report never emits refs, hashes, raw content, or per-row payloads", async () => {
  const row = externalizationCandidate(RAW_TEXT);
  const repository = new FakeAggregateReadinessRepository({ articles: CLEARABLE_ARTICLES });
  const transport = new FakeTransport();
  seedText(transport, row.rawTextStorageRef as string, RAW_TEXT);

  const report = await runArticleRawReadiness(
    { tables: ["articles"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    dependencies(repository, new FakeCandidateRepository([row]), transport, BOTH_ON),
  );
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(row.rawTextStorageRef as string), false);
  assert.equal(serialized.includes("artifacts/"), false);
  assert.equal(serialized.includes(row.rawTextBlobHash as string), false);
  assert.equal(serialized.includes(RAW_TEXT), false);
  assert.equal(serialized.includes(SENSITIVE_MARKER), false);
  assert.equal(/https?:\/\//.test(serialized), false);
  assert.equal(/(token|secret|signature|credential)/i.test(serialized), false);
  assert.equal("storageRef" in report, false);
  assert.equal("storageRefs" in report, false);
  assert.equal("outcomes" in report, false);
});

test("invalid bounds and a missing verification dependency fail closed", async () => {
  const repository = new FakeAggregateReadinessRepository();

  await assert.rejects(
    () => runArticleRawReadiness({ batchSize: 0, maxBatches: 10 }, dependencies(repository)),
    /article_raw_readiness\.invalid_batch_size/,
  );
  await assert.rejects(
    () => runArticleRawReadiness({ batchSize: 101, maxBatches: 10 }, dependencies(repository)),
    /article_raw_readiness\.invalid_batch_size/,
  );
  await assert.rejects(
    () => runArticleRawReadiness({ batchSize: 10, maxBatches: 0 }, dependencies(repository)),
    /article_raw_readiness\.invalid_max_batches/,
  );
  await assert.rejects(
    () => runArticleRawReadiness({ batchSize: 10, maxBatches: 10, verificationSampleSize: 101 }, dependencies(repository)),
    /article_raw_readiness\.invalid_verification_sample_size/,
  );
  await assert.rejects(
    () => runArticleRawReadiness({ tables: ["bogus" as never], batchSize: 10, maxBatches: 10 }, dependencies(repository)),
    /article_raw_readiness\.invalid_table/,
  );
  await assert.rejects(
    () => runArticleRawReadiness(
      { batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
      { repository, store: new ArtifactBlobStore(new FakeTransport()), candidates: null },
    ),
    /article_raw_readiness\.candidates_required/,
  );
  await assert.rejects(
    () => runArticleRawReadiness(
      { batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
      { repository, candidates: new FakeCandidateRepository([]), store: null },
    ),
    /article_raw_readiness\.store_required/,
  );
});

// --- static contracts --------------------------------------------------------

test("the CLI is aggregate-only, uses the M6D-A candidate path, and takes no write flags", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /runArticleRawReadiness\(/);
  assert.match(source, /integerArgument\("verify-sample", 0, 0, 100\)/);
  assert.match(source, /verificationSampleSize > 0 \? createArtifactBlobStore\(\) : null/);
  assert.match(source, /article_raw_blob_read_not_ready/);
  assert.match(source, /require-externalization-ready/);
  assert.match(source, /require-application-write-ready/);
  assert.match(source, /require-new-write-ready/);
  assert.match(source, /require-inline-clear-ready/);
  assert.match(source, /versions: \["article_content_versions_p3"\]/);
  assert.match(source, /all: \["articles", "article_content_versions_p3"\]/);
  assert.match(source, /postgresArticleRawExternalizationRepository/);
  // The READ flag is checked before the Blob store is constructed.
  assert.ok(
    source.indexOf("article_raw_blob_read_not_ready") < source.indexOf("createArtifactBlobStore()"),
    "verify must require READ before any Blob store is created",
  );
  assert.doesNotMatch(source, /flag\("execute"\)/);
  assert.doesNotMatch(source, /acknowledge-inline-clear/);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.doesNotMatch(source, /externalizeArticleRaw|clearArticleRawInline|attachArticleRawExternalization/);
  assert.doesNotMatch(source, /console\.log/);
});

test("the module is aggregate-only, verifies coherent dual-copy candidates, and derives the gates", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  assert.match(source, /readArticleRawReadiness/);
  assert.match(source, /listArticleRawExternalizationCandidates/);
  assert.match(source, /verificationSampleSize \?\? 0/);
  assert.match(source, /sha256Hex\(bytes\)/);
  assert.match(source, /await store\.head\(/);
  assert.match(source, /await store\.get\(/);
  assert.match(source, /decodeArticleRawText\(bytes\)/);
  assert.match(source, /decoded !== candidate\.rawText/);
  assert.match(source, /externalizationReady = readFlagReady && aggregateComplete && !metadataCritical/);
  assert.match(source, /applicationWriteReady = externalizationReady && writeFlagReady/);
  assert.match(source, /const newWriteReady = applicationWriteReady/);
  assert.match(source, /inlineClearReady = applicationWriteReady && ledgerCoverageReady && verificationReady/);
  assert.match(source, /const ledgerCoverageReady = combined\.ledgerMissingOrConflictingRows === 0/);
  assert.match(source, /verificationTableCoverageReady = uncoveredClearableTables\.length === 0/);
  assert.match(source, /verification_clearable_table_unsampled_\$\{table\}/);
  assert.match(source, /ARTICLE_RAW_READINESS_INLINE_RESTORE = "requires_separate_restore_design"/);
  assert.match(source, /storageRefsEmitted: 0/);
  assert.equal(source.includes(".from("), false);
  assert.equal(source.includes(".select("), false);
  assert.equal(source.includes("attachArticleRawExternalization"), false);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.doesNotMatch(source, /console\.log/);
});

test("the repository reads the aggregate-only readiness function without pagination", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /article_raw_readiness_v1/);
  assert.match(source, /readArticleRawReadiness/);
  assert.match(source, /rpc\(ARTICLE_RAW_READINESS_RPC/);
  assert.match(source, /p_article_table: input\.articleTable/);
  assert.match(source, /p_source_key: input\.sourceKey \?\? null/);
  assert.equal(source.includes("p_limit"), false);
  assert.equal(source.includes("p_after_row_id"), false);
  assert.equal(source.includes("storage_ref"), false);
  assert.equal(source.includes("stored_hash"), false);
  assert.equal(source.includes("blob_hash"), false);
  assert.equal(source.includes("blob_size"), false);
  assert.equal(source.includes(".from("), false);
  assert.equal(source.includes(".select("), false);
});

test("the aggregate readiness RPC call is exact and the row mapping fails closed", async () => {
  const client = new FakeAggregateRpcClient();
  client.data = [{
    total_rows: "12",
    inline_present: 5,
    inline_missing: 7,
    metadata_absent: 3,
    metadata_complete: 8,
    metadata_inconsistent: 1,
    dual_copy: 4,
    blob_only: 4,
    inline_only: 3,
    exact_ledger_covered: 8,
    ledger_missing_or_conflicting: 4,
    clearable_rows: 4,
    inline_blob_bytes_estimated: "2048",
  }];
  const repository = createPostgresArticleRawReadinessRepository({
    client: () => client as unknown as SupabaseClient,
  });

  const aggregateRow = await repository.readArticleRawReadiness({
    articleTable: "article_content_versions_p3",
    sourceKey: SOURCE_KEY,
  });
  assert.deepEqual(aggregateRow, {
    totalRows: 12,
    inlinePresent: 5,
    inlineMissing: 7,
    metadataAbsent: 3,
    metadataComplete: 8,
    metadataInconsistent: 1,
    dualCopy: 4,
    blobOnly: 4,
    inlineOnly: 3,
    exactLedgerCovered: 8,
    ledgerMissingOrConflicting: 4,
    clearableRows: 4,
    inlineBlobBytesEstimated: 2048,
  });
  assert.deepEqual(client.rpcCalls, [{
    name: ARTICLE_RAW_READINESS_RPC,
    args: {
      p_article_table: "article_content_versions_p3",
      p_source_key: SOURCE_KEY,
    },
  }]);

  const missing = new FakeAggregateRpcClient();
  missing.data = [];
  const missingRepository = createPostgresArticleRawReadinessRepository({
    client: () => missing as unknown as SupabaseClient,
  });
  await assert.rejects(
    () => missingRepository.readArticleRawReadiness({ articleTable: "articles" }),
    /article_raw_readiness\.aggregate_unexpected/,
  );
  assert.deepEqual(missing.rpcCalls[0].args, { p_article_table: "articles", p_source_key: null });

  const failed = new FakeAggregateRpcClient();
  failed.rpcError = { message: "boom" };
  const failedRepository = createPostgresArticleRawReadinessRepository({
    client: () => failed as unknown as SupabaseClient,
  });
  await assert.rejects(
    () => failedRepository.readArticleRawReadiness({ articleTable: "articles" }),
    /boom/,
  );
});

test("the readiness migration exposes one aggregate-only readiness function", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /create or replace function article_raw_readiness_v1\(/);
  assert.match(sql, /p_article_table text/);
  assert.match(sql, /p_source_key text default null/);
  assert.match(sql, /returns table/);
  for (const column of [
    "total_rows",
    "inline_present",
    "inline_missing",
    "metadata_absent",
    "metadata_complete",
    "metadata_inconsistent",
    "dual_copy",
    "blob_only",
    "inline_only",
    "exact_ledger_covered",
    "ledger_missing_or_conflicting",
    "clearable_rows",
    "inline_blob_bytes_estimated",
  ]) {
    assert.match(sql, new RegExp(`\\b${column} bigint`));
  }
  assert.match(sql, /\bstable\b/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, pg_temp/);
  assert.match(sql, /drop function if exists article_raw_readiness_rows_v1\(text, text, integer, uuid\)/);
  assert.doesNotMatch(sql, /create or replace function article_raw_readiness_rows_v1/);
  assert.doesNotMatch(sql, /p_limit|p_after_row_id/);
  assert.doesNotMatch(sql, /returns table \(\s*article_table/);
});

test("the readiness migration classifies metadata, ledger, and clearable rows exactly", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  // Exactly the two carriers, each optionally narrowed by an exact source key.
  assert.match(sql, /p_article_table not in \('articles', 'article_content_versions_p3'\)/);
  assert.match(sql, /p_source_key is null or a\.source_key = p_source_key/);
  assert.match(sql, /p_source_key is null or v\.source_key = p_source_key/);

  // metadata_absent: all five M6A columns null.
  assert.match(
    sql,
    /a\.raw_text_storage_ref is null\s+and a\.raw_text_blob_hash is null\s+and a\.raw_text_blob_size is null\s+and a\.raw_text_externalized_at is null\s+and a\.raw_text_blob_contract_version is null/,
  );
  assert.match(
    sql,
    /v\.raw_text_storage_ref is null\s+and v\.raw_text_blob_hash is null\s+and v\.raw_text_blob_size is null\s+and v\.raw_text_externalized_at is null\s+and v\.raw_text_blob_contract_version is null/,
  );

  // metadata_complete: exact contract, 64-hex hash, bounded size, non-null
  // externalized_at, and a content-addressed ref for this row's own source key.
  assert.match(sql, /worldcons-article-raw-blob-v1/);
  assert.match(sql, /raw_text_blob_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /raw_text_blob_size between 0 and 4194304/);
  assert.match(sql, /raw_text_externalized_at is not null/);
  assert.match(
    sql,
    /'artifacts\/article_raw\/' \|\| a\.source_key \|\| '\/' \|\| a\.raw_text_blob_hash \|\| '\.json'/,
  );
  assert.match(
    sql,
    /'artifacts\/article_raw\/' \|\| v\.source_key \|\| '\/' \|\| v\.raw_text_blob_hash \|\| '\.json'/,
  );
  assert.match(sql, /not row_metadata_absent and not row_metadata_complete/);

  // Presence partitions and the trusted dual/blob/inline-only counts.
  assert.match(sql, /not row_inline_present\) as inline_missing/);
  assert.match(sql, /row_inline_present and row_metadata_complete\) as dual_copy/);
  assert.match(sql, /not row_inline_present and row_metadata_complete\) as blob_only/);
  assert.match(sql, /row_inline_present and row_metadata_absent\) as inline_only/);

  // Exact append-only ledger match mirrors the M6C clear gate.
  assert.match(sql, /from article_raw_externalization_ledger l/);
  assert.match(sql, /l\.content_kind = 'raw_text'/);
  assert.match(sql, /l\.article_row_id = a\.id/);
  assert.match(sql, /l\.article_id = a\.id/);
  assert.match(sql, /l\.article_row_id = v\.id/);
  assert.match(sql, /l\.article_id = v\.article_id/);
  assert.match(sql, /l\.storage_ref = a\.raw_text_storage_ref/);
  assert.match(sql, /l\.content_hash = a\.raw_text_blob_hash/);
  assert.match(sql, /l\.content_size is not distinct from a\.raw_text_blob_size/);
  assert.match(sql, /l\.externalization_contract_version = a\.raw_text_blob_contract_version/);
  assert.match(sql, /l\.storage_ref = v\.raw_text_storage_ref/);
  assert.match(sql, /l\.content_hash = v\.raw_text_blob_hash/);
  assert.match(sql, /l\.content_size is not distinct from v\.raw_text_blob_size/);
  assert.match(sql, /l\.externalization_contract_version = v\.raw_text_blob_contract_version/);
  // exact_ledger_covered stays the plain exact-match count.
  assert.match(sql, /count\(\*\) filter \(where row_exact_ledger_covered\) as exact_ledger_covered/);
  // ledger_missing_or_conflicting counts ONLY metadata-complete rows lacking an exact
  // ledger match (both carriers), so metadata-absent/inconsistent rows never count.
  assert.equal(
    (sql.match(/row_metadata_complete and not row_exact_ledger_covered\)\s+as ledger_missing_or_conflicting/g) ?? [])
      .length,
    2,
  );
  assert.doesNotMatch(sql, /filter \(where not row_exact_ledger_covered\) as ledger_missing_or_conflicting/);

  // clearable = inline + complete + exact ledger.
  assert.match(
    sql,
    /row_inline_present and row_metadata_complete and row_exact_ledger_covered\)\s+as clearable_rows/,
  );

  // inline_blob_bytes_estimated = sum octet_length(to_json(raw_text)::text).
  assert.match(sql, /octet_length\(to_json\(a\.raw_text\)::text\)/);
  assert.match(sql, /octet_length\(to_json\(v\.raw_text\)::text\)/);
  assert.match(sql, /coalesce\(sum\(row_inline_bytes\), 0\)::bigint as inline_blob_bytes_estimated/);

  // Read-only and service_role only: no table grant, no DML, no unbounded read.
  assert.match(sql, /revoke all on function article_raw_readiness_v1\(text, text\) from public/);
  assert.match(sql, /grant execute on function article_raw_readiness_v1\(text, text\) to service_role/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter\s+table|drop\s+table|create\s+table)\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|all)\s+on\s+table/i);
});
