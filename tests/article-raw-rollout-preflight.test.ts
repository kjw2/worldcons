import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArticleRawExternalizationCandidate } from "../lib/article-raw/externalization";
import {
  ARTICLE_RAW_BLOB_READ_ENABLED,
  ARTICLE_RAW_BLOB_WRITE_ENABLED,
} from "../lib/article-raw/flags";
import type { ArticleRawReadinessAggregate } from "../lib/article-raw/readiness-repository";
import type { ArticleRawRestoreCandidate } from "../lib/article-raw/restore";
import {
  ARTICLE_RAW_PREFLIGHT_CLEAR_CANARY_REASON,
  ARTICLE_RAW_PREFLIGHT_MIGRATIONS,
  ARTICLE_RAW_PREFLIGHT_PROBE_ERROR,
  articleRawPreflightErrorCode,
  runArticleRawRolloutPreflight,
  type ArticleRawPreflightTable,
  type ArticleRawRolloutPreflightDependencies,
} from "../lib/article-raw/rollout-preflight";

const modulePath = path.join(process.cwd(), "lib/article-raw/rollout-preflight.ts");
const scriptPath = path.join(process.cwd(), "scripts/article-raw-rollout-preflight.ts");
const realMigrationRoot = path.join(process.cwd(), "supabase", "migrations");

const SOURCE_KEY = "us-scotus";
const SENSITIVE_MARKER = "SENSITIVE-MARKER-9f3a";
const STORAGE_REF = `artifacts/article_raw/${SOURCE_KEY}/${"a".repeat(64)}.json`;
const BLOB_HASH = "a".repeat(64);
const ROW_ID = "00000001-0000-4000-8000-000000000001";

const READ_ON = { [ARTICLE_RAW_BLOB_READ_ENABLED]: "true" };
const BOTH_ON = {
  [ARTICLE_RAW_BLOB_READ_ENABLED]: "true",
  [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true",
};
const WRITE_ONLY = { [ARTICLE_RAW_BLOB_WRITE_ENABLED]: "true" };

function operatorRow(): ArticleRawExternalizationCandidate {
  return {
    articleTable: "articles",
    articleRowId: ROW_ID,
    articleId: ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: SENSITIVE_MARKER,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: BLOB_HASH,
    rawTextBlobSize: 10,
    rawTextExternalizedAt: "2026-09-19T00:00:00.000Z",
    rawTextBlobContractVersion: "worldcons-article-raw-blob-v1",
  };
}

function restoreRow(): ArticleRawRestoreCandidate {
  return {
    articleTable: "articles",
    articleRowId: ROW_ID,
    sourceKey: SOURCE_KEY,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: BLOB_HASH,
    rawTextBlobSize: 10,
    rawTextExternalizedAt: "2026-09-19T00:00:00.000Z",
    rawTextBlobContractVersion: "worldcons-article-raw-blob-v1",
  };
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

interface CandidateCall {
  articleTable: ArticleRawPreflightTable;
  sourceKey: string | null;
  limit: number;
  afterArticleRowId: string | null;
}

class FakeOperatorCandidateRepository {
  readonly calls: CandidateCall[] = [];
  readonly failTables = new Set<ArticleRawPreflightTable>();

  constructor(private readonly rows: ArticleRawExternalizationCandidate[] = [operatorRow()]) {}

  async listArticleRawExternalizationCandidates(input: {
    articleTable: ArticleRawPreflightTable;
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
    if (this.failTables.has(input.articleTable)) {
      throw new Error("article_raw_externalization.database_unavailable");
    }
    return this.rows.filter((row) => row.articleTable === input.articleTable).slice(0, input.limit);
  }
}

class FakeRestoreCandidateRepository {
  readonly calls: CandidateCall[] = [];
  readonly failTables = new Set<ArticleRawPreflightTable>();

  async listArticleRawRestoreCandidates(input: {
    articleTable: ArticleRawPreflightTable;
    sourceKey?: string | null;
    limit: number;
    afterArticleRowId?: string | null;
  }): Promise<ArticleRawRestoreCandidate[]> {
    this.calls.push({
      articleTable: input.articleTable,
      sourceKey: input.sourceKey ?? null,
      limit: input.limit,
      afterArticleRowId: input.afterArticleRowId ?? null,
    });
    if (this.failTables.has(input.articleTable)) {
      throw new Error("article_raw_restore.database_unavailable");
    }
    return input.articleTable === "articles" ? [{ ...restoreRow() }] : [];
  }
}

class FakeAggregateReadinessRepository {
  readonly calls: Array<{ articleTable: ArticleRawPreflightTable; sourceKey: string | null }> = [];
  readonly failTables = new Set<ArticleRawPreflightTable>();

  constructor(
    private readonly byTable: Record<ArticleRawPreflightTable, ArticleRawReadinessAggregate> = {
      articles: aggregate(),
      article_content_versions_p3: aggregate(),
    },
  ) {}

  async readArticleRawReadiness(input: {
    articleTable: ArticleRawPreflightTable;
    sourceKey?: string | null;
  }): Promise<ArticleRawReadinessAggregate> {
    this.calls.push({ articleTable: input.articleTable, sourceKey: input.sourceKey ?? null });
    if (this.failTables.has(input.articleTable)) {
      throw new Error("article_raw_readiness.database_unavailable");
    }
    return this.byTable[input.articleTable];
  }
}

function dependencies(
  overrides: Partial<{
    operator: FakeOperatorCandidateRepository;
    aggregate: FakeAggregateReadinessRepository;
    restore: FakeRestoreCandidateRepository;
    environment: Record<string, string | undefined>;
  }> = {},
): ArticleRawRolloutPreflightDependencies & {
  operator: FakeOperatorCandidateRepository;
  aggregate: FakeAggregateReadinessRepository;
  restore: FakeRestoreCandidateRepository;
} {
  const operator = overrides.operator ?? new FakeOperatorCandidateRepository();
  const aggregateRepository = overrides.aggregate ?? new FakeAggregateReadinessRepository();
  const restore = overrides.restore ?? new FakeRestoreCandidateRepository();
  return {
    operatorCandidates: operator,
    aggregateReadiness: aggregateRepository,
    restoreCandidates: restore,
    environment: overrides.environment ?? {},
    operator,
    aggregate: aggregateRepository,
    restore,
  };
}

// --- probes -----------------------------------------------------------------

test("the preflight probes both tables through the M6D-A, M6D-B, and M6E authorities with limit 1", async () => {
  const deps = dependencies();
  const report = await runArticleRawRolloutPreflight({}, deps);

  assert.deepEqual(deps.operator.calls, [
    { articleTable: "articles", sourceKey: null, limit: 1, afterArticleRowId: null },
    { articleTable: "article_content_versions_p3", sourceKey: null, limit: 1, afterArticleRowId: null },
  ]);
  assert.deepEqual(deps.restore.calls, [
    { articleTable: "articles", sourceKey: null, limit: 1, afterArticleRowId: null },
    { articleTable: "article_content_versions_p3", sourceKey: null, limit: 1, afterArticleRowId: null },
  ]);
  assert.deepEqual(deps.aggregate.calls, [
    { articleTable: "articles", sourceKey: null },
    { articleTable: "article_content_versions_p3", sourceKey: null },
  ]);

  assert.equal(report.event, "article_raw_rollout_preflight");
  assert.equal(report.readOnly, true);
  assert.equal(report.machineReadable, true);
  assert.deepEqual(report.tables, ["articles", "article_content_versions_p3"]);
  assert.equal(report.probeLimit, 1);
  assert.equal(report.probes.operatorCandidates.ok, true);
  assert.equal(report.probes.aggregateReadiness.ok, true);
  assert.equal(report.probes.restoreCandidates.ok, true);
  assert.equal(report.counts.operatorCandidates.articles, 1);
  assert.equal(report.counts.operatorCandidates.article_content_versions_p3, 0);
  assert.equal(report.counts.restoreCandidates.articles, 1);
  assert.equal(report.counts.restoreCandidates.article_content_versions_p3, 0);
  assert.equal(report.gates.operatorProbesOk, true);
  assert.equal(report.gates.readinessProbesOk, true);
  assert.equal(report.gates.restoreProbesOk, true);
});

test("counts come from the aggregate readiness rows", async () => {
  const deps = dependencies({
    aggregate: new FakeAggregateReadinessRepository({
      articles: aggregate({ totalRows: 10, metadataInconsistent: 2 }),
      article_content_versions_p3: aggregate({ totalRows: 4, metadataInconsistent: 1 }),
    }),
  });
  const report = await runArticleRawRolloutPreflight({}, deps);
  assert.equal(report.counts.totalRows, 14);
  assert.equal(report.counts.metadataInconsistentRows, 3);
  assert.equal(report.gates.metadataInconsistent, true);
  assert.equal(report.gates.readEnableSafe, false);
});

// --- gates ------------------------------------------------------------------

test("migrationSafe requires both flags OFF and no flag errors", async () => {
  const flagsOff = await runArticleRawRolloutPreflight({}, dependencies());
  assert.equal(flagsOff.gates.readEnabled, false);
  assert.equal(flagsOff.gates.writeEnabled, false);
  assert.deepEqual(flagsOff.gates.flagErrors, []);
  assert.equal(flagsOff.gates.migrationSafe, true);

  const readOn = await runArticleRawRolloutPreflight({}, dependencies({ environment: READ_ON }));
  assert.equal(readOn.gates.migrationSafe, false);

  const writeOnly = await runArticleRawRolloutPreflight({}, dependencies({ environment: WRITE_ONLY }));
  assert.equal(writeOnly.gates.writeEnabled, true);
  assert.equal(writeOnly.gates.flagErrors.length, 1);
  assert.equal(writeOnly.gates.migrationSafe, false);

  const bothOn = await runArticleRawRolloutPreflight({}, dependencies({ environment: BOTH_ON }));
  assert.equal(bothOn.gates.migrationSafe, false);
});

test("readEnableSafe requires every probe to succeed and zero metadata inconsistent rows", async () => {
  const base = await runArticleRawRolloutPreflight({}, dependencies());
  assert.equal(base.gates.readEnableSafe, true);

  const operatorFailed = dependencies();
  operatorFailed.operator.failTables.add("article_content_versions_p3");
  const operatorReport = await runArticleRawRolloutPreflight({}, operatorFailed);
  assert.equal(operatorReport.gates.operatorProbesOk, false);
  assert.equal(operatorReport.gates.readEnableSafe, false);

  const restoreFailed = dependencies();
  restoreFailed.restore.failTables.add("articles");
  const restoreReport = await runArticleRawRolloutPreflight({}, restoreFailed);
  assert.equal(restoreReport.gates.restoreProbesOk, false);
  assert.equal(restoreReport.gates.readEnableSafe, false);

  const readinessFailed = dependencies();
  readinessFailed.aggregate.failTables.add("articles");
  const readinessReport = await runArticleRawRolloutPreflight({}, readinessFailed);
  assert.equal(readinessReport.gates.readinessProbesOk, false);
  assert.equal(readinessReport.gates.readEnableSafe, false);

  const inconsistent = dependencies({
    aggregate: new FakeAggregateReadinessRepository({
      articles: aggregate({ metadataInconsistent: 1 }),
      article_content_versions_p3: aggregate(),
    }),
  });
  const inconsistentReport = await runArticleRawRolloutPreflight({}, inconsistent);
  assert.equal(inconsistentReport.gates.metadataInconsistent, true);
  assert.equal(inconsistentReport.gates.readEnableSafe, false);
});

test("writeEnableSafe additionally requires READ ready", async () => {
  const flagsOff = await runArticleRawRolloutPreflight({}, dependencies());
  assert.equal(flagsOff.gates.readEnableSafe, true);
  assert.equal(flagsOff.gates.writeEnableSafe, false);

  const readOn = await runArticleRawRolloutPreflight({}, dependencies({ environment: READ_ON }));
  assert.equal(readOn.gates.writeEnableSafe, true);

  const writeOnly = await runArticleRawRolloutPreflight({}, dependencies({ environment: WRITE_ONLY }));
  assert.equal(writeOnly.gates.writeEnableSafe, false);

  const readOnProbeFailed = dependencies({ environment: READ_ON });
  readOnProbeFailed.operator.failTables.add("articles");
  const readOnProbeFailedReport = await runArticleRawRolloutPreflight({}, readOnProbeFailed);
  assert.equal(readOnProbeFailedReport.gates.writeEnableSafe, false);
});

test("restoreCanarySafe requires the restore probes to succeed and READ ready", async () => {
  const flagsOff = await runArticleRawRolloutPreflight({}, dependencies());
  assert.equal(flagsOff.gates.restoreCanarySafe, false);

  const readOn = await runArticleRawRolloutPreflight({}, dependencies({ environment: READ_ON }));
  assert.equal(readOn.gates.restoreCanarySafe, true);

  const restoreFailed = dependencies({ environment: READ_ON });
  restoreFailed.restore.failTables.add("article_content_versions_p3");
  const restoreFailedReport = await runArticleRawRolloutPreflight({}, restoreFailed);
  assert.equal(restoreFailedReport.gates.restoreCanarySafe, false);

  // A readiness aggregate failure never affects the restore canary gate on its own.
  const readinessFailed = dependencies({ environment: READ_ON });
  readinessFailed.aggregate.failTables.add("articles");
  const readinessFailedReport = await runArticleRawRolloutPreflight({}, readinessFailed);
  assert.equal(readinessFailedReport.gates.readinessProbesOk, false);
  assert.equal(readinessFailedReport.gates.restoreProbesOk, true);
  assert.equal(readinessFailedReport.gates.restoreCanarySafe, true);
});

test("clearCanarySafe is always false with the runtime readiness sample reason", async () => {
  for (const environment of [{}, READ_ON, BOTH_ON]) {
    const report = await runArticleRawRolloutPreflight({}, dependencies({ environment }));
    assert.equal(report.gates.clearCanarySafe, false);
    assert.equal(report.gates.clearCanaryBlockedReason, "runtime_readiness_sample_required");
    assert.equal(ARTICLE_RAW_PREFLIGHT_CLEAR_CANARY_REASON, "runtime_readiness_sample_required");
  }
});

// --- failure handling -------------------------------------------------------

test("probe failures fail closed with sanitized error codes and no fallback", async () => {
  const deps = dependencies();
  deps.operator.failTables.add("articles");
  deps.restore.failTables.add("articles");
  deps.aggregate.failTables.add("articles");

  const report = await runArticleRawRolloutPreflight({}, deps);

  assert.equal(report.probes.operatorCandidates.ok, false);
  assert.equal(report.probes.operatorCandidates.probes.articles.ok, false);
  assert.equal(report.probes.operatorCandidates.probes.articles.errorCode, "article_raw_externalization.database_unavailable");
  assert.equal(report.probes.operatorCandidates.probes.article_content_versions_p3.ok, true);
  assert.equal(report.probes.restoreCandidates.probes.articles.errorCode, "article_raw_restore.database_unavailable");
  assert.equal(report.probes.aggregateReadiness.probes.articles.errorCode, "article_raw_readiness.database_unavailable");
  assert.equal(report.gates.migrationSafe, true);
  assert.equal(report.gates.readEnableSafe, false);
  assert.equal(report.gates.writeEnableSafe, false);
  assert.ok(report.errorCodes.includes("article_raw_externalization.database_unavailable"));
});

test("unsanitized provider errors collapse to the generic probe code", async () => {
  assert.equal(articleRawPreflightErrorCode(new Error("relation \"articles\" does not exist")), ARTICLE_RAW_PREFLIGHT_PROBE_ERROR);
  assert.equal(articleRawPreflightErrorCode(new Error("https://example.test/x?token=secret")), ARTICLE_RAW_PREFLIGHT_PROBE_ERROR);
  assert.equal(articleRawPreflightErrorCode("article_raw_restore.database_unavailable"), "article_raw_restore.database_unavailable");
  assert.equal(articleRawPreflightErrorCode({ message: "raw message with spaces" }), ARTICLE_RAW_PREFLIGHT_PROBE_ERROR);
  assert.equal(articleRawPreflightErrorCode(null), ARTICLE_RAW_PREFLIGHT_PROBE_ERROR);

  const deps = dependencies();
  const failing = deps.operator;
  failing.listArticleRawExternalizationCandidates = async () => {
    throw new Error("relation \"articles\" does not exist");
  };
  const report = await runArticleRawRolloutPreflight({}, deps);
  assert.equal(report.probes.operatorCandidates.probes.articles.errorCode, ARTICLE_RAW_PREFLIGHT_PROBE_ERROR);
});

// --- migration filenames ----------------------------------------------------

test("the hardcoded M6A..M6E + M6G migration allowlist resolves against the repository", async () => {
  const report = await runArticleRawRolloutPreflight({}, dependencies());
  assert.equal(report.migrations.checked, 7);
  assert.equal(report.migrations.present, 7);
  assert.deepEqual(report.migrations.missing, []);
  assert.deepEqual(report.migrations.phases, ["M6A", "M6B", "M6C", "M6D-A", "M6D-B", "M6E", "M6G"]);
  assert.equal(report.gates.migrationFilesPresent, true);
  assert.equal(report.gates.migrationSafe, true);

  for (const migration of ARTICLE_RAW_PREFLIGHT_MIGRATIONS) {
    assert.ok(fs.existsSync(path.join(realMigrationRoot, migration.file)), `${migration.phase} must exist`);
  }
});

test("the migration check reports only the missing allowlisted names", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldcons-preflight-"));
  try {
    fs.writeFileSync(path.join(root, "20260919130000_article_raw_blob_contract.sql"), "");
    fs.writeFileSync(path.join(root, "20260919180000_article_raw_blob_restore.sql"), "");
    fs.writeFileSync(path.join(root, "not-in-allowlist.sql"), "");

    const report = await runArticleRawRolloutPreflight({ migrationRoot: root }, dependencies());
    assert.equal(report.migrations.checked, 7);
    assert.equal(report.migrations.present, 2);
    assert.deepEqual(report.migrations.missing, [
      "20260919140000_article_raw_blob_externalization_backfill.sql",
      "20260919150000_article_raw_blob_inline_clear.sql",
      "20260919160000_article_raw_operator_read_authority.sql",
      "20260919170000_article_raw_readiness_observability.sql",
      "20260919190000_artifact_blob_contract_hardening.sql",
    ]);
    assert.equal(report.gates.migrationFilesPresent, false);
    assert.equal(report.gates.migrationSafe, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- redaction --------------------------------------------------------------

test("the preflight report never emits refs, hashes, raw content, source keys, or row ids", async () => {
  const report = await runArticleRawRolloutPreflight({}, dependencies());
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(STORAGE_REF), false);
  assert.equal(serialized.includes("artifacts/"), false);
  assert.equal(serialized.includes(BLOB_HASH), false);
  assert.equal(serialized.includes(SENSITIVE_MARKER), false);
  assert.equal(serialized.includes(SOURCE_KEY), false);
  assert.equal(serialized.includes(ROW_ID), false);
  assert.equal(/https?:\/\//.test(serialized), false);
  assert.equal(/(token|secret|signature|credential)/i.test(serialized), false);
  assert.equal("rawText" in report, false);
  assert.equal("storageRef" in report, false);
  assert.equal("outcomes" in report, false);
});

// --- static contracts -------------------------------------------------------

test("the module probes only through the three repositories and never queries or mutates raw tables", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  assert.match(source, /listArticleRawExternalizationCandidates/);
  assert.match(source, /readArticleRawReadiness/);
  assert.match(source, /listArticleRawRestoreCandidates/);
  assert.match(source, /ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT = 1/);
  assert.match(source, /limit: ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT/);
  assert.match(source, /migrationSafe = !readEnabled/);
  assert.match(source, /readEnableSafe = allProbesOk && !metadataInconsistent/);
  assert.match(source, /writeEnableSafe = readEnableSafe && readReady/);
  assert.match(source, /restoreCanarySafe = restoreCandidates\.ok && readReady/);
  assert.match(source, /clearCanarySafe: false/);
  assert.match(source, /runtime_readiness_sample_required/);
  assert.equal(source.includes(".from("), false);
  assert.equal(source.includes(".select("), false);
  assert.equal(source.includes("ArtifactBlobStore"), false);
  assert.equal(source.includes("createArtifactBlobStore"), false);
  assert.doesNotMatch(source, /store\.(put|get|head|delete)\(/);
  assert.doesNotMatch(source, /attachArticleRawExternalization|restoreArticleRawInline|clearArticleRawInline/);
  assert.doesNotMatch(source, /console\.log/);
});

test("the CLI is read-only, gate-checking, and has no execute/acknowledge/Blob path", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /runArticleRawRolloutPreflight\(/);
  assert.match(source, /postgresArticleRawExternalizationRepository/);
  assert.match(source, /postgresArticleRawReadinessRepository/);
  assert.match(source, /postgresArticleRawRestoreRepository/);
  assert.match(source, /REQUIREMENTS = \["migration", "read", "write", "restore"\]/);
  assert.match(source, /migration: report\.gates\.migrationSafe/);
  assert.match(source, /read: report\.gates\.readEnableSafe/);
  assert.match(source, /write: report\.gates\.writeEnableSafe/);
  assert.match(source, /restore: report\.gates\.restoreCanarySafe/);
  assert.match(source, /return 2/);
  assert.match(source, /articleRawPreflightErrorCode/);
  assert.doesNotMatch(source, /flag\("execute"\)/);
  assert.doesNotMatch(source, /acknowledge-/);
  assert.doesNotMatch(source, /createArtifactBlobStore/);
  assert.doesNotMatch(source, /ArtifactBlobStore/);
  assert.doesNotMatch(source, /store\.(put|delete)\(/);
  assert.doesNotMatch(source, /console\.log/);
});
