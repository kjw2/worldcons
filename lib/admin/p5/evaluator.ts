import crypto from "node:crypto";
import { P5_OWNER_ROLES, type P5HealthEvidence, type P5RetirementGate, type P5RetirementReport, type P5SlaResult } from "@/lib/admin/p5/types";
import type { P5OperationalPolicy } from "@/lib/admin/p5/policy";

function metric(key: string, label: string, value: number | null, threshold: { warning: number; critical: number; owner: P5SlaResult["owner"] }, unit: P5SlaResult["unit"]): P5SlaResult {
  const status = value === null ? "unknown" : value > threshold.critical ? "critical" : value > threshold.warning ? "warning" : "healthy";
  return { key, label, owner: threshold.owner, status, value, warningThreshold: threshold.warning, criticalThreshold: threshold.critical, unit };
}

export function evaluateP5Slas(evidence: P5HealthEvidence, policy: P5OperationalPolicy): P5SlaResult[] {
  const results = [
    metric("queue.latency", "Command queue latency", evidence.queue.oldestQueuedAgeSeconds ?? ((evidence.queue.states.queued ?? 0) === 0 ? 0 : null), policy.queueLatencySeconds, "seconds"),
    metric("queue.heartbeat", "Lease heartbeat age", evidence.queue.oldestHeartbeatAgeSeconds ?? ((evidence.queue.states.running ?? 0) === 0 ? 0 : null), policy.leaseHeartbeatAgeSeconds, "seconds"),
    metric("queue.abort", "Abort completion", evidence.queue.oldestAbortAgeSeconds ?? (evidence.queue.abortPendingCount === 0 ? 0 : null), policy.abortCompletionSeconds, "seconds"),
    metric("queue.retry", "Retry wait age", evidence.queue.oldestRetryAgeSeconds ?? (evidence.queue.retryWaitingCount === 0 ? 0 : null), policy.retryAgeSeconds, "seconds"),
    metric("lifecycle.backlog", "Lifecycle attention backlog", evidence.lifecycle.backlogCount, policy.lifecycleBacklogCount, "count"),
    metric("lifecycle.review", "Oldest review age", evidence.lifecycle.oldestReviewAgeSeconds ?? (evidence.lifecycle.backlogCount === 0 ? 0 : null), policy.lifecycleReviewAgeSeconds, "seconds"),
    metric("publication.parity", "Publication parity", evidence.publication.parityMismatchCount + evidence.publication.quarantineCount, policy.publicationParityCount, "count"),
    metric("outbox.delivery", "Cache outbox delivery", evidence.outbox.oldestUndeliveredAgeSeconds ?? (evidence.outbox.pendingCount + evidence.outbox.processingCount === 0 ? 0 : null), policy.outboxDeliveryAgeSeconds, "seconds"),
    metric("outbox.dead_letter", "Cache outbox dead letters", evidence.outbox.deadLetterCount, policy.outboxDeadLetterCount, "count"),
  ];
  for (const source of evidence.sources) {
    if (!source.active) continue;
    const configured = policy.sourceFreshnessOverrides[source.sourceKey] ?? policy.sourceFreshnessSeconds;
    results.push(metric(`source.${source.sourceKey}`, `Source freshness: ${source.sourceKey}`, source.freshnessAgeSeconds, { ...configured, owner: "operations" }, "seconds"));
  }
  return evidence.available
    ? results
    : results.map((result) => ({ ...result, status: "unknown" as const, value: null }));
}

export interface P5RetirementEvaluationInput {
  evidence: P5HealthEvidence;
  policy: P5OperationalPolicy;
  observationStart: string;
  observationEnd: string;
  flags: Record<string, boolean>;
  observationSampleRate: number;
  now?: Date;
  signingKey?: string;
}

export const P5_RETIREMENT_FLAG_ORDER = [
  ["ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED", true],
  ["ADMIN_QUEUE_V3_WORKER_ENABLED", true],
  ["ARTICLE_LIFECYCLE_P2_READ_ENABLED", true],
  ["ADMIN_PUBLICATION_V4_READ_ENABLED", true],
  ["ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED", true],
  ["ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED", false],
  ["ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED", false],
  ["ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED", false],
] as const;

export function canonicalP5Json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalP5Json).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalP5Json(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type P5CanonicalEvidenceInput = Pick<P5RetirementEvaluationInput,
  "evidence" | "policy" | "observationStart" | "observationEnd" | "flags" | "observationSampleRate"
>;

function thresholdSnapshot(value: { warning: number; critical: number; owner: string }) {
  return { warning: value.warning, critical: value.critical, owner: value.owner };
}

export function createP5CanonicalEvidenceSnapshot(input: P5CanonicalEvidenceInput) {
  const sourceOverrides = Object.fromEntries(Object.entries(input.policy.sourceFreshnessOverrides).sort(([left], [right]) => left.localeCompare(right)));
  const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name]) => [name, input.flags[name] === true]));
  const compatibility = input.evidence.compatibility;
  const slaStates = evaluateP5Slas(input.evidence, input.policy)
    .map(({ key, status }) => ({ key, status }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    schemaVersion: "p5-evidence-v2" as const,
    thresholds: {
      queueLatencySeconds: thresholdSnapshot(input.policy.queueLatencySeconds),
      leaseHeartbeatAgeSeconds: thresholdSnapshot(input.policy.leaseHeartbeatAgeSeconds),
      abortCompletionSeconds: thresholdSnapshot(input.policy.abortCompletionSeconds),
      retryAgeSeconds: thresholdSnapshot(input.policy.retryAgeSeconds),
      lifecycleBacklogCount: thresholdSnapshot(input.policy.lifecycleBacklogCount),
      lifecycleReviewAgeSeconds: thresholdSnapshot(input.policy.lifecycleReviewAgeSeconds),
      publicationParityCount: thresholdSnapshot(input.policy.publicationParityCount),
      outboxDeliveryAgeSeconds: thresholdSnapshot(input.policy.outboxDeliveryAgeSeconds),
      outboxDeadLetterCount: thresholdSnapshot(input.policy.outboxDeadLetterCount),
      sourceFreshnessSeconds: thresholdSnapshot(input.policy.sourceFreshnessSeconds),
      sourceFreshnessOverrides: sourceOverrides,
      minimumObservationHours: input.policy.minimumObservationHours,
      backupRestoreMaximumAgeHours: input.policy.backupRestoreMaximumAgeHours,
    },
    observation: {
      start: input.observationStart,
      end: input.observationEnd,
      sampleRate: input.observationSampleRate,
      firstObservedAt: compatibility.firstObservedAt,
      lastObservedAt: compatibility.lastObservedAt,
      legacyLastSeenAt: compatibility.legacyLastSeenAt,
      newLastSeenAt: compatibility.newLastSeenAt,
      legacyReadObserved: compatibility.legacyReadObserved,
      legacyWriteObserved: compatibility.legacyWriteObserved,
      newReadObserved: compatibility.newReadObserved,
      newWriteObserved: compatibility.newWriteObserved,
      fallbackObserved: compatibility.fallbackObserved,
      unexplainedLegacyObserved: compatibility.unexplainedLegacyObserved,
    },
    health: {
      available: input.evidence.available,
      slaStates,
      queue: {
        states: input.evidence.queue.states,
        staleLeaseCount: input.evidence.queue.staleLeaseCount,
        abortPendingCount: input.evidence.queue.abortPendingCount,
        retryWaitingCount: input.evidence.queue.retryWaitingCount,
      },
      lifecycle: {
        backlogCount: input.evidence.lifecycle.backlogCount,
        unresolvedAnomalyCount: input.evidence.lifecycle.unresolvedAnomalyCount,
      },
      publication: input.evidence.publication,
      outbox: {
        pendingCount: input.evidence.outbox.pendingCount,
        processingCount: input.evidence.outbox.processingCount,
        deadLetterCount: input.evidence.outbox.deadLetterCount,
      },
      sources: [...input.evidence.sources].map(({ sourceKey, active, latestRunAt }) => ({ sourceKey, active, latestRunAt })).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
      inFlight: input.evidence.inFlight,
      backupRestoreAt: input.evidence.governance.backupRestoreAt,
      backupRestoreExpiresAt: input.evidence.governance.backupRestoreExpiresAt,
    },
    flags,
    requiredApprovals: { roles: [...P5_OWNER_ROLES], distinctActorCount: P5_OWNER_ROLES.length },
  };
}

export function createP5EvidenceDigest(input: P5CanonicalEvidenceInput) {
  return crypto.createHash("sha256").update(canonicalP5Json(createP5CanonicalEvidenceSnapshot(input))).digest("hex");
}

export function evaluateP5RetirementReadiness(input: P5RetirementEvaluationInput): P5RetirementReport {
  const now = input.now ?? new Date();
  const start = new Date(input.observationStart);
  const end = new Date(input.observationEnd);
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  const validDates = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
  const validWindow = validDates && Number.isFinite(hours) && hours >= input.policy.minimumObservationHours && end <= now && start < end;
  const backupAt = input.evidence.governance.backupRestoreAt ? new Date(input.evidence.governance.backupRestoreAt) : null;
  const backupExpiry = input.evidence.governance.backupRestoreExpiresAt ? new Date(input.evidence.governance.backupRestoreExpiresAt) : null;
  const backupCurrent = Boolean(backupAt && backupExpiry && backupAt <= now && backupExpiry > now && now.getTime() - backupAt.getTime() <= input.policy.backupRestoreMaximumAgeHours * 3_600_000);
  const flagOrderLegal = P5_RETIREMENT_FLAG_ORDER.every(([name, expected]) => input.flags[name] === expected);
  const slas = evaluateP5Slas(input.evidence, input.policy);
  const hardSlaKeys = slas.filter((item) => item.status === "critical" || item.status === "unknown").map((item) => item.key);
  const evidenceDigest = createP5EvidenceDigest(input);
  const approvalSet = input.evidence.governance.approvalSets.find((set) => set.evidenceDigest === evidenceDigest);
  const approvalRoles = new Set(approvalSet?.roles ?? []);
  const approvalExpiry = approvalSet?.expiresAt ? new Date(approvalSet.expiresAt) : null;
  const approvalSetCurrent = Boolean(approvalSet?.status === "active" && approvalExpiry && approvalExpiry > now);
  const approvalsPass = approvalSetCurrent
    && approvalSet?.distinctActorCount === P5_OWNER_ROLES.length
    && P5_OWNER_ROLES.every((role) => approvalRoles.has(role));
  const gates: P5RetirementGate[] = [
    { key: "health.available", label: "P5 aggregate health evidence is available", passed: input.evidence.available, detail: input.evidence.available ? "Aggregate RPC returned evidence." : "Migration, credentials, or health RPC is unavailable." },
    { key: "observation.window", label: "Explicit observation window is complete", passed: validWindow, detail: validWindow ? `${hours} observed hours meet the ${input.policy.minimumObservationHours}-hour minimum.` : `A closed window of at least ${input.policy.minimumObservationHours} hours is required.` },
    { key: "observation.coverage", label: "Observation coverage spans the requested window", passed: Boolean(validWindow && input.evidence.compatibility.firstObservedAt && input.evidence.compatibility.lastObservedAt && new Date(input.evidence.compatibility.firstObservedAt) <= start && new Date(input.evidence.compatibility.lastObservedAt) >= end), detail: "First and last aggregate observations must cover the requested window." },
    { key: "observation.full_capture", label: "Observation sampling is 100%", passed: input.observationSampleRate === 1, detail: input.observationSampleRate === 1 ? "The full window uses unsampled compatibility observations." : "Sampled observations cannot prove zero legacy activity; set the bounded sample rate to 1 for the retirement window." },
    { key: "compatibility.zero", label: "No unexplained legacy reads or writes", passed: !input.evidence.compatibility.unexplainedLegacyObserved, detail: input.evidence.compatibility.unexplainedLegacyObserved ? `Legacy compatibility was last observed at ${input.evidence.compatibility.legacyLastSeenAt ?? "an unknown time"}.` : "No unexplained legacy presence was observed in the window." },
    { key: "parity.p0_p3", label: "P0-P3 parity and anomalies pass", passed: input.evidence.lifecycle.unresolvedAnomalyCount === 0 && input.evidence.publication.parityMismatchCount === 0 && input.evidence.publication.quarantineCount === 0 && input.evidence.publication.legacyIdentityDigest === input.evidence.publication.explicitIdentityDigest, detail: "Lifecycle anomalies, publication mismatch/quarantine, and identity digests must all pass." },
    { key: "sla.hard", label: "No hard operational SLO violation", passed: hardSlaKeys.length === 0 && input.evidence.queue.staleLeaseCount === 0, detail: `${hardSlaKeys.length} hard/unknown SLOs and ${input.evidence.queue.staleLeaseCount} stale leases.` },
    { key: "work.conflict", label: "No in-flight legacy/V3 conflict", passed: !input.evidence.inFlight.conflict && input.evidence.inFlight.legacyCount === 0, detail: `${input.evidence.inFlight.legacyCount} legacy and ${input.evidence.inFlight.newCount} V3 in-flight items.` },
    { key: "outbox.healthy", label: "Cache outbox is healthy", passed: input.evidence.outbox.deadLetterCount === 0 && slas.filter((item) => item.key.startsWith("outbox.")).every((item) => item.status === "healthy"), detail: `${input.evidence.outbox.deadLetterCount} dead letters; undelivered age ${input.evidence.outbox.oldestUndeliveredAgeSeconds ?? "unknown"} seconds.` },
    { key: "backup.current", label: "Backup/restore rehearsal evidence is current", passed: backupCurrent, detail: backupCurrent ? "Current rehearsal marker is recorded." : "A current successful backup/restore rehearsal marker is required." },
    { key: "owners.approved", label: "Digest-bound distinct owners approved", passed: approvalsPass, detail: `Matching digest set: ${approvalRoles.size} roles, ${approvalSet?.distinctActorCount ?? 0} distinct actors, ${approvalSetCurrent ? "active" : "missing or expired"}.` },
    { key: "flags.legal_order", label: "Feature flags are in the legal retirement order", passed: flagOrderLegal, detail: flagOrderLegal ? "Authority reads/workers precede disabled compatibility writes." : "One or more required flag states are missing or out of order." },
  ];
  const unsigned = {
    schemaVersion: 1 as const,
    generatedAt: now.toISOString(),
    implementationStatus: "implementation-ready" as const,
    evidenceStatus: gates.every((gate) => gate.passed) ? "passing" as const : "pending" as const,
    observationWindow: { start: validDates ? start.toISOString() : input.observationStart, end: validDates ? end.toISOString() : input.observationEnd, hours: Number.isFinite(hours) ? hours : 0, explicit: true as const },
    gates,
    ready: gates.every((gate) => gate.passed),
  };
  const signature = input.signingKey ? crypto.createHmac("sha256", input.signingKey).update(evidenceDigest).digest("hex") : null;
  return { ...unsigned, evidenceDigest, signature, signatureAlgorithm: signature ? "hmac-sha256" : null };
}
