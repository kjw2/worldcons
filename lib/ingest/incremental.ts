export const INCREMENTAL_SOURCE_KEYS = [
  "de-bverfg",
  "us-scotus",
  "fr-conseil-constitutionnel",
  "es-tribunal-constitucional",
] as const;

export type IncrementalSourceKey = (typeof INCREMENTAL_SOURCE_KEYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_SLACK_DAYS = 2;

export function isIncrementalSourceKey(value: string | undefined): value is IncrementalSourceKey {
  return Boolean(value && (INCREMENTAL_SOURCE_KEYS as readonly string[]).includes(value));
}

export function incrementalRangeFloorDays(sourceKey: IncrementalSourceKey) {
  if (sourceKey === "de-bverfg") return 60;
  if (sourceKey === "es-tribunal-constitucional") return 180;
  return 14;
}

export function incrementalRangeCapDays(sourceKey: IncrementalSourceKey, floorDays: number) {
  if (sourceKey === "es-tribunal-constitucional") return 730;
  if (sourceKey === "de-bverfg") return Math.max(floorDays, 90);
  return Math.max(floorDays, 30);
}

export function incrementalRangeDaysFromCheckpoint(input: {
  sourceKey: IncrementalSourceKey;
  floorDays: number;
  lastVerifiedPublishedAt?: string | null;
  lastSuccessfulRunAt?: string | null;
  now?: number;
}) {
  const cap = incrementalRangeCapDays(input.sourceKey, input.floorDays);
  const floor = Math.min(Math.max(1, input.floorDays), cap);
  const anchor = input.lastVerifiedPublishedAt || input.lastSuccessfulRunAt;
  if (!anchor) return floor;
  const timestamp = Date.parse(anchor);
  if (!Number.isFinite(timestamp)) return floor;
  const daysSince = Math.max(1, Math.ceil(((input.now ?? Date.now()) - timestamp) / DAY_MS));
  return Math.min(Math.max(floor, daysSince + RANGE_SLACK_DAYS), cap);
}

export function incrementalJobOptionsForSource(sourceKey: IncrementalSourceKey) {
  return {
    action: "ingest" as const,
    sourceKey,
    limit: 20,
    rangeDays: incrementalRangeFloorDays(sourceKey),
    refreshExisting: true,
    summarizeLimit: 20,
    summarize: false,
    refreshTags: false,
    allowVercelCrawling: false,
    articleId: null,
    slug: null,
  };
}

export function ingestSourceOutcomeLine(result: {
  sourceKey: string;
  outcome?: string;
  discoveredCount?: number;
  discoveredBeforeFilterCount?: number;
  attemptedCount?: number;
  verifiedSourceTextCount?: number;
  recordsAdded?: number;
  refreshedCount?: number;
  unchangedCount?: number;
  uncollectedCandidates?: unknown[];
  uncollectedCount?: number;
  deferredBackoffCount?: number;
  blocked403Count?: number;
  skippedOutOfRangeCount?: number;
  skippedNonConstitutionalCount?: number;
  revisionRecheckCount?: number;
  circuitBroken?: boolean;
  playwrightEscalated?: boolean;
  spainSourceTextPromotedCount?: number;
}) {
  return {
    source: result.sourceKey,
    outcome: result.outcome ?? null,
    discovered: result.discoveredCount ?? 0,
    discoveredBeforeFilter: result.discoveredBeforeFilterCount ?? result.discoveredCount ?? 0,
    attempted: result.attemptedCount ?? 0,
    verified: result.verifiedSourceTextCount ?? 0,
    added: result.recordsAdded ?? 0,
    refreshed: result.refreshedCount ?? 0,
    unchanged: result.unchangedCount ?? 0,
    uncollected: result.uncollectedCount ?? result.uncollectedCandidates?.length ?? 0,
    deferred: result.deferredBackoffCount ?? 0,
    blocked403: result.blocked403Count ?? 0,
    outOfRange: result.skippedOutOfRangeCount ?? 0,
    nonConstitutional: result.skippedNonConstitutionalCount ?? 0,
    revisionRecheck: result.revisionRecheckCount ?? 0,
    circuitBroken: result.circuitBroken === true,
    playwrightEscalated: result.playwrightEscalated === true,
    sourceTextPromoted: result.spainSourceTextPromotedCount ?? 0,
  };
}
