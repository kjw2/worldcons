"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, Rocket, RotateCcw, Send, Undo2 } from "lucide-react";
import type { AdminWorkAction } from "@/lib/admin/p4/actions";

const actionCopy: Record<AdminWorkAction, { label: string; prompt: string; confirmation?: string }> = {
  abort: { label: "Request abort", prompt: "Reason for requesting an abort:" },
  retry: { label: "Retry", prompt: "Reason for retrying this terminal run:" },
  "candidate-retry": { label: "Requeue", prompt: "Reason for requeueing this candidate:" },
  publish: { label: "Publish", prompt: "Publication reason:", confirmation: "publish" },
  withdraw: { label: "Withdraw", prompt: "Withdrawal reason:", confirmation: "withdraw" },
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
      <span className="inline-flex min-h-8 items-center text-xs font-medium text-ink/45" title={disabledReason ?? "No safe action is available."}>
        No safe action
        <span className="sr-only">: {disabledReason ?? "No safe action is available."}</span>
      </span>
    );
  }

  async function run() {
    if (!action || pending) return;
    const copy = actionCopy[action];
    const reason = window.prompt(copy.prompt)?.trim();
    if (!reason) return;
    if (reason.length < 5) {
      setMessage("A reason of at least 5 characters is required.");
      return;
    }
    if (copy.confirmation && !window.confirm(`${copy.label} this article through P3 publication authority?`)) return;

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
      setMessage("Action accepted.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
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
        {pending ? "Working" : actionCopy[action].label}
      </button>
      {message ? <span className="max-w-48 break-words text-xs leading-4 text-court" role="status">{message}</span> : null}
    </div>
  );
}
