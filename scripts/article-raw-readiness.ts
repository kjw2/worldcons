import "dotenv/config";
import { postgresArticleRawReadinessRepository } from "@/lib/article-raw/readiness-repository";
import { postgresArticleRawExternalizationRepository } from "@/lib/article-raw/externalization-repository";
import {
  runArticleRawReadiness,
  type ArticleRawReadinessTable,
} from "@/lib/article-raw/readiness";
import { articleRawBlobReadReady } from "@/lib/article-raw/flags";
import { createArtifactBlobStore } from "@/lib/storage/blob";

const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;

/**
 * `--table` accepts the two carrier aliases plus `all` (the default). `versions` is
 * the operator-friendly alias for `article_content_versions_p3`.
 */
const TABLE_ALIASES: Record<string, ArticleRawReadinessTable[]> = {
  articles: ["articles"],
  versions: ["article_content_versions_p3"],
  all: ["articles", "article_content_versions_p3"],
};

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function integerArgument(name: string, fallback: number, min: number, max: number) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}

function selectedTables(): ArticleRawReadinessTable[] | undefined {
  const value = argumentValue("table")?.trim().toLowerCase();
  if (!value) return undefined;
  const tables = TABLE_ALIASES[value];
  if (!tables) throw new Error("invalid_table");
  return [...tables];
}

function optionalSourceKey() {
  const value = argumentValue("source")?.trim();
  if (!value) return null;
  if (!SOURCE_KEY_PATTERN.test(value)) throw new Error("invalid_source");
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const tables = selectedTables();
  const sourceKey = optionalSourceKey();
  const batchSize = integerArgument("batch-size", 25, 1, 100);
  const maxBatches = integerArgument("max-batches", 50, 1, 1000);
  const verificationSampleSize = integerArgument("verify-sample", 0, 0, 100);
  const requireExternalizationReady = flag("require-externalization-ready");
  const requireApplicationWriteReady = flag("require-application-write-ready");
  const requireNewWriteReady = flag("require-new-write-ready");
  const requireInlineClearReady = flag("require-inline-clear-ready");

  // Blob verification is the only path that touches Blob storage. It is off by
  // default and additionally requires the article raw Blob read flag, which is
  // checked before the Blob store is ever created, so a bare readiness run issues
  // zero head/get calls.
  if (verificationSampleSize > 0 && !articleRawBlobReadReady(process.env)) {
    throw new Error("article_raw_blob_read_not_ready");
  }

  const store = verificationSampleSize > 0 ? createArtifactBlobStore() : null;
  const report = await runArticleRawReadiness(
    {
      tables,
      sourceKey,
      batchSize,
      maxBatches,
      verificationSampleSize,
    },
    {
      repository: postgresArticleRawReadinessRepository,
      candidates: verificationSampleSize > 0 ? postgresArticleRawExternalizationRepository : null,
      store,
      environment: process.env,
    },
  );

  output(report as unknown as Record<string, unknown>);
  if (requireInlineClearReady && !report.decisions.inlineClearReady) return 2;
  if (requireNewWriteReady && !report.decisions.newWriteReady) return 2;
  if (requireApplicationWriteReady && !report.decisions.applicationWriteReady) return 2;
  if (requireExternalizationReady && !report.decisions.externalizationReady) return 2;
  return report.gates.critical ? 1 : 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "article_raw_readiness_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    readOnly: true,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    storageRefsEmitted: 0,
  });
  process.exitCode = 1;
});
