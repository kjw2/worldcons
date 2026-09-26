import type { SearchCanaryObservation, SearchCanaryTimings } from "./types";
import { percentile } from "./evaluate";

/**
 * M7.6 timing separation (runtime-neutral).
 *
 * M7.5 measured only operator wall time, which crosses a Wrangler child-process
 * boundary for every D1/Vectorize call and is therefore not a production Worker
 * SLO. M7.6 additionally records, per observation, the binding/runtime latency
 * measured inside the isolated canary Worker's real D1 + Vectorize bindings. The
 * two distributions are summarized separately and the runtime latency gate only
 * applies when binding samples exist.
 */
function summarize(values: readonly number[]): { samples: number; p50Ms: number; p95Ms: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

export function summarizeSearchCanaryTimings(
  observations: readonly SearchCanaryObservation[],
): SearchCanaryTimings {
  const compared = observations.filter(
    (observation) => observation.status === "pass" || observation.status === "mismatch",
  );
  const operator = compared.map((observation) => observation.latencyMs);
  const binding = compared
    .map((observation) => observation.bindingLatencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return { operator: summarize(operator), binding: summarize(binding) };
}

/**
 * True when the binding/runtime distribution satisfies the (optional) binding
 * thresholds. A run with no binding samples is NOT gated, because the runtime
 * dimension was not measured (and cannot be silently assumed to pass).
 */
export function bindingTimingWithinThresholds(
  timings: SearchCanaryTimings,
  maxP50Ms: number | undefined,
  maxP95Ms: number | undefined,
): boolean {
  if (timings.binding.samples === 0) return true;
  if (maxP50Ms !== undefined && timings.binding.p50Ms > maxP50Ms) return false;
  if (maxP95Ms !== undefined && timings.binding.p95Ms > maxP95Ms) return false;
  return true;
}
