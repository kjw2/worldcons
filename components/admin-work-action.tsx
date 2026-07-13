"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, Rocket, RotateCcw, Send, Undo2 } from "lucide-react";
import type { AdminWorkAction } from "@/lib/admin/p4/actions";

const actionCopy: Record<AdminWorkAction, { label: string; prompt: string; confirmation?: string }> = {
  abort: { label: "중단 요청", prompt: "중단을 요청하는 이유를 입력하세요:" },
  retry: { label: "재시도", prompt: "이 작업을 재시도하는 이유를 입력하세요:" },
  "candidate-retry": { label: "후보 재등록", prompt: "이 후보를 다시 등록하는 이유를 입력하세요:" },
  publish: { label: "공개", prompt: "공개 사유를 입력하세요:", confirmation: "publish" },
  withdraw: { label: "공개 철회", prompt: "공개 철회 사유를 입력하세요:", confirmation: "withdraw" },
};

function ActionIcon({ action, pending }: { action: AdminWorkAction; pending: boolean }) {
  if (pending) return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
  if (action === "abort") return <Ban className="size-3.5" aria-hidden="true" />;
  if (action === "retry") return <RotateCcw className="size-3.5" aria-hidden="true" />;
  if (action === "candidate-retry") return <Undo2 className="size-3.5" aria-hidden="true" />;
  if (action === "publish") return <Rocket className="size-3.5" aria-hidden="true" />;
  return <Send className="size-3.5" aria-hidden="true" />;
}

function idempotencyKey(action: AdminWorkAction, id: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `p4.${action}.${id}.${random}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 200);
}

export function AdminWorkActionButton({
  kind,
  id,
  action,
  csrfToken,
  disabledReason,
}: {
  kind: string;
  id: string;
  action: AdminWorkAction | null;
  csrfToken: string;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!action) {
    return (
      <span className="inline-flex min-h-8 items-center text-xs font-medium text-ink/45" title={disabledReason ?? "현재 안전하게 실행할 수 있는 조치가 없습니다."}>
        실행 가능한 조치 없음
        <span className="sr-only">: {disabledReason ?? "현재 안전하게 실행할 수 있는 조치가 없습니다."}</span>
      </span>
    );
  }

  async function run() {
    if (!action || pending) return;
    const copy = actionCopy[action];
    const reason = window.prompt(copy.prompt)?.trim();
    if (!reason) return;
    if (reason.length < 5) {
      setMessage("사유를 5자 이상 입력하세요.");
      return;
    }
    if (copy.confirmation && !window.confirm(`P3 공개 권한으로 이 기사를 ${copy.label} 처리하시겠습니까?`)) return;

    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/work/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          action,
          reason,
          confirmation: copy.confirmation ?? "acknowledged",
          idempotencyKey: idempotencyKey(action, id),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setMessage("조치가 접수되었습니다.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "조치에 실패했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="focus-ring inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/70 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ActionIcon action={action} pending={pending} />
        {pending ? "처리 중" : actionCopy[action].label}
      </button>
      {message ? <span className="max-w-48 break-words text-xs leading-4 text-court" role="status">{message}</span> : null}
    </div>
  );
}
