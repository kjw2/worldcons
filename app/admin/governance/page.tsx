import { redirect } from "next/navigation";
import { AlertTriangle, Archive, CheckCircle2, Clock3, DatabaseBackup, ShieldCheck, XCircle } from "lucide-react";
import { AdminGovernanceApproval } from "@/components/admin-governance-approval";
import { evaluateP5RetirementReadiness, evaluateP5Slas, P5_RETIREMENT_FLAG_ORDER } from "@/lib/admin/p5/evaluator";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { getP5HealthEvidence } from "@/lib/admin/p5/repository";
import { P5_OWNER_ROLES, type P5SlaStatus } from "@/lib/admin/p5/types";
import { resolveP5OwnerRoleBindings } from "@/lib/admin/p5/owner-bindings";
import { createAdminCsrfToken, getAuthorizedAdminPageIdentity } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function statusClass(status: P5SlaStatus) {
  if (status === "healthy") return "border-mint/35 bg-mint/10 text-mint";
  if (status === "warning") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-court/25 bg-court/5 text-court";
}

function formatMetric(value: number | null, unit: "seconds" | "count") {
  if (value === null) return "알 수 없음";
  if (unit === "count") return `${new Intl.NumberFormat("ko-KR").format(value)}건`;
  if (value < 60) return `${value}초`;
  if (value < 3600) return `${Math.round(value / 60)}분`;
  return `${Math.round(value / 360) / 10}시간`;
}

const ownerLabels = { operations: "운영", data: "데이터", security: "보안" } as const;
const slaStatusLabels: Record<P5SlaStatus, string> = { healthy: "정상", warning: "주의", critical: "위험", unknown: "알 수 없음" };
const retentionLabels: Record<string, string> = {
  commandAttemptsDue: "명령 실행 시도",
  commandEventsDue: "명령 이벤트",
  lifecycleEventsDue: "기사 처리 이벤트",
  publicationHistoryDue: "공개 이력",
  contentVersionsDue: "콘텐츠 버전",
  compatibilityObservationsDue: "호환 관찰 기록",
  deliveredOutboxDue: "전달 완료 캐시",
  deadLetterOutboxDue: "영구 실패 캐시",
};

export default async function AdminGovernancePage() {
  const identity = await getAuthorizedAdminPageIdentity();
  if (!identity) redirect("/admin/login");
  const policy = resolveP5OperationalPolicy();
  const now = new Date();
  const observationStart = new Date(now.getTime() - policy.minimumObservationHours * 3_600_000).toISOString();
  const observationEnd = now.toISOString();
  const evidence = await getP5HealthEvidence({ observationStart, observationEnd, policy, now });
  const slas = evaluateP5Slas(evidence, policy);
  const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name]) => [name, process.env[name]?.trim().toLowerCase() === "true"]));
  const observationSampleRate = Number(process.env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0");
  const readiness = evaluateP5RetirementReadiness({ evidence, policy, observationStart, observationEnd, flags, observationSampleRate, now });
  const ownerBindings = resolveP5OwnerRoleBindings(identity);
  const matchingApprovals = evidence.governance.approvalSets.find((set) => set.evidenceDigest === readiness.evidenceDigest && set.status === "active");
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const retention = Object.entries(evidence.retention).filter(([key]) => key !== "legalHoldActive") as Array<[string, number]>;
  const hardViolations = slas.filter((sla) => sla.status === "critical" || sla.status === "unknown").length;

  return (
    <div className="min-w-0 py-6">
      <header className="px-4 pb-5 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-semibold text-court">P5 운영 거버넌스</p><h1 className="mt-1 text-2xl font-semibold text-ink">운영 상태 및 폐기 근거</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">관찰 및 승인 기준을 모두 통과할 때까지 운영 근거를 명시적인 대기 상태로 유지합니다.</p></div>
          <span className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold ${readiness.ready ? statusClass("healthy") : statusClass("warning")}`}>{readiness.ready ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}{readiness.ready ? "근거 충족" : "근거 확인 필요"}</span>
        </div>
      </header>

      {!evidence.available ? <div role="alert" className="border-y border-court/20 bg-court/5 px-4 py-3 text-sm text-court sm:px-6">P5 통합 근거를 사용할 수 없습니다. 추가 마이그레이션과 서비스 역할 RPC를 사용할 수 있을 때까지 전환 준비 상태를 보류합니다.</div> : null}

      <section className="border-y border-rule bg-white" aria-labelledby="governance-summary">
        <h2 id="governance-summary" className="sr-only">거버넌스 요약</h2>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["중대 운영 기준 위반", String(hardViolations), Clock3],
            ["공개 데이터 불일치", String(evidence.publication.parityMismatchCount), ShieldCheck],
            ["관찰 구간", String(evidence.compatibility.bucketCount), DatabaseBackup],
            ["보존 처리 대상", String(retention.reduce((sum, [, value]) => sum + value, 0)), Archive],
          ].map(([label, value, Icon], index) => <div key={String(label)} className="min-h-24 border-b border-rule px-4 py-4 sm:px-5 xl:border-b-0 xl:border-r xl:last:border-r-0"><div className="flex items-center justify-between gap-3 text-xs font-semibold text-ink/52"><span>{String(label)}</span><Icon className="size-4 text-court" aria-hidden="true" /></div><p className="mt-2 text-2xl font-semibold text-ink">{String(value)}</p>{index === 2 ? <p className="mt-1 text-xs text-ink/45">최소 {policy.minimumObservationHours}시간</p> : null}</div>)}
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="sla-status">
        <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold text-court">운영 기준</p><h2 id="sla-status" className="mt-1 text-base font-semibold text-ink">정책 기준별 상태</h2></div><span className="text-xs text-ink/48">{slas.length}개 항목</span></div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{slas.map((sla) => <div key={sla.key} className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] gap-3 border border-rule bg-white p-3"><div className="min-w-0"><p className="break-words text-sm font-semibold text-ink">{sla.label}</p><p className="mt-1 text-xs text-ink/48">담당: {ownerLabels[sla.owner]}</p></div><div className="text-right"><span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${statusClass(sla.status)}`}>{slaStatusLabels[sla.status]}</span><p className="mt-2 text-sm font-semibold text-ink">{formatMetric(sla.value, sla.unit)}</p></div></div>)}</div>
      </section>

      <section className="grid border-y border-rule bg-white lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)]" aria-labelledby="retirement-gates">
        <div className="min-w-0 border-b border-rule px-4 py-5 sm:px-6 lg:border-b-0 lg:border-r"><p className="text-xs font-semibold text-court">이전 체계 폐기</p><h2 id="retirement-gates" className="mt-1 text-base font-semibold text-ink">전환 차단 기준</h2><div className="mt-3 divide-y divide-rule">{readiness.gates.map((gate) => <div key={gate.key} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 py-3">{gate.passed ? <CheckCircle2 className="mt-0.5 size-4 text-mint" aria-hidden="true" /> : <XCircle className="mt-0.5 size-4 text-court" aria-hidden="true" />}<div className="min-w-0"><p className="text-sm font-semibold text-ink">{gate.label}</p><p className="mt-1 break-words text-xs leading-5 text-ink/52">{gate.detail}</p></div></div>)}</div></div>
        <div className="px-4 py-5 sm:px-6"><p className="text-xs font-semibold text-court">담당자</p><h2 className="mt-1 text-base font-semibold text-ink">근거 묶음별 승인</h2><p className="mt-2 text-xs leading-5 text-ink/52">각 필수 역할은 이 근거 스냅샷에 별도로 연결된 작업자가 승인해야 합니다.</p><div className="mt-3">{P5_OWNER_ROLES.map((role) => <AdminGovernanceApproval key={role} role={role} approved={matchingApprovals?.roles.includes(role) === true} permitted={ownerBindings.permittedRoles.includes(role)} bindingValid={ownerBindings.valid} csrfToken={csrfToken} evidenceDigest={readiness.evidenceDigest} observationStart={observationStart} observationEnd={observationEnd} />)}</div><div className="mt-5 border-t border-rule pt-4"><p className="text-xs font-semibold text-ink/58">백업·복구 훈련</p><p className="mt-1 break-words text-sm text-ink">{evidence.governance.backupRestoreAt ?? "유효한 근거 표시 없음"}</p><p className="mt-1 text-xs text-ink/45">만료: {evidence.governance.backupRestoreExpiresAt ?? "기록 없음"}</p></div></div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="retention-plan"><div className="mb-3"><p className="text-xs font-semibold text-court">보존 정책</p><h2 id="retention-plan" className="mt-1 text-base font-semibold text-ink">모의 실행 처리 대상</h2></div><div className="hidden overflow-x-auto md:block"><table className="min-w-[680px] table-fixed divide-y divide-rule border-y border-rule bg-white text-sm"><thead className="bg-parchment"><tr className="text-left text-xs font-semibold text-ink/58"><th className="px-4 py-3">영역</th><th className="px-4 py-3">대상</th><th className="px-4 py-3">처리 방식</th></tr></thead><tbody className="divide-y divide-rule">{retention.map(([key, count]) => <tr key={key}><td className="break-words px-4 py-3 font-semibold text-ink">{retentionLabels[key] ?? key}</td><td className="px-4 py-3">{count}건</td><td className="px-4 py-3 text-ink/55">{key === "compatibilityObservationsDue" || key === "deliveredOutboxDue" ? "보호된 일괄 처리 가능" : "보관 또는 변경 불가 보존"}</td></tr>)}</tbody></table></div><div className="grid divide-y divide-rule border-y border-rule bg-white md:hidden">{retention.map(([key, count]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3"><span className="break-words text-sm font-semibold text-ink">{retentionLabels[key] ?? key}</span><span className="text-sm text-ink/65">{count}건</span></div>)}</div>{evidence.retention.legalHoldActive ? <p role="status" className="mt-3 text-sm font-semibold text-court">활성 법적 보존 조치로 인해 유지 관리 적용 모드가 차단되었습니다.</p> : null}</section>
    </div>
  );
}
