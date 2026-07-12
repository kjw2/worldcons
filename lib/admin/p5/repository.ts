import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { resolveP5OperationalPolicy, type P5OperationalPolicy } from "@/lib/admin/p5/policy";
import type { P5HealthEvidence, P5OwnerRole } from "@/lib/admin/p5/types";

interface RpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function daysBefore(now: Date, days: number) {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function unavailableP5HealthEvidence(start: string, end: string): P5HealthEvidence {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    available: false,
    observationWindow: { start, end },
    queue: { states: {}, oldestQueuedAgeSeconds: null, staleLeaseCount: 0, oldestHeartbeatAgeSeconds: null, abortPendingCount: 0, oldestAbortAgeSeconds: null, retryWaitingCount: 0, oldestRetryAgeSeconds: null },
    lifecycle: { backlogCount: 0, oldestReviewAgeSeconds: null, unresolvedAnomalyCount: 0 },
    publication: { legacyPublicCount: 0, explicitPublicCount: 0, parityMismatchCount: 0, quarantineCount: 0, legacyIdentityDigest: "", explicitIdentityDigest: "" },
    outbox: { pendingCount: 0, processingCount: 0, deadLetterCount: 0, oldestUndeliveredAgeSeconds: null },
    sources: [],
    compatibility: { totalCount: 0, legacyReadCount: 0, legacyWriteCount: 0, newReadCount: 0, newWriteCount: 0, fallbackCount: 0, unexplainedLegacyCount: 0, firstObservedAt: null, lastObservedAt: null, bucketCount: 0 },
    inFlight: { legacyCount: 0, newCount: 0, conflict: false },
    governance: { backupRestoreAt: null, backupRestoreExpiresAt: null, approvedRoles: [] },
    retention: { commandAttemptsDue: 0, commandEventsDue: 0, lifecycleEventsDue: 0, publicationHistoryDue: 0, contentVersionsDue: 0, compatibilityObservationsDue: 0, deliveredOutboxDue: 0, deadLetterOutboxDue: 0, legalHoldActive: false },
  };
}

export function parseP5HealthEvidence(value: unknown, fallback: P5HealthEvidence): P5HealthEvidence {
  const root = record(value);
  if (numberValue(root.schemaVersion) !== 1 || root.available !== true) return fallback;
  const window = record(root.observationWindow);
  const queue = record(root.queue);
  const lifecycle = record(root.lifecycle);
  const publication = record(root.publication);
  const outbox = record(root.outbox);
  const compatibility = record(root.compatibility);
  const inFlight = record(root.inFlight);
  const governance = record(root.governance);
  const retention = record(root.retention);
  const states = record(queue.states);
  const approvedRoles = Array.isArray(governance.approvedRoles)
    ? governance.approvedRoles.filter((role): role is P5OwnerRole => role === "operations" || role === "data" || role === "security")
    : [];
  const sources = Array.isArray(root.sources) ? root.sources.slice(0, 100).map((entry) => {
    const source = record(entry);
    return { sourceKey: text(source.sourceKey), active: source.active === true, latestRunAt: nullableText(source.latestRunAt), freshnessAgeSeconds: nullableNumber(source.freshnessAgeSeconds) };
  }).filter((source) => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(source.sourceKey)) : [];
  return {
    schemaVersion: 1,
    generatedAt: text(root.generatedAt) || fallback.generatedAt,
    available: true,
    observationWindow: { start: text(window.start) || fallback.observationWindow.start, end: text(window.end) || fallback.observationWindow.end },
    queue: {
      states: Object.fromEntries(Object.entries(states).slice(0, 20).map(([key, count]) => [key, numberValue(count)])),
      oldestQueuedAgeSeconds: nullableNumber(queue.oldestQueuedAgeSeconds), staleLeaseCount: numberValue(queue.staleLeaseCount), oldestHeartbeatAgeSeconds: nullableNumber(queue.oldestHeartbeatAgeSeconds),
      abortPendingCount: numberValue(queue.abortPendingCount), oldestAbortAgeSeconds: nullableNumber(queue.oldestAbortAgeSeconds), retryWaitingCount: numberValue(queue.retryWaitingCount), oldestRetryAgeSeconds: nullableNumber(queue.oldestRetryAgeSeconds),
    },
    lifecycle: { backlogCount: numberValue(lifecycle.backlogCount), oldestReviewAgeSeconds: nullableNumber(lifecycle.oldestReviewAgeSeconds), unresolvedAnomalyCount: numberValue(lifecycle.unresolvedAnomalyCount) },
    publication: { legacyPublicCount: numberValue(publication.legacyPublicCount), explicitPublicCount: numberValue(publication.explicitPublicCount), parityMismatchCount: numberValue(publication.parityMismatchCount), quarantineCount: numberValue(publication.quarantineCount), legacyIdentityDigest: text(publication.legacyIdentityDigest), explicitIdentityDigest: text(publication.explicitIdentityDigest) },
    outbox: { pendingCount: numberValue(outbox.pendingCount), processingCount: numberValue(outbox.processingCount), deadLetterCount: numberValue(outbox.deadLetterCount), oldestUndeliveredAgeSeconds: nullableNumber(outbox.oldestUndeliveredAgeSeconds) },
    sources,
    compatibility: { totalCount: numberValue(compatibility.totalCount), legacyReadCount: numberValue(compatibility.legacyReadCount), legacyWriteCount: numberValue(compatibility.legacyWriteCount), newReadCount: numberValue(compatibility.newReadCount), newWriteCount: numberValue(compatibility.newWriteCount), fallbackCount: numberValue(compatibility.fallbackCount), unexplainedLegacyCount: numberValue(compatibility.unexplainedLegacyCount), firstObservedAt: nullableText(compatibility.firstObservedAt), lastObservedAt: nullableText(compatibility.lastObservedAt), bucketCount: numberValue(compatibility.bucketCount) },
    inFlight: { legacyCount: numberValue(inFlight.legacyCount), newCount: numberValue(inFlight.newCount), conflict: inFlight.conflict === true },
    governance: { backupRestoreAt: nullableText(governance.backupRestoreAt), backupRestoreExpiresAt: nullableText(governance.backupRestoreExpiresAt), approvedRoles: [...new Set(approvedRoles)] },
    retention: { commandAttemptsDue: numberValue(retention.commandAttemptsDue), commandEventsDue: numberValue(retention.commandEventsDue), lifecycleEventsDue: numberValue(retention.lifecycleEventsDue), publicationHistoryDue: numberValue(retention.publicationHistoryDue), contentVersionsDue: numberValue(retention.contentVersionsDue), compatibilityObservationsDue: numberValue(retention.compatibilityObservationsDue), deliveredOutboxDue: numberValue(retention.deliveredOutboxDue), deadLetterOutboxDue: numberValue(retention.deadLetterOutboxDue), legalHoldActive: retention.legalHoldActive === true },
  };
}

export async function getP5HealthEvidence(options: {
  observationStart: string;
  observationEnd: string;
  now?: Date;
  policy?: P5OperationalPolicy;
  client?: RpcClient | null;
}): Promise<P5HealthEvidence> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? resolveP5OperationalPolicy();
  const fallback = unavailableP5HealthEvidence(options.observationStart, options.observationEnd);
  const client = options.client === undefined ? getSupabaseServiceRoleAdmin() as unknown as RpcClient | null : options.client;
  if (!client) return fallback;
  const { data, error } = await client.rpc("admin_operational_health_p5", {
    p_observation_start: options.observationStart,
    p_observation_end: options.observationEnd,
    p_command_before: daysBefore(now, policy.retention.commandTerminalDays),
    p_lifecycle_before: daysBefore(now, policy.retention.lifecycleAuditDays),
    p_publication_before: daysBefore(now, policy.retention.publicationAuditDays),
    p_observation_before: daysBefore(now, policy.retention.compatibilityObservationDays),
    p_delivered_outbox_before: daysBefore(now, policy.retention.deliveredOutboxDays),
    p_dead_letter_outbox_before: daysBefore(now, policy.retention.deadLetterOutboxDays),
  });
  return error ? fallback : parseP5HealthEvidence(data, fallback);
}

export async function recordP5OwnerApproval(options: { role: P5OwnerRole; actorHash: string; evidenceDigest: string; expiresAt: string; client?: RpcClient | null }) {
  const client = options.client === undefined ? getSupabaseServiceRoleAdmin() as unknown as RpcClient | null : options.client;
  if (!client) return { ok: false as const, code: "unavailable" };
  const { data, error } = await client.rpc("admin_record_owner_approval_p5", { p_role_key: options.role, p_actor_hash: options.actorHash, p_evidence_digest: options.evidenceDigest, p_expires_at: options.expiresAt });
  return error ? { ok: false as const, code: error.code ?? "database_error" } : { ok: true as const, evidenceId: numberValue(data) };
}

export async function applyP5Retention(options: { observationBefore: string; deliveredOutboxBefore: string; batchSize: number; confirmation: string; client?: RpcClient | null }) {
  const client = options.client === undefined ? getSupabaseServiceRoleAdmin() as unknown as RpcClient | null : options.client;
  if (!client) return { ok: false as const, code: "unavailable", data: null };
  const { data, error } = await client.rpc("admin_apply_retention_p5", { p_observation_before: options.observationBefore, p_delivered_outbox_before: options.deliveredOutboxBefore, p_batch_size: options.batchSize, p_confirmation: options.confirmation });
  return error ? { ok: false as const, code: error.code ?? "database_error", data: null } : { ok: true as const, data: record(data) };
}
