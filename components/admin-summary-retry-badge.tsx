"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeMessage(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.summarize)) {
    return "재요약 요청을 보냈습니다.";
  }

  const summary = payload.summarize;
  if (summary.status === "summarized") return "재요약 완료";
  if (summary.status === "failed") {
    return typeof summary.errorMessage === "string" ? summary.errorMessage : "재요약 실패";
  }
  if (summary.status === "skipped") {
    return typeof summary.reason === "string" ? summary.reason : "재요약 조건 불충족";
  }
  if (summary.status === "not_found") return "자료를 찾을 수 없습니다.";
  return "재요약 요청을 보냈습니다.";
}

export function AdminSummaryRetryBadge({
  articleId,
  slug,
  secret,
  onSummarized,
}: {
  articleId?: string;
  slug: string;
  secret?: string | null;
  onSummarized?: (slug: string) => void;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function retrySummary() {
    if (isPending) return;

    const endpoint = secret ? `/api/admin/ingest?secret=${encodeURIComponent(secret)}` : "/api/admin/ingest";
    setIsPending(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "retry-summary",
          articleId,
          slug,
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const nextMessage = summarizeMessage(payload);
      setMessage(nextMessage);
      setIsError(!/완료|요청/.test(nextMessage));
      if (isRecord(payload) && isRecord(payload.summarize) && payload.summarize.status === "summarized") {
        setIsPending(false);
        onSummarized?.(slug);
        window.setTimeout(() => router.refresh(), 250);
        return;
      }
      router.refresh();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={retrySummary}
        disabled={isPending}
        title="클릭하면 이 자료 1건만 다시 요약합니다."
        className="focus-ring inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-court/25 bg-court/5 px-2.5 text-xs font-semibold text-court transition hover:bg-court/10 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="size-3.5" aria-hidden="true" />}
        {isPending ? "재요약 중" : "요약 실패"}
      </button>
      {message ? (
        <span className={`max-w-44 text-xs leading-5 ${isError ? "text-court" : "text-mint"}`}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
