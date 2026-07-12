export const ADMIN_COMMAND_ERROR_CODES = [
  "unavailable",
  "invalid_input",
  "not_found",
  "active_duplicate",
  "stale_fence",
  "lease_lost",
  "aborted",
  "not_retryable",
  "unsafe_data",
  "conflict",
  "internal",
] as const;

export type AdminCommandErrorCode = (typeof ADMIN_COMMAND_ERROR_CODES)[number];

export interface AdminCommandError {
  code: AdminCommandErrorCode;
  message: string;
  retryable: boolean;
  unavailable?: boolean;
}

const ERROR_MESSAGES: Record<AdminCommandErrorCode, string> = {
  unavailable: "The administrator command control plane is unavailable.",
  invalid_input: "The administrator command request is invalid.",
  not_found: "The administrator command record was not found.",
  active_duplicate: "An equivalent administrator command is already active.",
  stale_fence: "The worker fencing token is stale.",
  lease_lost: "The worker lease has expired or was reclaimed.",
  aborted: "The administrator command run was aborted.",
  not_retryable: "The administrator command run cannot be retried.",
  unsafe_data: "The administrator command data is not safe to persist.",
  conflict: "The administrator command transition conflicts with current state.",
  internal: "The administrator command operation failed.",
};

export function adminCommandError(code: AdminCommandErrorCode): AdminCommandError {
  return {
    code,
    message: ERROR_MESSAGES[code],
    retryable: code === "unavailable" || code === "lease_lost" || code === "internal",
    unavailable: code === "unavailable" || undefined,
  };
}

function databaseErrorText(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  return [candidate.code, candidate.message, candidate.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toUpperCase();
}

export function mapAdminCommandDatabaseError(error: unknown): AdminCommandError {
  const text = databaseErrorText(error);
  if (/42P01|42883|PGRST202|SCHEMA CACHE|ADMIN_COMMAND/.test(text) && !text.includes("ADMIN_QUEUE_")) {
    return adminCommandError("unavailable");
  }
  if (text.includes("ADMIN_QUEUE_STALE_FENCE")) return adminCommandError("stale_fence");
  if (text.includes("ADMIN_QUEUE_LEASE_LOST")) return adminCommandError("lease_lost");
  if (text.includes("ADMIN_QUEUE_ABORTED")) return adminCommandError("aborted");
  if (text.includes("NOT_FOUND")) return adminCommandError("not_found");
  if (text.includes("ACTIVE_DUPLICATE")) return adminCommandError("active_duplicate");
  if (text.includes("NOT_RETRYABLE")) return adminCommandError("not_retryable");
  if (text.includes("UNSAFE_")) return adminCommandError("unsafe_data");
  if (text.includes("INVALID_") || text.includes("22023")) return adminCommandError("invalid_input");
  if (text.includes("23505") || text.includes("IMMUTABLE_RECORD")) return adminCommandError("conflict");
  return adminCommandError("internal");
}
