"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { adminStateText } from "@/lib/admin/p4/labels";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeMessage(payload: unknown) {
  if (isRecord(payload) && payload.mode === "queued" && isRecord(payload.job)) {
    const status = typeof payload.job.status === "string" ? payload.job.status : "queued";
    return `재요약 작업 등록 (${adminStateText(status)})`;
  }
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
  csrfToken,
  onSummarized,
}: {
  articleId?: string;
  slug: string;
  csrfToken: string;
  onSummarized?: (slug: string) => void;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function retrySummary() {
    if (isPending) return;

    setIsPending(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch("/api/admin/ingest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
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
      setIsError(!/완료|요청|등록/.test(nextMessage));
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
        {isPending ? "등록 중" : "요약 실패"}
      </button>
      {message ? (
        <span className={`max-w-44 text-xs leading-5 ${isError ? "text-court" : "text-mint"}`}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
