function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type IngestSourceOutcome = "success" | "degraded" | "failed";

const IGNORABLE_DIAGNOSTIC_CODES = new Set([
  "SPAIN_HJ_TAIL_PROBE_EMPTY",
  "SPAIN_HJ_PENDING_RECHECK",
  "SCOTUS_REVISION_RECHECK",
  "BVERFG_TRACKED_CANDIDATE_RECHECK",
  "STALE_INGESTION_RUN_RECOVERED",
  "BVERFG_CANDIDATE_RETRY_DEFERRED",
  "REFRESH_QUALITY_REGRESSION_BLOCKED",
]);

function attemptOptional(value: Record<string, unknown>) {
  if (value.optional === true || value.result === "empty") return true;
  return typeof value.errorCode === "string" && IGNORABLE_DIAGNOSTIC_CODES.has(value.errorCode);
}

function attemptSucceeded(value: unknown) {
  if (!isRecord(value) || attemptOptional(value)) return false;
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
  if (!isRecord(value) || attemptOptional(value)) return false;
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

function diagnosticsOf(value: Record<string, unknown>) {
  return isRecord(value.diagnostics) && Array.isArray(value.diagnostics.attempts)
    ? value.diagnostics.attempts
    : [];
}

function sourceResultHardFailed(value: unknown) {
  if (!isRecord(value)) return true;
  if (numericValue(value.failedCount) > 0) return true;
  if (Array.isArray(value.errors) && value.errors.length > 0) return true;

  const diagnostics = diagnosticsOf(value);
  if (numericValue(value.discoveredCount) > 0 || diagnostics.length === 0) return false;

  const hasSuccessfulAttempt = diagnostics.some(attemptSucceeded);
  const hasFailedAttempt = diagnostics.some(attemptFailed);
  return !hasSuccessfulAttempt && hasFailedAttempt;
}

function uncollectedCountOf(value: Record<string, unknown>) {
  if (typeof value.uncollectedCount === "number") return numericValue(value.uncollectedCount);
  return Array.isArray(value.uncollectedCandidates) ? value.uncollectedCandidates.length : 0;
}

export function sourceResultDegraded(value: unknown) {
  if (!isRecord(value) || sourceResultHardFailed(value)) return false;
  if (value.outcome === "degraded" || value.circuitBroken === true) return true;

  const attempted = numericValue(value.attemptedCount);
  const verified = numericValue(value.verifiedSourceTextCount);
  const uncollected = uncollectedCountOf(value);
  if (attempted > 0 && verified === 0 && uncollected > 0) return true;
  if (attempted >= 3 && uncollected / attempted >= 0.5) return true;
  if (value.spainPendingPromotionStale === true) return true;
  return false;
}

export function sourceResultOutcome(value: unknown): IngestSourceOutcome {
  if (isRecord(value) && (value.outcome === "success" || value.outcome === "degraded" || value.outcome === "failed")) {
    return value.outcome;
  }
  if (sourceResultHardFailed(value)) return "failed";
  if (sourceResultDegraded(value)) return "degraded";
  return "success";
}

function sourceResultSucceeded(value: unknown) {
  return sourceResultOutcome(value) === "success";
}

export function ingestResultOutcome(value: unknown): IngestSourceOutcome {
  if (!isRecord(value) || value.mode !== "database" || !Array.isArray(value.results) || value.results.length === 0) {
    return "failed";
  }
  const outcomes = value.results.map(sourceResultOutcome);
  if (outcomes.some((outcome) => outcome === "failed")) return "failed";
  if (outcomes.some((outcome) => outcome === "degraded")) return "degraded";
  return "success";
}

export function ingestResultSucceeded(value: unknown) {
  return ingestResultOutcome(value) === "success";
}

export function ingestProcessExitCode(value: unknown) {
  const outcome = ingestResultOutcome(value);
  if (outcome === "success") return 0;
  if (outcome === "degraded") return 2;
  return 1;
}

export function ingestResultFailureMessage(value: unknown) {
  if (!isRecord(value)) return "Ingestion returned an invalid result.";
  if (value.mode !== "database") return `Ingestion did not run in database mode (mode=${String(value.mode ?? "unknown")}).`;
  if (!Array.isArray(value.results) || value.results.length === 0) return "Ingestion returned no source results.";

  const outcome = ingestResultOutcome(value);
  const failures = value.results.flatMap((result) => {
    const sourceOutcome = sourceResultOutcome(result);
    if (sourceOutcome === "success") return [];
    if (!isRecord(result)) return ["unknown source: invalid result"];
    const sourceKey = typeof result.sourceKey === "string" ? result.sourceKey : "unknown source";
    if (sourceOutcome === "degraded") {
      const uncollected = uncollectedCountOf(result);
      const verified = numericValue(result.verifiedSourceTextCount);
      const attempted = numericValue(result.attemptedCount);
      return [`${sourceKey}: degraded collection (attempted=${attempted}, verified=${verified}, uncollected=${uncollected})`];
    }
    const errors = Array.isArray(result.errors) ? result.errors.filter((error): error is string => typeof error === "string") : [];
    const diagnostics = diagnosticsOf(result);
    const diagnosticError = [...diagnostics].reverse().find(attemptFailed);
    const diagnosticMessage = isRecord(diagnosticError)
      ? String(diagnosticError.errorMessage ?? diagnosticError.errorCode ?? diagnosticError.status ?? "discovery failed")
      : undefined;
    return [`${sourceKey}: ${errors[0] ?? diagnosticMessage ?? "incomplete source run"}`];
  });

  if (outcome === "degraded") {
    return `Ingestion completed in a degraded state. ${failures.join("; ")}`;
  }
  return `Ingestion did not complete successfully. ${failures.join("; ")}`;
}
