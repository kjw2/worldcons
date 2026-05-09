import type { CrawlAttemptLog, CrawlResponse, CrawlerDiagnosticsCollector } from "@/lib/crawler/types";

export function createDiagnosticsCollector(sourceKey?: string): CrawlerDiagnosticsCollector {
  return { sourceKey, attempts: [] };
}

export function addDiagnosticAttempt(collector: CrawlerDiagnosticsCollector | undefined, attempt: CrawlAttemptLog) {
  if (!collector) return;
  collector.attempts.push({
    ...attempt,
    errorMessage: attempt.errorMessage?.slice(0, 500),
  });
}

export function diagnosticFromResponse(
  response: CrawlResponse,
  extra: Partial<CrawlAttemptLog> = {},
): CrawlAttemptLog {
  return {
    url: response.url,
    finalUrl: response.finalUrl,
    strategy: response.strategy,
    status: response.status,
    contentType: response.contentType,
    blocked: response.diagnostics?.blocked,
    timeout: response.diagnostics?.timeout,
    timeoutPhase: response.diagnostics?.timeoutPhase,
    title: response.diagnostics?.title,
    errorCode: response.diagnostics?.errorCode,
    errorMessage: response.diagnostics?.errorMessage,
    htmlLength: response.html?.length,
    ...extra,
  };
}
