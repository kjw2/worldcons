import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { P5CompatibilityObservation } from "@/lib/admin/p5/types";

export const ADMIN_P5_COMPATIBILITY_OBSERVATION_FLAG = "ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED";
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
let sequence = 0;
let testWriter: ((observation: P5CompatibilityObservation) => Promise<void>) | null = null;

function enabled(env: Record<string, string | undefined>) {
  return env[ADMIN_P5_COMPATIBILITY_OBSERVATION_FLAG]?.trim().toLowerCase() === "true";
}

function sampleRate(env: Record<string, string | undefined>) {
  const value = Number(env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0.1");
  return Number.isFinite(value) ? Math.min(1, Math.max(0.001, value)) : 0.1;
}

async function writeObservation(observation: P5CompatibilityObservation) {
  if (testWriter) return testWriter(observation);
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc("admin_record_compatibility_observation_p5", {
    p_surface: observation.surface,
    p_domain: observation.domain,
    p_direction: observation.direction,
    p_authority: observation.authority,
    p_outcome: observation.outcome,
    p_count: observation.count ?? 1,
  });
  if (error) throw error;
}

export function compatibilityObservationEnabled(env: Record<string, string | undefined> = process.env) {
  return enabled(env);
}

export function recordCompatibilityObservation(
  observation: P5CompatibilityObservation,
  options: { environment?: Record<string, string | undefined>; force?: boolean } = {},
) {
  const environment = options.environment ?? process.env;
  if (!options.force && !enabled(environment)) return false;
  const rate = options.force ? 1 : sampleRate(environment);
  sequence = (sequence + 1) % 1_000_000;
  if (!options.force && (sequence % 10_000) / 10_000 >= rate) return false;
  if (inFlight >= MAX_IN_FLIGHT) return false;
  inFlight += 1;
  void writeObservation({ ...observation, count: Math.min(10_000, Math.max(1, Math.trunc(observation.count ?? 1))) })
    .catch(() => undefined)
    .finally(() => { inFlight -= 1; });
  return true;
}

export function setCompatibilityObservationWriterForTests(
  writer: ((observation: P5CompatibilityObservation) => Promise<void>) | null,
) {
  testWriter = writer;
  inFlight = 0;
  sequence = 0;
}
