import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import type { P5CompatibilityObservation } from "@/lib/admin/p5/types";

export const ADMIN_P5_COMPATIBILITY_OBSERVATION_FLAG = "ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED";
const MAX_IN_FLIGHT = 2;
const MAX_COALESCE_KEYS = 256;
let inFlight = 0;
let sequence = 0;
const lastSeenByKey = new Map<string, number>();
let testWriter: ((observation: P5CompatibilityObservation) => Promise<void>) | null = null;

function enabled(env: Record<string, string | undefined>) {
  return env[ADMIN_P5_COMPATIBILITY_OBSERVATION_FLAG]?.trim().toLowerCase() === "true";
}

function sampleRate(env: Record<string, string | undefined>) {
  const value = Number(env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0.1");
  return Number.isFinite(value) ? Math.min(1, Math.max(0.001, value)) : 0.1;
}

function coalesceWindowMs(env: Record<string, string | undefined>, override?: number) {
  const value = override ?? Number(env.ADMIN_P5_COMPATIBILITY_OBSERVATION_COALESCE_MS ?? "60000");
  return Number.isFinite(value) ? Math.min(300_000, Math.max(1_000, Math.trunc(value))) : 60_000;
}

function observationKey(observation: P5CompatibilityObservation) {
  return [observation.surface, observation.domain, observation.direction, observation.authority, observation.outcome].join(":");
}

async function writeObservation(observation: P5CompatibilityObservation) {
  if (testWriter) return testWriter(observation);
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (!binding) return;
  const now = new Date();
  const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())).toISOString();
  const count = Math.min(10_000, Math.max(1, Math.trunc(observation.count ?? 1)));
  const unexplained = observation.authority === "legacy" || observation.authority === "fallback" ? count : 0;
  const statement = binding.prepare([
    "INSERT INTO admin_compatibility_observations_p5",
    "(bucket_started_at,surface,domain,direction,authority,outcome,observation_count,unexplained_count,first_observed_at,last_observed_at)",
    "VALUES (?,?,?,?,?,?,CAST(? AS TEXT),CAST(? AS TEXT),?,?)",
    "ON CONFLICT(bucket_started_at,surface,domain,direction,authority,outcome) DO UPDATE SET",
    "observation_count=CAST(MIN(9223372036854775807,CAST(admin_compatibility_observations_p5.observation_count AS INTEGER)+CAST(excluded.observation_count AS INTEGER)) AS TEXT),",
    "unexplained_count=CAST(MIN(9223372036854775807,CAST(admin_compatibility_observations_p5.unexplained_count AS INTEGER)+CAST(excluded.unexplained_count AS INTEGER)) AS TEXT),",
    "first_observed_at=MIN(admin_compatibility_observations_p5.first_observed_at,excluded.first_observed_at),",
    "last_observed_at=MAX(admin_compatibility_observations_p5.last_observed_at,excluded.last_observed_at)",
  ].join(" ")).bind(bucket,observation.surface,observation.domain,observation.direction,observation.authority,observation.outcome,count,unexplained,now.toISOString(),now.toISOString());
  if (!statement.run) throw new Error("admin_p5_observation.d1_write_unavailable");
  const result = await statement.run();
  if (result.success === false || result.error) throw new Error(result.error || "admin_p5_observation.d1_write_failed");
}

export function compatibilityObservationEnabled(env: Record<string, string | undefined> = process.env) {
  return enabled(env);
}

export function recordCompatibilityObservation(
  observation: P5CompatibilityObservation,
  options: { environment?: Record<string, string | undefined>; force?: boolean; nowMs?: number; coalesceMs?: number } = {},
) {
  const environment = options.environment ?? process.env;
  if (!options.force && !enabled(environment)) return false;
  const rate = options.force ? 1 : sampleRate(environment);
  sequence = (sequence + 1) % 1_000_000;
  if (!options.force && (sequence % 10_000) / 10_000 >= rate) return false;
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = coalesceWindowMs(environment, options.coalesceMs);
  const key = observationKey(observation);
  const previous = lastSeenByKey.get(key);
  if (previous !== undefined && nowMs - previous < windowMs) return false;
  if (inFlight >= MAX_IN_FLIGHT) return false;
  if (lastSeenByKey.size >= MAX_COALESCE_KEYS) {
    for (const [candidate, seenAt] of lastSeenByKey) {
      if (nowMs - seenAt >= windowMs) lastSeenByKey.delete(candidate);
    }
    if (lastSeenByKey.size >= MAX_COALESCE_KEYS) lastSeenByKey.delete(lastSeenByKey.keys().next().value as string);
  }
  lastSeenByKey.set(key, nowMs);
  inFlight += 1;
  void writeObservation({ ...observation, count: 1 })
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
  lastSeenByKey.clear();
}
