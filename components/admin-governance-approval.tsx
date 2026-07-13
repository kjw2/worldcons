"use client";

import { useState } from "react";
import { Check, LoaderCircle, LockKeyhole } from "lucide-react";
import type { P5OwnerRole } from "@/lib/admin/p5/types";

const roleLabels: Record<P5OwnerRole, string> = {
  operations: "운영",
  data: "데이터",
  security: "보안",
};

export function AdminGovernanceApproval({ role, approved, permitted, bindingValid, csrfToken, evidenceDigest, observationStart, observationEnd }: { role: P5OwnerRole; approved: boolean; permitted: boolean; bindingValid: boolean; csrfToken: string; evidenceDigest: string; observationStart: string; observationEnd: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const isApproved = approved || state === "saved";

  async function approve() {
    setState("saving");
    try {
      const response = await fetch("/api/admin/governance", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "approve", role, evidenceDigest, observationStart, observationEnd }),
      });
      setState(response.ok ? "saved" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-rule py-2 last:border-b-0">
      <div className="min-w-0"><p className="font-semibold text-ink">{roleLabels[role]} 담당자</p><p className="text-xs text-ink/50">{isApproved ? "현재 근거 묶음에 대한 승인이 기록되었습니다" : permitted ? "현재 세션이 이 역할에 연결되어 있습니다" : bindingValid ? "현재 세션은 이 역할에 연결되어 있지 않습니다" : "담당자 연결 설정이 올바르지 않습니다"}</p></div>
      {permitted ? <button type="button" onClick={approve} disabled={isApproved || state === "saving"} className="focus-ring inline-flex min-h-9 min-w-24 items-center justify-center gap-2 rounded-md border border-rule px-3 text-xs font-semibold text-ink/70 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-55">
        {state === "saving" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
        {isApproved ? "승인됨" : state === "failed" ? "다시 시도" : "승인"}
      </button> : <span className="inline-flex min-h-9 items-center gap-2 text-xs font-semibold text-ink/45"><LockKeyhole className="size-4" aria-hidden="true" />승인 불가</span>}
    </div>
  );
}
