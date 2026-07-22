function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function attemptSucceeded(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.result === "success") return true;
  if (typeof value.discoveredCount === "number" && value.discoveredCount >= 0 && !value.errorCode) return true;
  return (
    typeof value.status === "number" &&
    value.status >= 200 &&
    value.status < 400 &&
    !value.errorCode &&
    value.result !== "failed"
  );
}

function attemptFailed(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    value.result === "failed" ||
    value.result === "blocked" ||
    value.result === "timeout" ||
    value.blocked === true ||
    value.timeout === true ||
    typeof value.errorCode === "string" ||
    (typeof value.status === "number" && value.status >= 400 && value.strategy !== "robots")
  );
}

function sourceResultSucceeded(value: unknown) {
  if (!isRecord(value)) return false;
  if (numericValue(value.failedCount) > 0) return false;
  if (Array.isArray(value.errors) && value.errors.length > 0) return false;

  const diagnostics = isRecord(value.diagnostics) && Array.isArray(value.diagnostics.attempts)
    ? value.diagnostics.attempts
    : [];
  if (numericValue(value.discoveredCount) > 0 || diagnostics.length === 0) return true;

  const hasSuccessfulAttempt = diagnostics.some(attemptSucceeded);
  const hasFailedAttempt = diagnostics.some(attemptFailed);
  return hasSuccessfulAttempt || !hasFailedAttempt;
}

export function ingestResultSucceeded(value: unknown) {
  if (!isRecord(value) || value.mode !== "database" || !Array.isArray(value.results) || value.results.length === 0) {
    return false;
  }
  return value.results.every(sourceResultSucceeded);
}

export function ingestResultFailureMessage(value: unknown) {
  if (!isRecord(value)) return "Ingestion returned an invalid result.";
  if (value.mode !== "database") return `Ingestion did not run in database mode (mode=${String(value.mode ?? "unknown")}).`;
  if (!Array.isArray(value.results) || value.results.length === 0) return "Ingestion returned no source results.";

  const failures = value.results.flatMap((result) => {
    if (sourceResultSucceeded(result)) return [];
    if (!isRecord(result)) return ["unknown source: invalid result"];
    const sourceKey = typeof result.sourceKey === "string" ? result.sourceKey : "unknown source";
    const errors = Array.isArray(result.errors) ? result.errors.filter((error): error is string => typeof error === "string") : [];
    const diagnostics = isRecord(result.diagnostics) && Array.isArray(result.diagnostics.attempts)
      ? result.diagnostics.attempts
      : [];
    const diagnosticError = [...diagnostics].reverse().find(attemptFailed);
    const diagnosticMessage = isRecord(diagnosticError)
      ? String(diagnosticError.errorMessage ?? diagnosticError.errorCode ?? diagnosticError.status ?? "discovery failed")
      : undefined;
    return [`${sourceKey}: ${errors[0] ?? diagnosticMessage ?? "incomplete source run"}`];
  });

  return `Ingestion did not complete successfully. ${failures.join("; ")}`;
}
