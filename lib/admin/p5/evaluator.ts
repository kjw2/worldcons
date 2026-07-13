import crypto from "node:crypto";
import { P5_OWNER_ROLES, type P5HealthEvidence, type P5RetirementGate, type P5RetirementReport, type P5SlaResult } from "@/lib/admin/p5/types";
import type { P5OperationalPolicy } from "@/lib/admin/p5/policy";

function metric(key: string, label: string, value: number | null, threshold: { warning: number; critical: number; owner: P5SlaResult["owner"] }, unit: P5SlaResult["unit"]): P5SlaResult {
  const status = value === null ? "unknown" : value > threshold.critical ? "critical" : value > threshold.warning ? "warning" : "healthy";
  return { key, label, owner: threshold.owner, status, value, warningThreshold: threshold.warning, criticalThreshold: threshold.critical, unit };
}

export function evaluateP5Slas(evidence: P5HealthEvidence, policy: P5OperationalPolicy): P5SlaResult[] {
  const results = [
    metric("queue.latency", "명령 큐 대기 시간", evidence.queue.oldestQueuedAgeSeconds ?? ((evidence.queue.states.queued ?? 0) === 0 ? 0 : null), policy.queueLatencySeconds, "seconds"),
    metric("queue.heartbeat", "실행 임대 상태 신호 경과 시간", evidence.queue.oldestHeartbeatAgeSeconds ?? ((evidence.queue.states.running ?? 0) === 0 ? 0 : null), policy.leaseHeartbeatAgeSeconds, "seconds"),
    metric("queue.abort", "중단 완료 시간", evidence.queue.oldestAbortAgeSeconds ?? (evidence.queue.abortPendingCount === 0 ? 0 : null), policy.abortCompletionSeconds, "seconds"),
    metric("queue.retry", "재시도 대기 시간", evidence.queue.oldestRetryAgeSeconds ?? (evidence.queue.retryWaitingCount === 0 ? 0 : null), policy.retryAgeSeconds, "seconds"),
    metric("lifecycle.backlog", "기사 처리 주의 대기 건수", evidence.lifecycle.backlogCount, policy.lifecycleBacklogCount, "count"),
    metric("lifecycle.review", "최장 검토 대기 시간", evidence.lifecycle.oldestReviewAgeSeconds ?? (evidence.lifecycle.backlogCount === 0 ? 0 : null), policy.lifecycleReviewAgeSeconds, "seconds"),
    metric("publication.parity", "공개 데이터 일치", evidence.publication.parityMismatchCount + evidence.publication.quarantineCount, policy.publicationParityCount, "count"),
    metric("outbox.delivery", "캐시 전달 지연", evidence.outbox.oldestUndeliveredAgeSeconds ?? (evidence.outbox.pendingCount + evidence.outbox.processingCount === 0 ? 0 : null), policy.outboxDeliveryAgeSeconds, "seconds"),
    metric("outbox.dead_letter", "캐시 전달 영구 실패", evidence.outbox.deadLetterCount, policy.outboxDeadLetterCount, "count"),
  ];
  for (const source of evidence.sources) {
    if (!source.active) continue;
    const configured = policy.sourceFreshnessOverrides[source.sourceKey] ?? policy.sourceFreshnessSeconds;
    results.push(metric(`source.${source.sourceKey}`, `수집원 최신성: ${source.sourceKey}`, source.freshnessAgeSeconds, { ...configured, owner: "operations" }, "seconds"));
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
    { key: "health.available", label: "P5 통합 상태 근거 사용 가능", passed: input.evidence.available, detail: input.evidence.available ? "통합 RPC에서 운영 근거를 반환했습니다." : "마이그레이션, 인증 정보 또는 상태 RPC를 사용할 수 없습니다." },
    { key: "observation.window", label: "명시적 관찰 기간 완료", passed: validWindow, detail: validWindow ? `${hours}시간의 관찰이 최소 기준 ${input.policy.minimumObservationHours}시간을 충족합니다.` : `종료된 관찰 기간이 최소 ${input.policy.minimumObservationHours}시간 이상이어야 합니다.` },
    { key: "observation.coverage", label: "요청한 전체 기간의 관찰 근거 확보", passed: Boolean(validWindow && input.evidence.compatibility.firstObservedAt && input.evidence.compatibility.lastObservedAt && new Date(input.evidence.compatibility.firstObservedAt) <= start && new Date(input.evidence.compatibility.lastObservedAt) >= end), detail: "최초 및 최종 통합 관찰 시각이 요청한 전체 기간을 포함해야 합니다." },
    { key: "observation.full_capture", label: "관찰 표본 비율 100%", passed: input.observationSampleRate === 1, detail: input.observationSampleRate === 1 ? "전체 기간에 표본 추출 없는 호환 관찰을 사용했습니다." : "표본 관찰만으로는 이전 체계 활동이 없음을 입증할 수 없습니다. 폐기 관찰 기간의 표본 비율을 1로 설정해야 합니다." },
    { key: "compatibility.zero", label: "설명되지 않은 이전 체계 읽기·쓰기 없음", passed: !input.evidence.compatibility.unexplainedLegacyObserved, detail: input.evidence.compatibility.unexplainedLegacyObserved ? `이전 호환 체계가 마지막으로 관찰된 시각: ${input.evidence.compatibility.legacyLastSeenAt ?? "알 수 없음"}.` : "관찰 기간에 설명되지 않은 이전 체계 활동이 없었습니다." },
    { key: "parity.p0_p3", label: "P0-P3 데이터 일치 및 이상 없음", passed: input.evidence.lifecycle.unresolvedAnomalyCount === 0 && input.evidence.publication.parityMismatchCount === 0 && input.evidence.publication.quarantineCount === 0 && input.evidence.publication.legacyIdentityDigest === input.evidence.publication.explicitIdentityDigest, detail: "기사 처리 이상, 공개 불일치·격리 및 식별자 다이제스트가 모두 기준을 충족해야 합니다." },
    { key: "sla.hard", label: "중대 운영 기준 위반 없음", passed: hardSlaKeys.length === 0 && input.evidence.queue.staleLeaseCount === 0, detail: `중대 또는 미확인 운영 기준 ${hardSlaKeys.length}건, 만료된 임대 ${input.evidence.queue.staleLeaseCount}건입니다.` },
    { key: "work.conflict", label: "진행 중인 이전 체계와 V3 업무 충돌 없음", passed: !input.evidence.inFlight.conflict && input.evidence.inFlight.legacyCount === 0, detail: `진행 중인 이전 체계 업무 ${input.evidence.inFlight.legacyCount}건, V3 업무 ${input.evidence.inFlight.newCount}건입니다.` },
    { key: "outbox.healthy", label: "캐시 전달 상태 정상", passed: input.evidence.outbox.deadLetterCount === 0 && slas.filter((item) => item.key.startsWith("outbox.")).every((item) => item.status === "healthy"), detail: `영구 실패 ${input.evidence.outbox.deadLetterCount}건, 최장 미전달 경과 시간 ${input.evidence.outbox.oldestUndeliveredAgeSeconds ?? "알 수 없음"}초입니다.` },
    { key: "backup.current", label: "백업·복구 훈련 근거가 유효함", passed: backupCurrent, detail: backupCurrent ? "유효한 훈련 완료 표시가 기록되어 있습니다." : "최근 성공한 백업·복구 훈련 완료 표시가 필요합니다." },
    { key: "owners.approved", label: "근거 묶음별 담당자 승인 완료", passed: approvalsPass, detail: `일치하는 근거 묶음: 역할 ${approvalRoles.size}개, 서로 다른 작업자 ${approvalSet?.distinctActorCount ?? 0}명, 상태 ${approvalSetCurrent ? "유효" : "없음 또는 만료"}.` },
    { key: "flags.legal_order", label: "기능 플래그가 올바른 폐기 순서에 있음", passed: flagOrderLegal, detail: flagOrderLegal ? "권한 읽기 및 작업자가 호환 쓰기 비활성화보다 먼저 적용되었습니다." : "필수 기능 플래그 중 하나 이상이 없거나 순서가 올바르지 않습니다." },
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
