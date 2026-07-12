import type { P5OwnerRole } from "@/lib/admin/p5/types";

interface BoundedThreshold {
  warning: number;
  critical: number;
  min: number;
  max: number;
  owner: P5OwnerRole;
}

export interface P5OperationalPolicy {
  queueLatencySeconds: BoundedThreshold;
  leaseHeartbeatAgeSeconds: BoundedThreshold;
  abortCompletionSeconds: BoundedThreshold;
  retryAgeSeconds: BoundedThreshold;
  lifecycleBacklogCount: BoundedThreshold;
  lifecycleReviewAgeSeconds: BoundedThreshold;
  publicationParityCount: BoundedThreshold;
  outboxDeliveryAgeSeconds: BoundedThreshold;
  outboxDeadLetterCount: BoundedThreshold;
  sourceFreshnessSeconds: BoundedThreshold;
  sourceFreshnessOverrides: Record<string, { warning: number; critical: number }>;
  minimumObservationHours: number;
  backupRestoreMaximumAgeHours: number;
  retention: {
    commandTerminalDays: number;
    lifecycleAuditDays: number;
    publicationAuditDays: number;
    compatibilityObservationDays: number;
    deliveredOutboxDays: number;
    deadLetterOutboxDays: number;
    batchSize: number;
  };
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

function threshold(
  env: Record<string, string | undefined>,
  prefix: string,
  defaults: { warning: number; critical: number; min: number; max: number; owner: P5OwnerRole },
) {
  const warning = boundedNumber(env[`${prefix}_WARNING`], defaults.warning, defaults.min, defaults.max);
  const critical = boundedNumber(env[`${prefix}_CRITICAL`], defaults.critical, defaults.min, defaults.max);
  return { ...defaults, warning: Math.min(warning, critical), critical: Math.max(warning, critical) };
}

function sourceOverrides(raw: string | undefined, fallback: BoundedThreshold) {
  if (!raw || raw.length > 4096) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(entries.flatMap(([sourceKey, value]) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(sourceKey) || !value || typeof value !== "object") return [];
      const candidate = value as Record<string, unknown>;
      const warningHours = boundedNumber(String(candidate.warningHours ?? ""), fallback.warning / 3600, 1, 720);
      const criticalHours = boundedNumber(String(candidate.criticalHours ?? ""), fallback.critical / 3600, 1, 720);
      return [[sourceKey, {
        warning: Math.min(warningHours, criticalHours) * 3600,
        critical: Math.max(warningHours, criticalHours) * 3600,
      }]];
    }));
  } catch {
    return {};
  }
}

export function resolveP5OperationalPolicy(env: Record<string, string | undefined> = process.env): P5OperationalPolicy {
  const sourceFreshness = threshold(env, "ADMIN_P5_SOURCE_FRESHNESS_SECONDS", { warning: 129_600, critical: 259_200, min: 3600, max: 2_592_000, owner: "operations" });
  return {
    queueLatencySeconds: threshold(env, "ADMIN_P5_QUEUE_LATENCY_SECONDS", { warning: 300, critical: 900, min: 30, max: 86_400, owner: "operations" }),
    leaseHeartbeatAgeSeconds: threshold(env, "ADMIN_P5_HEARTBEAT_AGE_SECONDS", { warning: 90, critical: 180, min: 15, max: 3600, owner: "operations" }),
    abortCompletionSeconds: threshold(env, "ADMIN_P5_ABORT_COMPLETION_SECONDS", { warning: 120, critical: 300, min: 15, max: 86_400, owner: "operations" }),
    retryAgeSeconds: threshold(env, "ADMIN_P5_RETRY_AGE_SECONDS", { warning: 1800, critical: 7200, min: 60, max: 604_800, owner: "operations" }),
    lifecycleBacklogCount: threshold(env, "ADMIN_P5_LIFECYCLE_BACKLOG_COUNT", { warning: 250, critical: 1000, min: 0, max: 1_000_000, owner: "data" }),
    lifecycleReviewAgeSeconds: threshold(env, "ADMIN_P5_REVIEW_AGE_SECONDS", { warning: 86_400, critical: 259_200, min: 3600, max: 2_592_000, owner: "data" }),
    publicationParityCount: threshold(env, "ADMIN_P5_PUBLICATION_PARITY_COUNT", { warning: 0, critical: 0, min: 0, max: 10_000, owner: "data" }),
    outboxDeliveryAgeSeconds: threshold(env, "ADMIN_P5_OUTBOX_DELIVERY_SECONDS", { warning: 300, critical: 900, min: 30, max: 86_400, owner: "operations" }),
    outboxDeadLetterCount: threshold(env, "ADMIN_P5_OUTBOX_DEAD_LETTER_COUNT", { warning: 0, critical: 0, min: 0, max: 10_000, owner: "operations" }),
    sourceFreshnessSeconds: sourceFreshness,
    sourceFreshnessOverrides: sourceOverrides(env.ADMIN_P5_SOURCE_FRESHNESS_OVERRIDES_JSON, sourceFreshness),
    minimumObservationHours: boundedNumber(env.ADMIN_P5_MINIMUM_OBSERVATION_HOURS, 336, 24, 2160),
    backupRestoreMaximumAgeHours: boundedNumber(env.ADMIN_P5_BACKUP_RESTORE_MAX_AGE_HOURS, 720, 24, 2160),
    retention: {
      commandTerminalDays: boundedNumber(env.ADMIN_P5_RETENTION_COMMAND_DAYS, 180, 90, 3650),
      lifecycleAuditDays: boundedNumber(env.ADMIN_P5_RETENTION_LIFECYCLE_DAYS, 2555, 365, 3650),
      publicationAuditDays: boundedNumber(env.ADMIN_P5_RETENTION_PUBLICATION_DAYS, 2555, 2555, 3650),
      compatibilityObservationDays: boundedNumber(env.ADMIN_P5_RETENTION_OBSERVATION_DAYS, 400, 180, 3650),
      deliveredOutboxDays: boundedNumber(env.ADMIN_P5_RETENTION_DELIVERED_OUTBOX_DAYS, 180, 90, 3650),
      deadLetterOutboxDays: boundedNumber(env.ADMIN_P5_RETENTION_DEAD_LETTER_DAYS, 730, 365, 3650),
      batchSize: boundedNumber(env.ADMIN_P5_RETENTION_BATCH_SIZE, 250, 1, 500),
    },
  };
}
