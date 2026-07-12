import { redirect } from "next/navigation";
import { AlertTriangle, Archive, CheckCircle2, Clock3, DatabaseBackup, ShieldCheck, XCircle } from "lucide-react";
import { AdminGovernanceApproval } from "@/components/admin-governance-approval";
import { adminGovernanceUiEnabled } from "@/lib/admin/p4/flags";
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
  if (value === null) return "Unknown";
  if (unit === "count") return new Intl.NumberFormat("en-US").format(value);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 360) / 10}h`;
}

export default async function AdminGovernancePage() {
  const identity = await getAuthorizedAdminPageIdentity();
  if (!identity) redirect("/admin/login");
  if (!adminGovernanceUiEnabled()) redirect("/admin");
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
          <div><p className="text-xs font-semibold uppercase text-court">P5 operational governance</p><h1 className="mt-1 text-2xl font-semibold text-ink">Health & retirement evidence</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">Implementation-ready controls with production evidence kept explicitly pending until the observation and approval gates pass.</p></div>
          <span className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold ${readiness.ready ? statusClass("healthy") : statusClass("warning")}`}>{readiness.ready ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}{readiness.ready ? "Evidence passing" : "Evidence pending"}</span>
        </div>
      </header>

      {!evidence.available ? <div role="alert" className="border-y border-court/20 bg-court/5 px-4 py-3 text-sm text-court sm:px-6">P5 aggregate evidence is unavailable. Readiness remains blocked until the additive migration and service-role RPC are available.</div> : null}

      <section className="border-y border-rule bg-white" aria-labelledby="governance-summary">
        <h2 id="governance-summary" className="sr-only">Governance summary</h2>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Hard SLA violations", String(hardViolations), Clock3],
            ["Parity mismatches", String(evidence.publication.parityMismatchCount), ShieldCheck],
            ["Observation buckets", String(evidence.compatibility.bucketCount), DatabaseBackup],
            ["Retention items due", String(retention.reduce((sum, [, value]) => sum + value, 0)), Archive],
          ].map(([label, value, Icon], index) => <div key={String(label)} className="min-h-24 border-b border-rule px-4 py-4 sm:px-5 xl:border-b-0 xl:border-r xl:last:border-r-0"><div className="flex items-center justify-between gap-3 text-xs font-semibold text-ink/52"><span>{String(label)}</span><Icon className="size-4 text-court" aria-hidden="true" /></div><p className="mt-2 text-2xl font-semibold text-ink">{String(value)}</p>{index === 2 ? <p className="mt-1 text-xs text-ink/45">Minimum {policy.minimumObservationHours} hours</p> : null}</div>)}
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="sla-status">
        <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase text-court">Service levels</p><h2 id="sla-status" className="mt-1 text-base font-semibold text-ink">Bounded policy status</h2></div><span className="text-xs text-ink/48">{slas.length} checks</span></div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{slas.map((sla) => <div key={sla.key} className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] gap-3 border border-rule bg-white p-3"><div className="min-w-0"><p className="break-words text-sm font-semibold text-ink">{sla.label}</p><p className="mt-1 text-xs capitalize text-ink/48">Owner: {sla.owner}</p></div><div className="text-right"><span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold capitalize ${statusClass(sla.status)}`}>{sla.status}</span><p className="mt-2 text-sm font-semibold text-ink">{formatMetric(sla.value, sla.unit)}</p></div></div>)}</div>
      </section>

      <section className="grid border-y border-rule bg-white lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)]" aria-labelledby="retirement-gates">
        <div className="min-w-0 border-b border-rule px-4 py-5 sm:px-6 lg:border-b-0 lg:border-r"><p className="text-xs font-semibold uppercase text-court">Retirement</p><h2 id="retirement-gates" className="mt-1 text-base font-semibold text-ink">Exact blocked gates</h2><div className="mt-3 divide-y divide-rule">{readiness.gates.map((gate) => <div key={gate.key} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 py-3">{gate.passed ? <CheckCircle2 className="mt-0.5 size-4 text-mint" aria-hidden="true" /> : <XCircle className="mt-0.5 size-4 text-court" aria-hidden="true" />}<div className="min-w-0"><p className="text-sm font-semibold text-ink">{gate.label}</p><p className="mt-1 break-words text-xs leading-5 text-ink/52">{gate.detail}</p></div></div>)}</div></div>
        <div className="px-4 py-5 sm:px-6"><p className="text-xs font-semibold uppercase text-court">Ownership</p><h2 className="mt-1 text-base font-semibold text-ink">Digest-bound approvals</h2><p className="mt-2 text-xs leading-5 text-ink/52">Each required role must be approved by a separately bound operator for this exact evidence snapshot.</p><div className="mt-3">{P5_OWNER_ROLES.map((role) => <AdminGovernanceApproval key={role} role={role} approved={matchingApprovals?.roles.includes(role) === true} permitted={ownerBindings.permittedRoles.includes(role)} bindingValid={ownerBindings.valid} csrfToken={csrfToken} evidenceDigest={readiness.evidenceDigest} observationStart={observationStart} observationEnd={observationEnd} />)}</div><div className="mt-5 border-t border-rule pt-4"><p className="text-xs font-semibold text-ink/58">Backup/restore rehearsal</p><p className="mt-1 break-words text-sm text-ink">{evidence.governance.backupRestoreAt ?? "No current evidence marker"}</p><p className="mt-1 text-xs text-ink/45">Expires: {evidence.governance.backupRestoreExpiresAt ?? "not recorded"}</p></div></div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="retention-plan"><div className="mb-3"><p className="text-xs font-semibold uppercase text-court">Retention</p><h2 id="retention-plan" className="mt-1 text-base font-semibold text-ink">Dry-run due counts</h2></div><div className="hidden overflow-x-auto md:block"><table className="min-w-[680px] table-fixed divide-y divide-rule border-y border-rule bg-white text-sm"><thead className="bg-parchment"><tr className="text-left text-xs font-semibold text-ink/58"><th className="px-4 py-3">Domain</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Disposition</th></tr></thead><tbody className="divide-y divide-rule">{retention.map(([key, count]) => <tr key={key}><td className="break-words px-4 py-3 font-semibold text-ink">{key}</td><td className="px-4 py-3">{count}</td><td className="px-4 py-3 text-ink/55">{key === "compatibilityObservationsDue" || key === "deliveredOutboxDue" ? "Guarded batch eligible" : "Archive or immutable retention"}</td></tr>)}</tbody></table></div><div className="grid divide-y divide-rule border-y border-rule bg-white md:hidden">{retention.map(([key, count]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3"><span className="break-words text-sm font-semibold text-ink">{key}</span><span className="text-sm text-ink/65">{count}</span></div>)}</div>{evidence.retention.legalHoldActive ? <p role="status" className="mt-3 text-sm font-semibold text-court">An active legal hold blocks maintenance apply mode.</p> : null}</section>
    </div>
  );
}
