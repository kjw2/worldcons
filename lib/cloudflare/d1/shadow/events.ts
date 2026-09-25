/**
 * M6.1 structured D1 shadow observability.
 *
 * Every shadow decision emits exactly one `worldcons.d1_shadow` JSON event
 * through an injectable sink (defaults to `console.log`). The event carries only
 * counts, hashes, a bounded diff path and classify codes: never a row value, a
 * secret or a Supabase RPC/observation write. M6.1 adds no D1 write either.
 */
export const D1_SHADOW_EVENT_NAME = "worldcons.d1_shadow";

export const D1_SHADOW_OUTCOMES = [
  "matched",
  "mismatched",
  "error",
  "timeout",
  "skipped",
  "disabled",
] as const;
export type D1ShadowOutcome = (typeof D1_SHADOW_OUTCOMES)[number];

export interface D1ShadowEvent {
  event: typeof D1_SHADOW_EVENT_NAME;
  surface: string;
  method: string;
  outcome: D1ShadowOutcome;
  /** A short, non-secret classify code, e.g. `sampled_out` or `compare_disabled`. */
  reason: string | null;
  errorCode: string | null;
  /** The D1 database read, e.g. `worldcons_core`. */
  db: string | null;
  tables: string[];
  /** Authoritative row count (array length or 1/0 for a single object). */
  primaryCount: number | null;
  /** Shadow D1 row count. */
  shadowCount: number | null;
  primaryHash: string | null;
  shadowHash: string | null;
  /** First bounded field diff path when a comparison ran and differed. */
  diffPath: string | null;
  /** Raw-order informational signal for an array contract. */
  orderMatches: boolean | null;
  /** Whether a result comparison actually ran. */
  compared: boolean;
  /** The D1 read's own status, independent of the comparison. */
  readOutcome: "success" | "error" | "timeout" | null;
  latencyMs: number | null;
}

export type D1ShadowEventSink = (event: D1ShadowEvent) => void;

export const defaultD1ShadowSink: D1ShadowEventSink = (event) => {
  console.log(JSON.stringify(event));
};

/** Emits one event, swallowing a sink failure so observability never breaks a read. */
export function emitD1ShadowEvent(sink: D1ShadowEventSink, event: D1ShadowEvent): void {
  try {
    sink(event);
  } catch {
    // Observability must never surface into the authoritative read path.
  }
}
