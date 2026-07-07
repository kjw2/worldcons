"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Database, Loader2, Play, RefreshCw, Tags, TriangleAlert } from "lucide-react";
import type { SourceRecord } from "@/lib/db/types";

type AdminAction = "ingest" | "ingest-and-summarize" | "summarize" | "refresh-tags";

interface ActionRequestOptions {
  action: AdminAction;
  sourceKey?: string;
  limit: number;
  summarizeLimit: number;
  refreshTags: boolean;
  allowVercelCrawling: boolean;
}

function toNumber(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionLabel(action: AdminAction) {
  if (action === "ingest-and-summarize") return "수집 후 요약";
  if (action === "summarize") return "요약 실행";
  if (action === "refresh-tags") return "태그 갱신";
  return "수집 실행";
}

function compactResult(result: unknown) {
  if (!isRecord(result)) return "작업이 완료되었습니다.";

  const parts: string[] = [];
  const ingest = result.ingest;
  if (isRecord(ingest)) {
    const mode = typeof ingest.mode === "string" ? ingest.mode : "unknown";
    const message = typeof ingest.message === "string" ? ingest.message : null;
    if (mode === "blocked" && message) {
      parts.push(`수집 차단: ${message}`);
    } else {
      const results = Array.isArray(ingest.results) ? ingest.results : [];
      const fetched = results.reduce((sum, item) => (isRecord(item) && typeof item.fetchedCount === "number" ? sum + item.fetchedCount : sum), 0);
      const failed = results.reduce((sum, item) => (isRecord(item) && typeof item.failedCount === "number" ? sum + item.failedCount : sum), 0);
      parts.push(`수집 ${mode}: fetched ${fetched}, failed ${failed}`);
    }
  }

  const summarize = result.summarize;
  if (isRecord(summarize)) {
    const summarized = typeof summarize.summarizedCount === "number" ? summarize.summarizedCount : 0;
    const failed = typeof summarize.failedCount === "number" ? summarize.failedCount : 0;
    const skipped = typeof summarize.skippedCount === "number" ? summarize.skippedCount : 0;
    parts.push(`요약: 완료 ${summarized}, 실패 ${failed}, 건너뜀 ${skipped}`);
  }

  const tags = result.tags;
  if (isRecord(tags)) {
    const refreshed = tags.refreshed === true ? "완료" : "실패";
    const updated = typeof tags.updatedTags === "number" ? `, ${tags.updatedTags}개` : "";
    const message = typeof tags.errorMessage === "string" ? ` (${tags.errorMessage})` : "";
    parts.push(`태그: ${refreshed}${updated}${message}`);
  }

  return parts.length > 0 ? parts.join(" / ") : "작업이 완료되었습니다.";
}

function resultNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ResultStat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "danger" | "warning" }) {
  const toneClass =
    tone === "success"
      ? "border-mint/25 bg-mint/10 text-mint"
      : tone === "danger"
        ? "border-court/25 bg-court/5 text-court"
        : tone === "warning"
          ? "border-amber-400/40 bg-amber-50 text-amber-800"
          : "border-rule bg-white text-ink/68";

  return (
    <span className={`inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold ${toneClass}`}>
      <span className="text-ink/55">{label}</span>
      <span>{value.toLocaleString("ko-KR")}</span>
    </span>
  );
}

function RequestSummary({ options }: { options: ActionRequestOptions }) {
  return (
    <div className="rounded-md border border-rule bg-white p-3">
      <div className="mb-2 text-xs font-semibold text-ink/55">요청 옵션</div>
      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70">{actionLabel(options.action)}</span>
        <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70">{options.sourceKey || "전체 기관"}</span>
        <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70">수집 {options.limit}</span>
        <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70">요약 {options.summarizeLimit}</span>
        <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70">태그 {options.refreshTags ? "갱신" : "유지"}</span>
        <span className={options.allowVercelCrawling ? "inline-flex min-h-7 items-center rounded-md border border-amber-400/40 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800" : "inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/70"}>
          Vercel 직접 수집 {options.allowVercelCrawling ? "허용" : "차단"}
        </span>
      </div>
    </div>
  );
}

function StructuredResult({ result }: { result: unknown }) {
  if (!isRecord(result)) return null;
  const ingest = isRecord(result.ingest) ? result.ingest : null;
  const ingestResults = ingest && Array.isArray(ingest.results) ? ingest.results.filter(isRecord) : [];
  const summarize = isRecord(result.summarize) ? result.summarize : null;
  const tags = isRecord(result.tags) ? result.tags : null;

  if (!ingest && !summarize && !tags) return null;

  return (
    <div className="mt-3 grid gap-3">
      {ingest ? (
        <div className="rounded-md border border-rule bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-ink/55">수집 결과</span>
            {typeof ingest.mode === "string" ? <span className="rounded-md border border-rule bg-parchment px-2 py-1 text-xs font-semibold text-ink/62">{ingest.mode}</span> : null}
          </div>
          {typeof ingest.message === "string" ? <div className="mb-2 rounded-md border border-amber-400/30 bg-amber-50 p-2 text-xs leading-5 text-amber-800">{ingest.message}</div> : null}
          {ingestResults.length > 0 ? (
            <div className="grid gap-2">
              {ingestResults.map((item, index) => (
                <div key={`${String(item.sourceKey ?? "source")}-${index}`} className="rounded-md border border-rule bg-parchment/35 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{String(item.sourceKey ?? "unknown")}</span>
                    {resultNumber(item, "errors") > 0 ? <span className="text-xs text-court">오류 있음</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <ResultStat label="발견" value={resultNumber(item, "discoveredCount")} />
                    <ResultStat label="수집" value={resultNumber(item, "fetchedCount")} tone="success" />
                    <ResultStat label="요약" value={resultNumber(item, "summarizedCount")} tone="success" />
                    <ResultStat label="갱신" value={resultNumber(item, "refreshedCount")} />
                    <ResultStat label="변경 없음" value={resultNumber(item, "unchangedCount")} />
                    <ResultStat label="건너뜀" value={resultNumber(item, "skippedCount")} tone={resultNumber(item, "skippedCount") > 0 ? "warning" : "neutral"} />
                    <ResultStat label="실패" value={resultNumber(item, "failedCount")} tone={resultNumber(item, "failedCount") > 0 ? "danger" : "neutral"} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {summarize ? (
        <div className="rounded-md border border-rule bg-white p-3">
          <div className="mb-2 text-xs font-semibold text-ink/55">요약 결과</div>
          <div className="flex flex-wrap gap-1.5">
            <ResultStat label="완료" value={resultNumber(summarize, "summarizedCount")} tone="success" />
            <ResultStat label="실패" value={resultNumber(summarize, "failedCount")} tone={resultNumber(summarize, "failedCount") > 0 ? "danger" : "neutral"} />
            <ResultStat label="건너뜀" value={resultNumber(summarize, "skippedCount")} tone={resultNumber(summarize, "skippedCount") > 0 ? "warning" : "neutral"} />
          </div>
          {typeof summarize.message === "string" ? <div className="mt-2 text-xs text-ink/55">{summarize.message}</div> : null}
          {typeof summarize.reason === "string" ? <div className="mt-2 text-xs text-ink/55">{summarize.reason}</div> : null}
        </div>
      ) : null}

      {tags ? (
        <div className="rounded-md border border-rule bg-white p-3">
          <div className="mb-2 text-xs font-semibold text-ink/55">태그 갱신</div>
          <div className="flex flex-wrap gap-1.5">
            <span className={tags.refreshed === true ? "inline-flex min-h-7 items-center rounded-md border border-mint/25 bg-mint/10 px-2.5 text-xs font-semibold text-mint" : "inline-flex min-h-7 items-center rounded-md border border-court/25 bg-court/5 px-2.5 text-xs font-semibold text-court"}>
              {tags.refreshed === true ? "완료" : "실패"}
            </span>
            {typeof tags.updatedTags === "number" ? <ResultStat label="태그" value={tags.updatedTags} /> : null}
          </div>
          {typeof tags.errorMessage === "string" ? <div className="mt-2 text-xs text-court">{tags.errorMessage}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AdminActionPanel({ sources, csrfToken }: { sources: SourceRecord[]; csrfToken: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pendingAction, setPendingAction] = useState<AdminAction | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [lastRequest, setLastRequest] = useState<ActionRequestOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: AdminAction) {
    const form = formRef.current;
    if (!form) return;

    const formData = new FormData(form);
    const sourceKey = String(formData.get("sourceKey") ?? "");
    const limit = toNumber(formData.get("limit"), 5);
    const summarizeLimit = toNumber(formData.get("summarizeLimit"), 10);
    const refreshTags = formData.get("refreshTags") === "on";
    const allowVercelCrawling = formData.get("allowVercelCrawling") === "on";
    const requestOptions = {
      action,
      sourceKey: sourceKey || undefined,
      limit,
      summarizeLimit,
      refreshTags: refreshTags || action === "refresh-tags" || action === "ingest-and-summarize",
      allowVercelCrawling,
    };
    setPendingAction(action);
    setError(null);
    setResult(null);
    setLastRequest(requestOptions);

    try {
      const response = await fetch("/api/admin/ingest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          ...requestOptions,
          summarize: action === "ingest-and-summarize",
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      setResult(payload);
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">운영 작업</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">수집·요약 제어</h2>
        </div>
        <span className="inline-flex min-h-8 items-center rounded-md border border-mint/25 bg-mint/10 px-3 text-xs font-semibold text-mint">
          서버 실행
        </span>
      </div>

      <form ref={formRef} className="grid gap-3 md:grid-cols-4">
        <label className="grid gap-1 text-sm font-medium text-ink/72 md:col-span-2">
          수집원
          <select name="sourceKey" defaultValue="" className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
            <option value="">전체 기관</option>
            {sources.map((source) => (
              <option key={source.sourceKey} value={source.sourceKey}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink/72">
          수집 제한
          <input name="limit" type="number" min={1} max={100} defaultValue={5} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink" />
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink/72">
          요약 제한
          <input name="summarizeLimit" type="number" min={1} max={100} defaultValue={10} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink" />
        </label>
        <label className="inline-flex min-h-10 items-center gap-2 rounded-md border border-rule px-3 text-sm font-medium text-ink/72 md:col-span-4">
          <input name="refreshTags" type="checkbox" defaultChecked className="size-4 rounded border-rule text-court" />
          작업 뒤 태그 집계 갱신
        </label>
        <label className="inline-flex min-h-10 items-center gap-2 rounded-md border border-rule px-3 text-sm font-medium text-ink/72 md:col-span-4">
          <input name="allowVercelCrawling" type="checkbox" className="size-4 rounded border-rule text-court" />
          Vercel 직접 수집 허용
        </label>
      </form>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { action: "ingest" as const, icon: Play },
          { action: "ingest-and-summarize" as const, icon: Database },
          { action: "summarize" as const, icon: RefreshCw },
          { action: "refresh-tags" as const, icon: Tags },
        ].map((item) => {
          const Icon = item.icon;
          const pending = pendingAction === item.action;
          return (
            <button
              key={item.action}
              type="button"
              disabled={pendingAction !== null}
              onClick={() => runAction(item.action)}
              className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/40"
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Icon className="size-4" aria-hidden="true" />}
              {pending ? "실행 중" : actionLabel(item.action)}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-court/25 bg-court/5 p-3 text-sm text-court">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4" aria-hidden="true" />
            실행 실패
          </div>
          <p className="mt-1 break-words">{error}</p>
        </div>
      ) : null}

      {result ? (
        <div className="mt-4 rounded-md border border-mint/25 bg-mint/5 p-3 text-sm text-ink/76">
          <div className="flex items-center gap-2 font-semibold text-mint">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            실행 완료
          </div>
          <p className="mt-1">{compactResult(result)}</p>
          {lastRequest ? <div className="mt-3"><RequestSummary options={lastRequest} /></div> : null}
          <StructuredResult result={result} />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-semibold text-ink/62">응답 원문</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-ink p-3 text-xs leading-5 text-white">{JSON.stringify(result, null, 2)}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}
