"use client";

import { useState } from "react";
import { Check, LoaderCircle, LockKeyhole } from "lucide-react";
import type { P5OwnerRole } from "@/lib/admin/p5/types";

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
      <div className="min-w-0"><p className="font-semibold capitalize text-ink">{role} owner</p><p className="text-xs text-ink/50">{isApproved ? "Current digest approval recorded" : permitted ? "Current session is bound to this role" : bindingValid ? "Current session is not bound to this role" : "Owner binding configuration is invalid"}</p></div>
      {permitted ? <button type="button" onClick={approve} disabled={isApproved || state === "saving"} className="focus-ring inline-flex min-h-9 min-w-24 items-center justify-center gap-2 rounded-md border border-rule px-3 text-xs font-semibold text-ink/70 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-55">
        {state === "saving" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
        {isApproved ? "Approved" : state === "failed" ? "Retry" : "Approve"}
      </button> : <span className="inline-flex min-h-9 items-center gap-2 text-xs font-semibold text-ink/45"><LockKeyhole className="size-4" aria-hidden="true" />Blocked</span>}
    </div>
  );
}
