import {
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  SEARCH_CANARY_VERSION,
  type SearchCanaryBlocker,
  type SearchCanaryObservation,
  type SearchCanaryProjectionPlan,
  type SearchCanaryReport,
  type SearchCanaryThresholds,
  type SearchCanaryVectorBootstrapPlan,
  type SearchCanaryWritePlanSummary,
} from "./types";
import { summarizeSearchCanary } from "./evaluate";
import { summarizeSearchCanaryTimings } from "./timing";
import { summarizeOracleModes } from "./oracle";

/**
 * Deterministic canary evidence assembly + rendering (runtime-neutral).
 *
 * A report is ids/counts/hashes/latencies only: no search text, no document
 * content, no vector values, no URLs, no credentials. `generatedAt` is injected
 * so evidence is reproducible for identical inputs. M7.6 adds the content-free
 * parameterized write-plan summary, the operator/binding timing split and
 * explicit oracle-mode accounting.
 */
export interface BuildSearchCanaryReportInput {
  generatedAt: string;
  vectorIndex: string;
  database: string;
  source: "supabase" | "remote-d1" | "fixture";
  projection: SearchCanaryProjectionPlan;
  vectorBootstrap: SearchCanaryVectorBootstrapPlan | null;
  remoteWrites: SearchCanaryReport["remoteWrites"];
  /**
   * The content-free summary only. The executable plan with bound params is
   * never accepted here, so it can never be attached to a report.
   */
  writePlan?: SearchCanaryWritePlanSummary | null;
  observations: readonly SearchCanaryObservation[];
  thresholds?: SearchCanaryThresholds;
  blockers?: readonly SearchCanaryBlocker[];
}

/**
 * The refined M7.6 policy records an explicit, unresolved blocker whenever a
 * generic lexical (`contains`) fulltext case was compared against production:
 * its ordering is informational because M7.2 documents that FTS5 bm25 does not
 * reproduce Postgres `ts_rank_cd` and no acceptance threshold has been agreed.
 * The blocker keeps `GO-SEARCH` blocked instead of inventing a threshold.
 */
export function deriveSearchCanaryRankBlockers(
  observations: readonly SearchCanaryObservation[],
): SearchCanaryBlocker[] {
  const informational = observations.filter((observation) => observation.rankComparison?.strict === false);
  if (informational.length === 0) return [];
  return [
    {
      code: "fulltext_rank_threshold_unagreed",
      detail:
        `${informational.length} generic lexical fulltext case(s) diverged from production ordering; ` +
        "no FTS5-bm25-vs-Postgres acceptance threshold is agreed, so the divergence is informational and " +
        "does not fail the case, but GO-SEARCH stays blocked until a rank acceptance threshold is agreed",
    },
  ];
}

export function buildSearchCanaryReport(input: BuildSearchCanaryReportInput): SearchCanaryReport {
  const thresholds = input.thresholds ?? SEARCH_CANARY_DEFAULT_THRESHOLDS;
  const metrics = summarizeSearchCanary(input.observations, thresholds);
  const supplied = [...(input.blockers ?? []), ...input.projection.blockers, ...deriveSearchCanaryRankBlockers(input.observations)];
  const seen = new Set<string>();
  const blockers = supplied.filter((blocker) => {
    if (seen.has(blocker.code)) return false;
    seen.add(blocker.code);
    return true;
  });
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
    writePlan: input.writePlan ?? null,
    metrics,
    timings: summarizeSearchCanaryTimings(input.observations),
    oracle: summarizeOracleModes(input.observations),
    observations: [...input.observations],
    thresholds,
    blockers,
    verdict,
  };
}

function rate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Compact, content-free rank comparison for the observation table (ids only). */
function renderRank(observation: SearchCanaryObservation): string {
  const rank = observation.rankComparison;
  if (!rank) return "n/a";
  return `${rank.strict ? "strict" : "info"} overlap@${rank.k}=${rank.overlapAtKCount} exactOrder=${rank.exactOrder} sameSet=${rank.sameSet}`;
}

/** Renders a human-readable markdown report. Safe to commit: ids/counts only. */
export function renderSearchCanaryMarkdown(report: SearchCanaryReport): string {
  const lines: string[] = [];
  lines.push("# WorldCons M7.6 search canary evidence");
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
    `- remoteWrites: indexCreated=${report.remoteWrites.indexCreated}, metadataIndexesCreated=${report.remoteWrites.metadataIndexesCreated.length}, vectorsUpserted=${report.remoteWrites.vectorsUpserted}, searchRowsInserted=${report.remoteWrites.searchRowsInserted}, databaseCreated=${report.remoteWrites.databaseCreated}, writer=${report.remoteWrites.writer ?? "none"}, parameterizedStatements=${report.remoteWrites.parameterizedStatements ?? 0}, literalOversizedStatements=${report.remoteWrites.literalOversizedStatements ?? 0}`,
  );
  if (report.writePlan) {
    lines.push(
      `- writePlan: statements=${report.writePlan.counts.statements}, parameters=${report.writePlan.counts.parameters}, maxAuthoredSqlBytes=${report.writePlan.counts.maxAuthoredSqlBytes}, maxParamBytes=${report.writePlan.counts.maxParamBytes}, maxLiteralBytes=${report.writePlan.counts.maxLiteralBytes}, literalOversizedStatements=${report.writePlan.counts.literalOversizedStatements}, literalOversizedBytes=${report.writePlan.counts.literalOversizedBytes}`,
    );
  }
  lines.push("");
  lines.push("## Timings");
  lines.push("");
  lines.push("| dimension | samples | p50 ms | p95 ms |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| operator | ${report.timings.operator.samples} | ${report.timings.operator.p50Ms} | ${report.timings.operator.p95Ms} |`,
  );
  lines.push(
    `| binding | ${report.timings.binding.samples} | ${report.timings.binding.p50Ms} | ${report.timings.binding.p95Ms} |`,
  );
  lines.push("");
  lines.push("## Oracle modes");
  lines.push("");
  lines.push(
    `- production-rpc=${report.oracle.productionRpc}, artifact-reference=${report.oracle.artifactReference}, none=${report.oracle.none}, drift=${report.oracle.drift}`,
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
  lines.push(`| maxBindingLatencyP50Ms | ${report.thresholds.maxBindingLatencyP50Ms ?? "(not enforced)"} |`);
  lines.push(`| maxBindingLatencyP95Ms | ${report.thresholds.maxBindingLatencyP95Ms ?? "(not enforced)"} |`);
  lines.push("");
  lines.push("## Metrics by mode");
  lines.push("");
  lines.push("| mode | cases | compared | pass | mismatch | error | timeout | mismatchRate | errorRate | p50ms | p95ms | bindingSamples | bindingP50ms | bindingP95ms | rowReads | oracleCompared | oracleMatched | oracleInformational | pass |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const mode of report.metrics.modes) {
    lines.push(
      `| ${mode.mode} | ${mode.cases} | ${mode.compared} | ${mode.passed} | ${mode.mismatched} | ${mode.errored} | ${mode.timedOut} | ${rate(mode.mismatchRate)} | ${rate(mode.errorRate)} | ${mode.latencyP50Ms} | ${mode.latencyP95Ms} | ${mode.bindingSamples} | ${mode.bindingLatencyP50Ms} | ${mode.bindingLatencyP95Ms} | ${mode.rowReads} | ${mode.oracleCompared} | ${mode.oracleMatched} | ${mode.oracleInformational} | ${mode.pass} |`,
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
  lines.push("| case | mode | status | latencyMs | bindingLatencyMs | rowReads | oracleMode | oracleParity | rank | topIds | detail |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const observation of report.observations) {
    lines.push(
      `| ${observation.caseId} | ${observation.mode} | ${observation.status} | ${observation.latencyMs} | ${observation.bindingLatencyMs ?? "n/a"} | ${observation.rowReads} | ${observation.oracleMode}${observation.oracleDrift ? " (drift)" : ""} | ${observation.oracleParity} | ${renderRank(observation)} | ${observation.topIds.join(", ")} | ${observation.detail ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
