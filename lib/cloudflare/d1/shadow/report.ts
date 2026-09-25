import { D1_SHADOW_EVENT_NAME, D1_SHADOW_OUTCOMES, type D1ShadowEvent } from "./events";
import {
  D1_SHADOW_GLOBAL_BLOCKERS,
  D1_SHADOW_SYNC_METHODS,
  d1ShadowComparableMethods,
  d1ShadowSurfaceCoverage,
  isDeferredD1ShadowMethod,
  isKnownD1ShadowSurfaceMethod,
  type D1ShadowSurfaceCoverage,
} from "./coverage";

/**
 * M6.5 pure parity report.
 *
 * Turns raw `worldcons.d1_shadow` events into a deterministic, machine-readable
 * parity report and a conservative gate decision. This module is local evidence
 * tooling only: it never reads or writes D1/Supabase, never emits a hash, diff
 * path, URL, query, metadata payload or row value, and never claims authority.
 *
 * Two gates are deliberately separated:
 * - `m6EvidenceGate` scores ONLY the implemented, non-deferred comparable
 *   methods against explicit thresholds.
 * - `globalGoD1Read` stays `blocked` in M6.5 because M7 search/FTS5/Vectorize
 *   and the two admin RPC snapshots are unresolved, regardless of M6 greens.
 */

export type D1ShadowParityGateStatus = "go_candidate" | "no_go" | "insufficient_evidence";
export type D1ShadowGlobalGateStatus = "blocked" | "ready";

export interface D1ShadowParityThresholds {
  minComparedPerMethod: number;
  maxMismatchRate: number;
  maxErrorRate: number;
  maxTimeoutRate: number;
}

export const D1_SHADOW_PARITY_DEFAULT_THRESHOLDS: D1ShadowParityThresholds = {
  minComparedPerMethod: 20,
  maxMismatchRate: 0,
  maxErrorRate: 0,
  maxTimeoutRate: 0,
};

export const D1_SHADOW_PARITY_THRESHOLD_PROVENANCE = "proposed_local_defaults" as const;

/** Below this many latency samples, latency quantiles are withheld. */
export const D1_SHADOW_PARITY_MIN_LATENCY_SAMPLES = 5;

export const D1_SHADOW_PARITY_SCHEMA = "worldcons.d1_shadow.parity_report.v1" as const;

export interface D1ShadowLatencyStats {
  sampleCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface D1ShadowAggregate {
  events: number;
  compared: number;
  matched: number;
  mismatched: number;
  errors: number;
  timeouts: number;
  skipped: number;
  compareDisabled: number;
  readSuccesses: number;
  diffPathPresent: number;
  primaryShadowCountMismatch: number;
  hashMismatch: number;
  orderOnlyMismatch: number;
  reasonCounts: Record<string, number>;
  errorCodeCounts: Record<string, number>;
  latencySampleCount: number;
  latency: D1ShadowLatencyStats | null;
}

export interface D1ShadowMethodStats extends D1ShadowAggregate {
  surface: string;
  method: string;
  deferred: boolean;
  comparable: boolean;
  databases: string[];
  tables: string[];
}

export interface D1ShadowSurfaceStats extends D1ShadowAggregate {
  surface: string;
  databases: string[];
  tables: string[];
  methods: D1ShadowMethodStats[];
}

export interface D1ShadowMethodGate {
  surface: string;
  method: string;
  compared: number;
  mismatched: number;
  errors: number;
  timeouts: number;
  mismatchRate: number;
  errorRate: number;
  timeoutRate: number;
  status: D1ShadowParityGateStatus;
  reasons: string[];
}

export interface D1ShadowParityReport {
  schema: typeof D1_SHADOW_PARITY_SCHEMA;
  milestone: "M6.5";
  authority: {
    supabase: "sole_read_authority";
    d1: "read_only_shadow";
    authoritySwitch: false;
    goD1ReadClaimed: false;
  };
  source: {
    totalLines: number;
    blankLines: number;
    parsedEvents: number;
    malformedJsonLines: number;
    structurallyInvalidEvents: number;
    invalidEvents: number;
    duplicatePolicy: "preserve_every_sample_no_event_id";
  };
  invalidReasons: Record<string, number>;
  thresholds: D1ShadowParityThresholds & { provenance: typeof D1_SHADOW_PARITY_THRESHOLD_PROVENANCE };
  coverage: D1ShadowSurfaceCoverage[];
  syncMethods: readonly { surface: string; method: string; treatment: string }[];
  deferredMethods: { surface: string; method: string; blockerId: string | null }[];
  totals: D1ShadowAggregate;
  surfaces: D1ShadowSurfaceStats[];
  m6EvidenceGate: {
    status: D1ShadowParityGateStatus;
    reasons: string[];
    minComparedPerMethod: number;
    methods: D1ShadowMethodGate[];
  };
  globalGoD1Read: {
    status: D1ShadowGlobalGateStatus;
    ready: boolean;
    blockers: readonly { id: string; description: string }[];
    reasons: string[];
  };
  notes: string[];
}

export interface BuildD1ShadowParityReportOptions {
  /** Parsed-but-untrusted JSON values in input order. */
  events: readonly unknown[];
  /** Lines that failed `JSON.parse` (counted, never included). */
  malformedJsonLines?: number;
  /** Blank/whitespace-only lines that were ignored. */
  blankLines?: number;
  /** Explicit thresholds; missing fields fall back to the proposed local defaults. */
  thresholds?: Partial<D1ShadowParityThresholds>;
}

export interface D1ShadowNdjsonParseResult {
  events: unknown[];
  malformedJsonLines: number;
  blankLines: number;
  totalLines: number;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_:.\-]{1,80}$/;
const READ_OUTCOMES = new Set(["success", "error", "timeout"]);
const OUTCOMES = new Set<string>(D1_SHADOW_OUTCOMES);
const METHOD_SEPARATOR = "\u0000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isNullableLatency(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/** Sanitizes a free-form classify code so no authored text can leak into a report. */
export function sanitizeD1ShadowCode(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_CODE.test(value) ? value : "unsanitized_code";
}

/** Sanitizes a database/table identifier, dropping anything that is not a bare name. */
export function sanitizeD1ShadowIdentifier(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_IDENTIFIER.test(value) ? value : null;
}

function invalid(code: string): { ok: false; code: string } {
  return { ok: false, code };
}

/**
 * Validates one raw value as a `worldcons.d1_shadow` event, including internal
 * consistency. Impossible combinations (for example `matched` with
 * `compared=false`, or an unknown surface/method) fail closed.
 */
export function validateD1ShadowEvent(
  value: unknown,
): { ok: true; event: D1ShadowEvent } | { ok: false; code: string } {
  if (!isRecord(value)) return invalid("event_not_object");
  if (value.event !== D1_SHADOW_EVENT_NAME) return invalid("event_name_mismatch");

  const surface = value.surface;
  if (typeof surface !== "string" || !SAFE_IDENTIFIER.test(surface)) return invalid("invalid_surface");
  const method = value.method;
  if (typeof method !== "string" || !SAFE_IDENTIFIER.test(method)) return invalid("invalid_method");
  if (!isKnownD1ShadowSurfaceMethod(surface, method)) return invalid("unknown_surface_method");

  const outcome = value.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return invalid("invalid_outcome");

  const compared = value.compared;
  if (typeof compared !== "boolean") return invalid("invalid_compared");

  if (!isNullableString(value.reason)) return invalid("invalid_reason");
  if (!isNullableString(value.errorCode)) return invalid("invalid_error_code");
  if (!isNullableString(value.db)) return invalid("invalid_db");
  if (!Array.isArray(value.tables) || value.tables.some((table) => typeof table !== "string")) {
    return invalid("invalid_tables");
  }
  if (!isNullableCount(value.primaryCount) || !isNullableCount(value.shadowCount)) {
    return invalid("invalid_count");
  }
  if (!isNullableString(value.primaryHash) || !isNullableString(value.shadowHash)) {
    return invalid("invalid_hash");
  }
  if (!isNullableString(value.diffPath)) return invalid("invalid_diff_path");
  if (value.orderMatches !== null && typeof value.orderMatches !== "boolean") {
    return invalid("invalid_order_matches");
  }
  const readOutcome = value.readOutcome;
  if (readOutcome !== null && (typeof readOutcome !== "string" || !READ_OUTCOMES.has(readOutcome))) {
    return invalid("invalid_read_outcome");
  }
  if (!isNullableLatency(value.latencyMs)) return invalid("invalid_latency");

  const comparedOutcome = outcome === "matched" || outcome === "mismatched";
  if (comparedOutcome !== compared) return invalid("compared_outcome_conflict");
  if (compared) {
    if (readOutcome !== "success") return invalid("compared_read_outcome_conflict");
    if (value.primaryHash === null || value.shadowHash === null) return invalid("compared_missing_hash");
    if (value.primaryCount === null || value.shadowCount === null) return invalid("compared_missing_count");
    if (outcome === "matched" && value.primaryHash !== value.shadowHash) return invalid("matched_hash_conflict");
    if (outcome === "mismatched" && value.primaryHash === value.shadowHash) {
      return invalid("mismatched_hash_conflict");
    }
  }
  if (outcome === "disabled" && value.reason !== "compare_disabled") return invalid("disabled_reason_conflict");
  if (outcome === "error" && readOutcome !== "error") return invalid("error_read_outcome_conflict");
  if (outcome === "timeout" && readOutcome !== "timeout") return invalid("timeout_read_outcome_conflict");

  return { ok: true, event: value as unknown as D1ShadowEvent };
}

/**
 * Splits NDJSON text into raw JSON values, counting (not swallowing) malformed
 * lines so the gate can fail closed. Blank lines are ignored.
 */
export function parseD1ShadowNdjson(text: string): D1ShadowNdjsonParseResult {
  const lines = text.split(/\r?\n/);
  const events: unknown[] = [];
  let malformedJsonLines = 0;
  let blankLines = 0;
  let totalLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      blankLines += 1;
      continue;
    }
    totalLines += 1;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      malformedJsonLines += 1;
    }
  }
  return { events, malformedJsonLines, blankLines, totalLines };
}

interface MutableAggregate {
  events: number;
  compared: number;
  matched: number;
  mismatched: number;
  errors: number;
  timeouts: number;
  skipped: number;
  compareDisabled: number;
  readSuccesses: number;
  diffPathPresent: number;
  primaryShadowCountMismatch: number;
  hashMismatch: number;
  orderOnlyMismatch: number;
  reasonCounts: Map<string, number>;
  errorCodeCounts: Map<string, number>;
  latencies: number[];
}

interface MutableMethod {
  surface: string;
  method: string;
  deferred: boolean;
  deferredBlockerId: string | null;
  comparable: boolean;
  aggregate: MutableAggregate;
  databases: Set<string>;
  tables: Set<string>;
}

function emptyAggregate(): MutableAggregate {
  return {
    events: 0,
    compared: 0,
    matched: 0,
    mismatched: 0,
    errors: 0,
    timeouts: 0,
    skipped: 0,
    compareDisabled: 0,
    readSuccesses: 0,
    diffPathPresent: 0,
    primaryShadowCountMismatch: 0,
    hashMismatch: 0,
    orderOnlyMismatch: 0,
    reasonCounts: new Map(),
    errorCodeCounts: new Map(),
    latencies: [],
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map: Map<string, number>): Record<string, number> {
  const entries = [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries);
}

function sortedValues(values: Set<string>): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Deterministic linear-interpolation quantile over an already-sorted array. */
export function d1ShadowQuantile(sortedValues: readonly number[], p: number): number {
  const count = sortedValues.length;
  if (count === 0) return 0;
  if (count === 1) return sortedValues[0];
  const rank = p * (count - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const fraction = rank - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * fraction;
}

function latencyStats(values: readonly number[]): D1ShadowLatencyStats {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    sampleCount: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: sum / sorted.length,
    p50Ms: d1ShadowQuantile(sorted, 0.5),
    p95Ms: d1ShadowQuantile(sorted, 0.95),
    p99Ms: d1ShadowQuantile(sorted, 0.99),
  };
}

function finalizeAggregate(mutable: MutableAggregate): D1ShadowAggregate {
  const latencies = [...mutable.latencies].sort((left, right) => left - right);
  return {
    events: mutable.events,
    compared: mutable.compared,
    matched: mutable.matched,
    mismatched: mutable.mismatched,
    errors: mutable.errors,
    timeouts: mutable.timeouts,
    skipped: mutable.skipped,
    compareDisabled: mutable.compareDisabled,
    readSuccesses: mutable.readSuccesses,
    diffPathPresent: mutable.diffPathPresent,
    primaryShadowCountMismatch: mutable.primaryShadowCountMismatch,
    hashMismatch: mutable.hashMismatch,
    orderOnlyMismatch: mutable.orderOnlyMismatch,
    reasonCounts: sortedCounts(mutable.reasonCounts),
    errorCodeCounts: sortedCounts(mutable.errorCodeCounts),
    latencySampleCount: latencies.length,
    latency: latencies.length >= D1_SHADOW_PARITY_MIN_LATENCY_SAMPLES ? latencyStats(latencies) : null,
  };
}

function mergeAggregate(into: MutableAggregate, from: MutableMethod): void {
  const source = from.aggregate;
  into.events += source.events;
  into.compared += source.compared;
  into.matched += source.matched;
  into.mismatched += source.mismatched;
  into.errors += source.errors;
  into.timeouts += source.timeouts;
  into.skipped += source.skipped;
  into.compareDisabled += source.compareDisabled;
  into.readSuccesses += source.readSuccesses;
  into.diffPathPresent += source.diffPathPresent;
  into.primaryShadowCountMismatch += source.primaryShadowCountMismatch;
  into.hashMismatch += source.hashMismatch;
  into.orderOnlyMismatch += source.orderOnlyMismatch;
  for (const [key, value] of source.reasonCounts) into.reasonCounts.set(key, (into.reasonCounts.get(key) ?? 0) + value);
  for (const [key, value] of source.errorCodeCounts) {
    into.errorCodeCounts.set(key, (into.errorCodeCounts.get(key) ?? 0) + value);
  }
  into.latencies.push(...source.latencies);
}

function recordEvent(method: MutableMethod, event: D1ShadowEvent): void {
  const aggregate = method.aggregate;
  aggregate.events += 1;

  const reason = sanitizeD1ShadowCode(event.reason);
  if (reason !== null) increment(aggregate.reasonCounts, reason);
  const errorCode = sanitizeD1ShadowCode(event.errorCode);
  if (errorCode !== null) increment(aggregate.errorCodeCounts, errorCode);

  const database = sanitizeD1ShadowIdentifier(event.db);
  if (database !== null) method.databases.add(database);
  for (const table of event.tables) {
    const safeTable = sanitizeD1ShadowIdentifier(table);
    if (safeTable !== null) method.tables.add(safeTable);
  }

  if (event.diffPath !== null) aggregate.diffPathPresent += 1;
  if (event.readOutcome === "success") aggregate.readSuccesses += 1;
  if (event.readOutcome === "success" && event.latencyMs !== null) aggregate.latencies.push(event.latencyMs);

  if (event.compared) {
    aggregate.compared += 1;
    if (event.primaryCount !== null && event.shadowCount !== null && event.primaryCount !== event.shadowCount) {
      aggregate.primaryShadowCountMismatch += 1;
    }
    if (event.primaryHash !== null && event.shadowHash !== null && event.primaryHash !== event.shadowHash) {
      aggregate.hashMismatch += 1;
    }
  }

  switch (event.outcome) {
    case "matched":
      aggregate.matched += 1;
      if (event.orderMatches === false) aggregate.orderOnlyMismatch += 1;
      break;
    case "mismatched":
      aggregate.mismatched += 1;
      break;
    case "error":
      aggregate.errors += 1;
      break;
    case "timeout":
      aggregate.timeouts += 1;
      break;
    case "skipped":
      aggregate.skipped += 1;
      break;
    case "disabled":
      aggregate.compareDisabled += 1;
      break;
    default:
      break;
  }
}

export function resolveD1ShadowParityThresholds(
  overrides: Partial<D1ShadowParityThresholds> | undefined,
): D1ShadowParityThresholds {
  const source = overrides ?? {};
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  const rate = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  return {
    minComparedPerMethod: positive(source.minComparedPerMethod, D1_SHADOW_PARITY_DEFAULT_THRESHOLDS.minComparedPerMethod),
    maxMismatchRate: rate(source.maxMismatchRate, D1_SHADOW_PARITY_DEFAULT_THRESHOLDS.maxMismatchRate),
    maxErrorRate: rate(source.maxErrorRate, D1_SHADOW_PARITY_DEFAULT_THRESHOLDS.maxErrorRate),
    maxTimeoutRate: rate(source.maxTimeoutRate, D1_SHADOW_PARITY_DEFAULT_THRESHOLDS.maxTimeoutRate),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function evaluateMethodGate(stats: D1ShadowMethodStats, thresholds: D1ShadowParityThresholds): D1ShadowMethodGate {
  const mismatchRate = ratio(stats.mismatched, stats.compared);
  const errorRate = ratio(stats.errors, stats.events);
  const timeoutRate = ratio(stats.timeouts, stats.events);
  const reasons: string[] = [];
  let thresholdExceeded = false;
  if (mismatchRate > thresholds.maxMismatchRate) {
    reasons.push("mismatch_rate_exceeds_threshold");
    thresholdExceeded = true;
  }
  if (errorRate > thresholds.maxErrorRate) {
    reasons.push("error_rate_exceeds_threshold");
    thresholdExceeded = true;
  }
  if (timeoutRate > thresholds.maxTimeoutRate) {
    reasons.push("timeout_rate_exceeds_threshold");
    thresholdExceeded = true;
  }
  if (stats.compared < thresholds.minComparedPerMethod) {
    reasons.push("insufficient_compared_samples");
  }
  const status: D1ShadowParityGateStatus = thresholdExceeded
    ? "no_go"
    : stats.compared < thresholds.minComparedPerMethod
      ? "insufficient_evidence"
      : "go_candidate";
  return {
    surface: stats.surface,
    method: stats.method,
    compared: stats.compared,
    mismatched: stats.mismatched,
    errors: stats.errors,
    timeouts: stats.timeouts,
    mismatchRate,
    errorRate,
    timeoutRate,
    status,
    reasons,
  };
}

/** Builds the deterministic M6.5 parity report from parsed (untrusted) events. */
export function buildD1ShadowParityReport(options: BuildD1ShadowParityReportOptions): D1ShadowParityReport {
  const thresholds = resolveD1ShadowParityThresholds(options.thresholds);
  const coverage = d1ShadowSurfaceCoverage();
  const methods = new Map<string, MutableMethod>();
  const orderedMethods: MutableMethod[] = [];

  for (const surface of coverage) {
    for (const method of surface.methods) {
      const entry: MutableMethod = {
        surface: surface.surface,
        method: method.method,
        deferred: method.deferred,
        deferredBlockerId: method.deferredBlockerId,
        comparable: !method.deferred,
        aggregate: emptyAggregate(),
        databases: new Set(),
        tables: new Set(),
      };
      methods.set(`${surface.surface}${METHOD_SEPARATOR}${method.method}`, entry);
      orderedMethods.push(entry);
    }
  }

  const invalidReasons = new Map<string, number>();
  const malformedJsonLines = options.malformedJsonLines ?? 0;
  let structurallyInvalidEvents = 0;
  let parsedEvents = 0;

  for (const raw of options.events) {
    const validated = validateD1ShadowEvent(raw);
    if (!validated.ok) {
      structurallyInvalidEvents += 1;
      increment(invalidReasons, validated.code);
      continue;
    }
    parsedEvents += 1;
    const entry = methods.get(`${validated.event.surface}${METHOD_SEPARATOR}${validated.event.method}`);
    if (entry === undefined) {
      structurallyInvalidEvents += 1;
      increment(invalidReasons, "unknown_surface_method");
      continue;
    }
    recordEvent(entry, validated.event);
  }

  const methodStats: D1ShadowMethodStats[] = orderedMethods.map((entry) => {
    const aggregate = finalizeAggregate(entry.aggregate);
    return {
      ...aggregate,
      surface: entry.surface,
      method: entry.method,
      deferred: entry.deferred,
      comparable: entry.comparable,
      databases: sortedValues(entry.databases),
      tables: sortedValues(entry.tables),
    };
  });

  const surfaces: D1ShadowSurfaceStats[] = coverage.map((surface) => {
    const surfaceMethods = methodStats.filter((stats) => stats.surface === surface.surface);
    const aggregate = emptyAggregate();
    for (const entry of orderedMethods.filter((candidate) => candidate.surface === surface.surface)) {
      mergeAggregate(aggregate, entry);
    }
    return {
      ...finalizeAggregate(aggregate),
      surface: surface.surface,
      databases: sortedValues(new Set(surfaceMethods.flatMap((stats) => stats.databases))),
      tables: sortedValues(new Set(surfaceMethods.flatMap((stats) => stats.tables))),
      methods: surfaceMethods,
    };
  });

  const totalsAggregate = emptyAggregate();
  for (const entry of orderedMethods) mergeAggregate(totalsAggregate, entry);
  const totals = finalizeAggregate(totalsAggregate);

  const comparableMethods = methodStats.filter((stats) => stats.comparable);
  const methodGates = comparableMethods.map((stats) => evaluateMethodGate(stats, thresholds));
  const gateReasons: string[] = [];
  if (malformedJsonLines > 0 || structurallyInvalidEvents > 0) gateReasons.push("invalid_input_present");
  if (parsedEvents === 0) gateReasons.push("no_valid_events");
  if (comparableMethods.length === 0) gateReasons.push("no_comparable_methods");

  let m6Status: D1ShadowParityGateStatus;
  if (malformedJsonLines > 0 || structurallyInvalidEvents > 0 || comparableMethods.length === 0) {
    m6Status = "no_go";
  } else if (methodGates.some((gate) => gate.status === "no_go")) {
    m6Status = "no_go";
  } else if (methodGates.some((gate) => gate.status === "insufficient_evidence")) {
    m6Status = "insufficient_evidence";
  } else {
    m6Status = "go_candidate";
  }

  const deferredMethods = orderedMethods
    .filter((entry) => entry.deferred)
    .map((entry) => ({
      surface: entry.surface,
      method: entry.method,
      blockerId: entry.deferredBlockerId,
    }));

  return {
    schema: D1_SHADOW_PARITY_SCHEMA,
    milestone: "M6.5",
    authority: {
      supabase: "sole_read_authority",
      d1: "read_only_shadow",
      authoritySwitch: false,
      goD1ReadClaimed: false,
    },
    source: {
      totalLines: (options.malformedJsonLines ?? 0) + options.events.length,
      blankLines: options.blankLines ?? 0,
      parsedEvents,
      malformedJsonLines,
      structurallyInvalidEvents,
      invalidEvents: malformedJsonLines + structurallyInvalidEvents,
      duplicatePolicy: "preserve_every_sample_no_event_id",
    },
    invalidReasons: sortedCounts(invalidReasons),
    thresholds: { ...thresholds, provenance: D1_SHADOW_PARITY_THRESHOLD_PROVENANCE },
    coverage,
    syncMethods: D1_SHADOW_SYNC_METHODS,
    deferredMethods,
    totals,
    surfaces,
    m6EvidenceGate: {
      status: m6Status,
      reasons: gateReasons,
      minComparedPerMethod: thresholds.minComparedPerMethod,
      methods: methodGates,
    },
    globalGoD1Read: {
      status: "blocked",
      ready: false,
      blockers: D1_SHADOW_GLOBAL_BLOCKERS,
      reasons: D1_SHADOW_GLOBAL_BLOCKERS.map((blocker) => blocker.id),
    },
    notes: [
      "Local read-only evidence only: no deployment, no push, no Cloudflare/Supabase/D1 mutation.",
      "Supabase remains the sole read authority; M6.5 never authorizes an authority switch.",
      "The M6 evidence gate scores implemented comparable methods only; the global GO-D1-READ gate stays blocked by M7 search and both admin RPC snapshots.",
      "Thresholds are proposed local defaults, not an agreed production policy.",
      "Events are preserved as distinct samples; there is no event id, so nothing is deduplicated.",
      "The report intentionally omits primary/shadow hashes, diff path values, URLs, queries, metadata payloads and row content.",
    ],
  };
}

/** Maps a report gate status to a process exit code for a chosen strict scope. */
export function d1ShadowParityExitCode(report: D1ShadowParityReport, scope: "none" | "m6" | "global"): number {
  if (scope === "none") return 0;
  if (scope === "m6") return report.m6EvidenceGate.status === "go_candidate" ? 0 : 1;
  return report.globalGoD1Read.status === "ready" ? 0 : 1;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function renderReasonCounts(record: Record<string, number>): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "-";
  return keys.map((key) => `\`${key}\`=${record[key]}`).join(", ");
}

/** Renders a bounded operator-friendly markdown report with no sensitive values. */
export function renderD1ShadowParityReportMarkdown(report: D1ShadowParityReport): string {
  const lines: string[] = [];
  lines.push("# WorldCons D1 shadow parity report (M6.5)");
  lines.push("");
  lines.push(
    "> Local read-only evidence only. Supabase remains the sole read authority. "
      + "No authority switch and no `GO-D1-READ` is claimed.",
  );
  lines.push("");
  lines.push("## Gate verdict");
  lines.push("");
  lines.push("| gate | status |");
  lines.push("| --- | --- |");
  lines.push(`| M6 evidence (comparable methods) | ${report.m6EvidenceGate.status} |`);
  lines.push(`| Global GO-D1-READ | ${report.globalGoD1Read.status} |`);
  lines.push("");
  lines.push(`M6 gate rationale: ${report.m6EvidenceGate.reasons.length > 0 ? report.m6EvidenceGate.reasons.map((reason) => `\`${reason}\``).join(", ") : "none"}`);
  lines.push("");
  lines.push("Global blockers (intentionally unresolved in M6.5):");
  for (const blocker of report.globalGoD1Read.blockers) {
    lines.push(`- \`${blocker.id}\`: ${blocker.description}`);
  }
  lines.push("");
  lines.push("## Thresholds (proposed local defaults)");
  lines.push("");
  lines.push(`- min compared per method: ${report.thresholds.minComparedPerMethod}`);
  lines.push(`- max mismatch rate: ${formatRate(report.thresholds.maxMismatchRate)}`);
  lines.push(`- max error rate: ${formatRate(report.thresholds.maxErrorRate)}`);
  lines.push(`- max timeout rate: ${formatRate(report.thresholds.maxTimeoutRate)}`);
  lines.push(`- provenance: ${report.thresholds.provenance}`);
  lines.push("");
  lines.push("## Input");
  lines.push("");
  lines.push(`- total non-blank lines: ${report.source.totalLines}`);
  lines.push(`- blank lines ignored: ${report.source.blankLines}`);
  lines.push(`- valid events: ${report.source.parsedEvents}`);
  lines.push(`- malformed JSON lines: ${report.source.malformedJsonLines}`);
  lines.push(`- structurally invalid events: ${report.source.structurallyInvalidEvents}`);
  lines.push(`- invalid input reasons: ${renderReasonCounts(report.invalidReasons)}`);
  lines.push("");
  lines.push("## Global totals");
  lines.push("");
  lines.push("| events | compared | matched | mismatched | errors | timeouts | skipped | compare-disabled | read-ok |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const total = report.totals;
  lines.push(
    `| ${total.events} | ${total.compared} | ${total.matched} | ${total.mismatched} | ${total.errors} | `
      + `${total.timeouts} | ${total.skipped} | ${total.compareDisabled} | ${total.readSuccesses} |`,
  );
  lines.push("");
  lines.push(`Reason counts: ${renderReasonCounts(total.reasonCounts)}`);
  lines.push("");
  lines.push(`Error codes: ${renderReasonCounts(total.errorCodeCounts)}`);
  lines.push("");
  lines.push(`Order-only mismatches: ${total.orderOnlyMismatch} (matched canonical data with \`orderMatches=false\`)`);
  lines.push(`Count mismatches: ${total.primaryShadowCountMismatch} · hash mismatches: ${total.hashMismatch} · diff-path present: ${total.diffPathPresent}`);
  lines.push("");

  for (const surface of report.surfaces) {
    lines.push(`## Surface \`${surface.surface}\``);
    lines.push("");
    lines.push("| method | deferred | events | compared | matched | mismatch | error | timeout | skipped | disabled | read-ok | db | tables |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const method of surface.methods) {
      lines.push(
        `| ${method.method} | ${method.deferred ? "yes" : "no"} | ${method.events} | ${method.compared} | `
          + `${method.matched} | ${method.mismatched} | ${method.errors} | ${method.timeouts} | ${method.skipped} | `
          + `${method.compareDisabled} | ${method.readSuccesses} | ${method.databases.join(", ") || "-"} | `
          + `${method.tables.join(", ") || "-"} |`,
      );
    }
    lines.push("");
    lines.push("Latency (comparable/successful reads, ms):");
    lines.push("");
    lines.push("| method | samples | min | mean | p50 | p95 | p99 | max |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const method of surface.methods) {
      if (method.latency === null) {
        lines.push(`| ${method.method} | ${method.latencySampleCount} | - | - | - | - | - | - |`);
        continue;
      }
      const latency = method.latency;
      lines.push(
        `| ${method.method} | ${latency.sampleCount} | ${formatLatency(latency.minMs)} | ${formatLatency(latency.meanMs)} | `
          + `${formatLatency(latency.p50Ms)} | ${formatLatency(latency.p95Ms)} | ${formatLatency(latency.p99Ms)} | `
          + `${formatLatency(latency.maxMs)} |`,
      );
    }
    lines.push("");
    lines.push(`Reasons: ${renderReasonCounts(surface.reasonCounts)}`);
    lines.push("");
  }

  lines.push("## M6 evidence gate per method");
  lines.push("");
  lines.push("| surface | method | compared | mismatch rate | error rate | timeout rate | status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const method of report.m6EvidenceGate.methods) {
    lines.push(
      `| ${method.surface} | ${method.method} | ${method.compared} | ${formatRate(method.mismatchRate)} | `
        + `${formatRate(method.errorRate)} | ${formatRate(method.timeoutRate)} | ${method.status} |`,
    );
  }
  lines.push("");
  lines.push("## Deferred methods");
  lines.push("");
  for (const method of report.deferredMethods) {
    lines.push(`- \`${method.surface}.${method.method}\` -> blocker \`${method.blockerId ?? "unknown"}\``);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Convenience: validate/deferred helper kept exported for report consumers. */
export function isD1ShadowDeferredMethod(surface: string, method: string): boolean {
  return isDeferredD1ShadowMethod(surface, method);
}

/** Convenience: the comparable surface+method pairs the M6 evidence gate scores. */
export function d1ShadowGateComparableMethods(): { surface: string; method: string }[] {
  return d1ShadowComparableMethods();
}
