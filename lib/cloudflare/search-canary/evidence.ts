import {
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  SEARCH_CANARY_VERSION,
  type SearchCanaryBlocker,
  type SearchCanaryObservation,
  type SearchCanaryProjectionPlan,
  type SearchCanaryReport,
  type SearchCanaryThresholds,
  type SearchCanaryVectorBootstrapPlan,
} from "./types";
import { summarizeSearchCanary } from "./evaluate";

/**
 * Deterministic canary evidence assembly + rendering (runtime-neutral).
 *
 * A report is ids/counts/hashes/latencies only: no search text, no document
 * content, no vector values, no URLs, no credentials. `generatedAt` is injected
 * so evidence is reproducible for identical inputs.
 */
export interface BuildSearchCanaryReportInput {
  generatedAt: string;
  vectorIndex: string;
  database: string;
  source: "supabase" | "remote-d1" | "fixture";
  projection: SearchCanaryProjectionPlan;
  vectorBootstrap: SearchCanaryVectorBootstrapPlan | null;
  remoteWrites: SearchCanaryReport["remoteWrites"];
  observations: readonly SearchCanaryObservation[];
  thresholds?: SearchCanaryThresholds;
  blockers?: readonly SearchCanaryBlocker[];
}

export function buildSearchCanaryReport(input: BuildSearchCanaryReportInput): SearchCanaryReport {
  const thresholds = input.thresholds ?? SEARCH_CANARY_DEFAULT_THRESHOLDS;
  const metrics = summarizeSearchCanary(input.observations, thresholds);
  const blockers = [...(input.blockers ?? []), ...input.projection.blockers];
  const compared = metrics.totalCompared;
  const verdict: SearchCanaryReport["verdict"] =
    compared === 0 ? "insufficient_evidence" : metrics.pass ? "pass" : "fail";
  return {
    version: SEARCH_CANARY_VERSION,
    generatedAt: input.generatedAt,
    scope: "search-canary",
    vectorIndex: input.vectorIndex,
    database: input.database,
    source: input.source,
    maxArticles: input.projection.maxArticles,
    projection: {
      projectedDocuments: input.projection.changes.projectedDocuments,
      vectorRecords: input.projection.changes.vectorRecords,
      missingArtifacts: input.projection.changes.missingArtifacts,
      staleArtifacts: input.projection.changes.staleArtifacts,
      truncated: input.projection.truncated,
    },
    vectorBootstrap: input.vectorBootstrap,
    remoteWrites: input.remoteWrites,
    metrics,
    observations: [...input.observations],
    thresholds,
    blockers,
    verdict,
  };
}

function rate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Renders a human-readable markdown report. Safe to commit: ids/counts only. */
export function renderSearchCanaryMarkdown(report: SearchCanaryReport): string {
  const lines: string[] = [];
  lines.push("# WorldCons M7.5 remote search canary evidence");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: **${report.verdict}**`);
  lines.push(`- source: ${report.source}`);
  lines.push(`- vectorIndex: ${report.vectorIndex}`);
  lines.push(`- database: ${report.database}`);
  lines.push(`- maxArticles: ${report.maxArticles}`);
  lines.push(
    `- projection: documents=${report.projection.projectedDocuments}, vectors=${report.projection.vectorRecords}, missingArtifacts=${report.projection.missingArtifacts}, staleArtifacts=${report.projection.staleArtifacts}, truncated=${report.projection.truncated}`,
  );
  lines.push(
    `- remoteWrites: indexCreated=${report.remoteWrites.indexCreated}, metadataIndexesCreated=${report.remoteWrites.metadataIndexesCreated.length}, vectorsUpserted=${report.remoteWrites.vectorsUpserted}, searchRowsInserted=${report.remoteWrites.searchRowsInserted}, databaseCreated=${report.remoteWrites.databaseCreated}`,
  );
  lines.push("");
  lines.push("## Thresholds");
  lines.push("");
  lines.push("| threshold | value |");
  lines.push("| --- | --- |");
  lines.push(`| minCasesPerMode | ${report.thresholds.minCasesPerMode} |`);
  lines.push(`| maxMismatchRate | ${rate(report.thresholds.maxMismatchRate)} |`);
  lines.push(`| maxErrorRate | ${rate(report.thresholds.maxErrorRate)} |`);
  lines.push(`| maxTimeoutRate | ${rate(report.thresholds.maxTimeoutRate)} |`);
  lines.push(`| maxLatencyP50Ms | ${report.thresholds.maxLatencyP50Ms} |`);
  lines.push(`| maxLatencyP95Ms | ${report.thresholds.maxLatencyP95Ms} |`);
  lines.push("");
  lines.push("## Metrics by mode");
  lines.push("");
  lines.push("| mode | cases | compared | pass | mismatch | error | timeout | mismatchRate | errorRate | p50ms | p95ms | rowReads | oracleCompared | oracleMatched | pass |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const mode of report.metrics.modes) {
    lines.push(
      `| ${mode.mode} | ${mode.cases} | ${mode.compared} | ${mode.passed} | ${mode.mismatched} | ${mode.errored} | ${mode.timedOut} | ${rate(mode.mismatchRate)} | ${rate(mode.errorRate)} | ${mode.latencyP50Ms} | ${mode.latencyP95Ms} | ${mode.rowReads} | ${mode.oracleCompared} | ${mode.oracleMatched} | ${mode.pass} |`,
    );
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  if (report.blockers.length === 0) lines.push("(none)");
  else for (const blocker of report.blockers) lines.push(`- \`${blocker.code}\`: ${blocker.detail}`);
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push("| case | mode | status | latencyMs | rowReads | oracle | topIds | detail |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const observation of report.observations) {
    lines.push(
      `| ${observation.caseId} | ${observation.mode} | ${observation.status} | ${observation.latencyMs} | ${observation.rowReads} | ${observation.oracleParity} | ${observation.topIds.join(", ")} | ${observation.detail ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
