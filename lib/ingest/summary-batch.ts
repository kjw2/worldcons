export const DEFAULT_SUMMARY_RETRY_DELAY_MS = 65_000;
export const MAX_SUMMARY_RETRY_DELAY_MS = 5 * 60 * 1000;

interface SummaryCandidateLike {
  id?: string | null;
  source_key?: string | null;
  created_at?: string | null;
}

interface SummaryBatchResultLike {
  mode?: string;
  status?: string;
  failedCount?: number;
  deferredCount?: number;
  stoppedReason?: string;
  limitReached?: boolean;
}

function asSummaryBatchResult(value: unknown): SummaryBatchResultLike {
  return typeof value === "object" && value !== null ? (value as SummaryBatchResultLike) : {};
}

function timestamp(value?: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function candidateOrder(a: SummaryCandidateLike, b: SummaryCandidateLike) {
  return timestamp(a.created_at) - timestamp(b.created_at) || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export function orderSummaryCandidatesRoundRobin<T extends SummaryCandidateLike>(candidates: T[]) {
  const grouped = new Map<string, T[]>();

  for (const candidate of candidates) {
    const sourceKey = candidate.source_key?.trim() || "__unknown__";
    const rows = grouped.get(sourceKey) ?? [];
    rows.push(candidate);
    grouped.set(sourceKey, rows);
  }

  const sources = Array.from(grouped.entries())
    .map(([sourceKey, rows]) => ({ sourceKey, rows: rows.sort(candidateOrder) }))
    .sort((a, b) => candidateOrder(a.rows[0] ?? {}, b.rows[0] ?? {}) || a.sourceKey.localeCompare(b.sourceKey));
  const ordered: T[] = [];

  for (let index = 0; ; index += 1) {
    let added = false;
    for (const source of sources) {
      const candidate = source.rows[index];
      if (!candidate) continue;
      ordered.push(candidate);
      added = true;
    }
    if (!added) break;
  }

  return ordered;
}

export function isGlobalSummaryBackoff(message?: string) {
  const lowered = message?.toLowerCase() ?? "";
  return (
    lowered.includes(" 429") ||
    lowered.includes("too many requests") ||
    lowered.includes("rate limit") ||
    lowered.includes("quota") ||
    lowered.includes("no gemini routes are locally available")
  );
}

export function summaryRetryDelayMs(message: string | undefined, retryIndex = 0, baseDelayMs = DEFAULT_SUMMARY_RETRY_DELAY_MS) {
  const parsedDelays = Array.from((message ?? "").matchAll(/retry\s+(?:after|in)\s+([0-9.]+)\s*(ms|s|seconds?)/gi))
    .map((match) => {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) return 0;
      return match[2].toLowerCase() === "ms" ? value : value * 1000;
    })
    .filter((value) => value > 0);
  const providerDelayMs = parsedDelays.length > 0 ? Math.max(...parsedDelays) + 2_000 : 0;
  const boundedBaseDelayMs = Math.min(MAX_SUMMARY_RETRY_DELAY_MS, Math.max(1_000, Math.floor(baseDelayMs)));
  const exponentialDelayMs = boundedBaseDelayMs * 2 ** Math.max(0, retryIndex);

  return Math.min(MAX_SUMMARY_RETRY_DELAY_MS, Math.max(providerDelayMs, exponentialDelayMs));
}

export function summaryBatchWasDeferred(value: unknown) {
  const result = asSummaryBatchResult(value);
  return (result.deferredCount ?? 0) > 0 || Boolean(result.stoppedReason);
}

export function summaryBatchHasHardFailure(value: unknown) {
  const result = asSummaryBatchResult(value);
  if (result.mode && result.mode !== "database") return true;
  if (result.status === "failed") return true;
  return (result.failedCount ?? 0) > (result.deferredCount ?? 0);
}

export function summaryBatchNeedsFollowUp(value: unknown) {
  const result = asSummaryBatchResult(value);
  return summaryBatchWasDeferred(result) || result.limitReached === true;
}

export function summaryBatchFailureMessage(value: unknown) {
  const result = asSummaryBatchResult(value);
  const details = [
    `failed=${result.failedCount ?? 0}`,
    `deferred=${result.deferredCount ?? 0}`,
    `limitReached=${result.limitReached === true}`,
  ];
  const reason = result.stoppedReason?.trim();
  return `Summary batch incomplete (${details.join(", ")})${reason ? `: ${reason.slice(0, 500)}` : "."}`;
}
