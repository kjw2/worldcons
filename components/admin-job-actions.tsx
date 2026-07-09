"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, XCircle } from "lucide-react";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canCancel(status: string) {
  return status === "queued" || status === "running" || status === "cancel_requested";
}

function canRetry(status: string) {
  return status === "failed" || status === "cancelled";
}

function resultMessage(action: "cancel" | "retry", payload: unknown) {
  if (!isRecord(payload)) return action === "cancel" ? "취소 요청을 보냈습니다." : "재시도 작업을 등록했습니다.";
  if (action === "cancel" && isRecord(payload.job) && typeof payload.job.status === "string") {
    return payload.job.status === "cancel_requested" ? "실행 중인 작업에 취소 요청을 남겼습니다." : "작업을 취소했습니다.";
  }
  if (action === "retry" && isRecord(payload.job) && typeof payload.job.id === "string") {
    return "재시도 작업을 대기열에 등록했습니다.";
  }
  return action === "cancel" ? "취소 요청을 보냈습니다." : "재시도 작업을 등록했습니다.";
}

export function AdminJobActions({
  jobId,
  status,
  csrfToken,
}: {
  jobId: string;
  status: string;
  csrfToken: string;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<"cancel" | "retry" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: "cancel" | "retry") {
    const reason = action === "cancel" ? "관리자 작업 큐 화면에서 취소 요청" : "관리자 작업 큐 화면에서 재시도 요청";
    if (action === "cancel" && !window.confirm("이 작업을 취소할까요? 실행 중인 작업은 취소 요청 상태로만 표시됩니다.")) return;
    if (action === "retry" && !window.confirm("이 작업을 같은 옵션으로 재시도할까요?")) return;

    setPendingAction(action);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch(`/api/admin/jobs/${encodeURIComponent(jobId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action, reason }),
      });
      const payload: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const responseError = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(responseError);
      }

      setMessage(resultMessage(action, payload));
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setPendingAction(null);
    }
  }

  if (!canCancel(status) && !canRetry(status)) {
    return <span className="text-xs text-ink/45">액션 없음</span>;
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5">
        {canCancel(status) ? (
          <button
            type="button"
            onClick={() => runAction("cancel")}
            disabled={pendingAction !== null}
            className="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === "cancel" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <XCircle className="size-3.5" aria-hidden="true" />}
            취소
          </button>
        ) : null}
        {canRetry(status) ? (
          <button
            type="button"
            onClick={() => runAction("retry")}
            disabled={pendingAction !== null}
            className="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === "retry" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="size-3.5" aria-hidden="true" />}
            재시도
          </button>
        ) : null}
      </div>
      {message ? <div className="break-words text-xs leading-5 text-mint">{message}</div> : null}
      {error ? <div className="break-words text-xs leading-5 text-court">{error}</div> : null}
    </div>
  );
}
