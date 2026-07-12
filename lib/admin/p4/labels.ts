import type { AdminWorkStage, AdminWorkStateLabel } from "@/lib/admin/p4/types";

const failureStates = new Set(["failed", "aborted", "lease_expired", "dead_letter", "anomaly", "active"]);
const warningStates = new Set(["queued", "retry_wait", "needs_review", "in_review", "pending", "cancel_requested", "withdrawn"]);
const successStates = new Set(["succeeded", "complete", "approved", "published", "delivered", "fetched"]);
const infoStates = new Set(["running", "processing", "source_text_ready", "ready", "retrying"]);

export function adminStateLabel(value?: string | null): AdminWorkStateLabel {
  const normalized = value?.trim() || "not linked";
  const key = normalized.toLowerCase();
  return {
    value: normalized,
    tone: failureStates.has(key)
      ? "danger"
      : warningStates.has(key)
        ? "warning"
        : successStates.has(key)
          ? "success"
          : infoStates.has(key)
            ? "info"
            : "neutral",
  };
}

export function commandStage(commandType: string): AdminWorkStage {
  const value = commandType.toLowerCase();
  if (/publish|cache|outbox/.test(value)) return "publish";
  if (/review|article|glossary/.test(value)) return "review";
  if (/summar|derived|tag|llm/.test(value)) return "process";
  return "collect";
}

export function lifecycleStage(processing?: string | null, review?: string | null): AdminWorkStage {
  if (review && review !== "unreviewed") return "review";
  return processing && processing !== "not_ready" ? "process" : "collect";
}
