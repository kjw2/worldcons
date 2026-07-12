import type { AdminCommandFailureDisposition, AdminCommandRunStatus } from "@/lib/admin/command-control-plane/types";

const RETRYABLE_ERROR_CLASSES = new Set([
  "rate_limit",
  "timeout",
  "network",
  "upstream_unavailable",
  "lease_expired",
  "summary.rate_limited",
  "summary.timeout",
  "summary.network_error",
]);

export function isActiveAdminCommandRunStatus(status: AdminCommandRunStatus) {
  return status === "queued" || status === "running" || status === "retry_wait";
}

export function classifyAdminCommandFailure(errorClass: string): AdminCommandFailureDisposition {
  return RETRYABLE_ERROR_CLASSES.has(errorClass.trim().toLowerCase()) ? "retryable" : "terminal";
}

export function adminCommandRetryBackoffSeconds(attemptNumber: number, baseSeconds: number, capSeconds: number) {
  const attempt = Math.max(1, Math.trunc(attemptNumber));
  const base = Math.max(1, Math.trunc(baseSeconds));
  const cap = Math.max(base, Math.trunc(capSeconds));
  return Math.min(cap, base * 2 ** (attempt - 1));
}
