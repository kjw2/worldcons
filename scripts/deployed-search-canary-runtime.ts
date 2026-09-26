import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEPLOYED_SEARCH_CANARY_ENDPOINT,
  DEPLOYED_SEARCH_CANARY_MAX_ARTICLES,
  DEPLOYED_SEARCH_CANARY_MAX_CASES_PER_MODE,
  buildDeployedRuntimeReport,
  buildSearchCanaryCases,
  buildSearchCanaryProjectionPlan,
  renderDeployedRuntimeMarkdown,
  type DeployedRuntimeResult,
} from "@/lib/cloudflare/search-canary";
import { createSupabaseCanaryReader } from "@/lib/cloudflare/search-canary/operator/supabase-read";
import { runWorkerCanaryCases } from "@/lib/cloudflare/search-canary/operator/parameterized-writer";

const TOKEN_ENV = "WORLDCONS_SEARCH_CANARY_TOKEN";
const REPORT_DIR = path.join("artifacts", "cloudflare-m7");
const REPORT_JSON = "m7.9-deployed-search-canary-runtime.json";
const REPORT_MD = "m7.9-deployed-search-canary-runtime.md";

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function printDryRun(): void {
  console.log("WorldCons M7.9 deployed Search Canary runtime (dry-run)");
  console.log(`  endpoint: ${DEPLOYED_SEARCH_CANARY_ENDPOINT}`);
  console.log(`  maxArticles: ${DEPLOYED_SEARCH_CANARY_MAX_ARTICLES}`);
  console.log(`  maxCasesPerMode: ${DEPLOYED_SEARCH_CANARY_MAX_CASES_PER_MODE}`);
  console.log(`  requiredEnv: ${TOKEN_ENV}`);
  console.log("  dry-run: no Supabase query, Worker request or artifact write");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) throw new Error("--apply is unavailable: the deployed runtime runner is read-only");
  const run = args.includes("--run");
  const reportRequested = args.includes("--report");
  if (!run) {
    printDryRun();
    return;
  }

  const token = nonEmpty(process.env[TOKEN_ENV]);
  if (token === null) throw new Error(`${TOKEN_ENV} is required for the deployed bearer path`);

  const source = await createSupabaseCanaryReader().readSources(DEPLOYED_SEARCH_CANARY_MAX_ARTICLES);
  const projection = buildSearchCanaryProjectionPlan({
    publications: source.publications,
    versions: source.versions,
    articles: source.articles,
    artifacts: source.artifacts,
    maxArticles: DEPLOYED_SEARCH_CANARY_MAX_ARTICLES,
  });
  if (
    projection.documents.length !== DEPLOYED_SEARCH_CANARY_MAX_ARTICLES ||
    projection.records.length !== DEPLOYED_SEARCH_CANARY_MAX_ARTICLES ||
    projection.changes.missingArtifacts !== 0 ||
    projection.changes.staleArtifacts !== 0
  ) {
    throw new Error(
      `deployed_runtime_projection_invalid: documents=${projection.documents.length}, vectors=${projection.records.length}, ` +
        `missing=${projection.changes.missingArtifacts}, stale=${projection.changes.staleArtifacts}`,
    );
  }

  const cases = buildSearchCanaryCases({
    documents: projection.documents,
    records: projection.records,
    maxCasesPerMode: DEPLOYED_SEARCH_CANARY_MAX_CASES_PER_MODE,
  });
  const workerCases = cases.map((caseDef) => ({
    id: caseDef.id,
    mode: caseDef.mode,
    query: caseDef.query,
    source: caseDef.source ?? null,
    jurisdiction: caseDef.jurisdiction ?? null,
    contentType: caseDef.contentType ?? null,
    language: caseDef.language ?? null,
    range: caseDef.range,
    limit: caseDef.limit,
    offset: caseDef.offset,
    count: caseDef.count,
    vectorId: caseDef.vectorId ?? null,
  }));
  let results: DeployedRuntimeResult[];
  try {
    results = await runWorkerCanaryCases(
      { endpoint: DEPLOYED_SEARCH_CANARY_ENDPOINT, token, allowUnauthenticatedLocalhost: false },
      workerCases,
    );
  } catch (error) {
    const code = error instanceof Error && error.name === "AbortError" ? "worker_timeout" : "worker_request_failed";
    results = cases.map((caseDef) => ({
      caseId: caseDef.id,
      latencyMs: 0,
      topIds: [],
      retrievalMode: null,
      errorCode: code,
    }));
  }
  const evidence = buildDeployedRuntimeReport({
    generatedAt: new Date().toISOString(),
    cases,
    results,
    projection: {
      documents: projection.documents.length,
      vectorRecords: projection.records.length,
      missingArtifacts: projection.changes.missingArtifacts,
      staleArtifacts: projection.changes.staleArtifacts,
    },
  });

  if (reportRequested) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, REPORT_JSON), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(REPORT_DIR, REPORT_MD), renderDeployedRuntimeMarkdown(evidence), "utf8");
  }

  console.log("WorldCons M7.9 deployed Search Canary runtime (read-only)");
  console.log(`  state: ${evidence.state}, cases: ${evidence.cases}`);
  for (const mode of evidence.modes) {
    console.log(
      `  ${mode.mode}: pass=${mode.passed}/${mode.cases}, errorRate=${mode.errorRate}, p50/p95=${mode.latencyP50Ms}/${mode.latencyP95Ms}ms`,
    );
  }
  console.log(`  stableHash: ${evidence.stableHash}`);
  if (reportRequested) console.log(`  wrote ${REPORT_DIR}`);
  if (evidence.state !== "pass") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`deployed-search-canary-runtime failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
