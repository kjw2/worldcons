import { Fragment } from "react";
import type { IngestionRunRecord } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

interface DiagnosticAttempt {
  url?: string;
  strategy?: string;
  status?: number;
  errorCode?: string;
  errorMessage?: string;
  result?: string;
  timeoutPhase?: string;
  textLength?: number;
  recommendedAction?: string;
  robotsAllowed?: boolean;
  robotsMatchedRule?: string;
  robotsMatchedDirective?: string;
  robotsCrawlDelaySeconds?: number;
  maxConcurrency?: number;
  selectorMatchCount?: number;
  discoveredCount?: number;
  fallback?: boolean;
}

interface CollectionCounts {
  publishableCount?: number;
  metadataOnlyCount?: number;
  robotsDisallowedCount?: number;
  blockedCount?: number;
  timeoutCount?: number;
  seedCount?: number;
}

function diagnosticsFor(run: IngestionRunRecord) {
  const metadata = run.metadata as { diagnostics?: { attempts?: DiagnosticAttempt[] }; fallbackUsed?: boolean; collectionCounts?: CollectionCounts } | null | undefined;
  return {
    attempts: metadata?.diagnostics?.attempts ?? [],
    fallbackUsed: Boolean(metadata?.fallbackUsed),
    collectionCounts: metadata?.collectionCounts ?? {},
  };
}

export function IngestionStatusPanel({ runs }: { runs: IngestionRunRecord[] }) {
  if (runs.length === 0) {
    return <div className="rounded-md border border-dashed border-rule bg-white px-5 py-12 text-center text-sm text-ink/62">수집 실행 기록이 없습니다.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-rule bg-white">
      <table className="min-w-full divide-y divide-rule text-sm">
        <thead className="bg-parchment">
          <tr className="text-left text-xs font-semibold uppercase text-ink/60">
            <th className="px-4 py-3">source_key</th>
            <th className="px-4 py-3">시작</th>
            <th className="px-4 py-3">종료</th>
            <th className="px-4 py-3">status</th>
            <th className="px-4 py-3">discovered</th>
            <th className="px-4 py-3">fetched</th>
            <th className="px-4 py-3">summarized</th>
            <th className="px-4 py-3">publishable</th>
            <th className="px-4 py-3">metadata</th>
            <th className="px-4 py-3">robots</th>
            <th className="px-4 py-3">blocked</th>
            <th className="px-4 py-3">timeout</th>
            <th className="px-4 py-3">seed</th>
            <th className="px-4 py-3">failed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {runs.map((run) => {
            const diagnostics = diagnosticsFor(run);
            return (
            <Fragment key={`${run.sourceKey}-${run.startedAt}`}>
              <tr key={`${run.sourceKey}-${run.startedAt}`}>
                <td className="px-4 py-3 font-medium">{run.sourceKey}</td>
                <td className="px-4 py-3">{formatDisplayDate(run.startedAt)}</td>
                <td className="px-4 py-3">{formatDisplayDate(run.finishedAt)}</td>
                <td className="px-4 py-3">{run.status}</td>
                <td className="px-4 py-3">{run.discoveredCount}</td>
                <td className="px-4 py-3">{run.fetchedCount}</td>
                <td className="px-4 py-3">{run.summarizedCount}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.publishableCount ?? "-"}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.metadataOnlyCount ?? "-"}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.robotsDisallowedCount ?? "-"}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.blockedCount ?? "-"}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.timeoutCount ?? "-"}</td>
                <td className="px-4 py-3">{diagnostics.collectionCounts.seedCount ?? "-"}</td>
                <td className="px-4 py-3">{run.failedCount}</td>
              </tr>
              {diagnostics.attempts.length > 0 ? (
                <tr key={`${run.sourceKey}-${run.startedAt}-diagnostics`} className="bg-parchment/40">
                  <td colSpan={14} className="px-4 py-3">
                    <div className="mb-2 text-xs font-semibold text-ink/64">crawler diagnostics</div>
                    {run.failedCount > 0 || diagnostics.fallbackUsed ? (
                      <p className="mb-3 rounded-md border border-court/20 bg-white p-3 text-xs text-court">
                        공식 사이트에 접근했지만 현재 수집 전략으로 목록 또는 본문을 안정적으로 파싱하지 못했습니다. fetch, Crawlee CheerioCrawler, PlaywrightCrawler, sitemap, seed fallback 결과를 확인하세요.
                      </p>
                    ) : null}
                    <div className="grid gap-2">
                      {diagnostics
                        .attempts.slice(0, 12)
                        .map((attempt, index) => (
                          <div key={`${attempt.strategy}-${attempt.url}-${index}`} className="rounded-md border border-rule bg-white p-3 text-xs text-ink/70">
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              <span>strategy: {attempt.strategy ?? "-"}</span>
                              {attempt.result ? <span>result: {attempt.result}</span> : null}
                              <span>status: {attempt.status ?? "-"}</span>
                              <span>selector: {attempt.selectorMatchCount ?? "-"}</span>
                              {attempt.textLength !== undefined ? <span>text: {attempt.textLength}</span> : null}
                              <span>discovered: {attempt.discoveredCount ?? "-"}</span>
                              <span>fallback: {attempt.fallback ? "yes" : "no"}</span>
                              {attempt.timeoutPhase ? <span>timeout: {attempt.timeoutPhase}</span> : null}
                              {attempt.maxConcurrency ? <span>maxConcurrency: {attempt.maxConcurrency}</span> : null}
                              {attempt.robotsAllowed !== undefined ? <span>robots: {attempt.robotsAllowed ? "allow" : "disallow"}</span> : null}
                              {attempt.robotsMatchedRule ? <span>rule: {attempt.robotsMatchedDirective ?? "-"} {attempt.robotsMatchedRule}</span> : null}
                              {attempt.robotsCrawlDelaySeconds !== undefined ? <span>crawl-delay: {attempt.robotsCrawlDelaySeconds}s</span> : null}
                            </div>
                            {attempt.url ? <div className="mt-1 break-all text-ink/55">{attempt.url}</div> : null}
                            {attempt.errorCode || attempt.errorMessage ? (
                              <div className="mt-1 text-court">
                                {attempt.errorCode ? `${attempt.errorCode}: ` : ""}
                                {attempt.errorMessage}
                              </div>
                            ) : null}
                            {attempt.recommendedAction ? <div className="mt-1 text-ink/55">action: {attempt.recommendedAction}</div> : null}
                          </div>
                        ))}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          )})}
        </tbody>
      </table>
    </div>
  );
}
