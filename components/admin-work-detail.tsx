import Link from "next/link";
import { ArrowLeft, Clock3, ExternalLink, KeyRound, Radio, ShieldCheck } from "lucide-react";
import { AdminWorkActionButton } from "@/components/admin-work-action";
import { AdminWorkState } from "@/components/admin-work-queue";
import type { AdminWorkItemDetail } from "@/lib/admin/p4/types";

function formatDateTime(value?: string | null) {
  if (!value) return "Not present";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not present";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Seoul" }).format(date);
}

export function AdminWorkDetail({ detail, csrfToken }: { detail: AdminWorkItemDetail; csrfToken: string }) {
  const { item } = detail;
  return (
    <div className="min-w-0 py-6">
      <header className="border-b border-rule px-4 pb-6 sm:px-6">
        <Link href="/admin/work" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink/65 hover:bg-parchment"><ArrowLeft className="size-4" aria-hidden="true" />Work queue</Link>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-court">{item.type} · {item.stage}</p>
            <h1 className="mt-1 max-w-4xl break-words text-2xl font-semibold text-ink">{item.title}</h1>
            <p className="mt-2 break-all text-sm text-ink/52">{item.target}</p>
          </div>
          <AdminWorkActionButton kind={item.type} id={item.id} action={item.safeAction} csrfToken={csrfToken} disabledReason={item.actionDisabledReason} />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div><p className="mb-1 text-xs font-semibold text-ink/45">Execution</p><AdminWorkState title="Execution state" label={item.execution} /></div>
          <div><p className="mb-1 text-xs font-semibold text-ink/45">Article lifecycle</p><AdminWorkState title="Article lifecycle state" label={item.lifecycle} /></div>
          <div><p className="mb-1 text-xs font-semibold text-ink/45">Publication</p><AdminWorkState title="Publication state" label={item.publication} /></div>
        </div>
      </header>

      {detail.warnings.length > 0 ? <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6">{detail.warnings.join(" ")}</div> : null}

      <section className="border-b border-rule px-4 py-5 sm:px-6" aria-labelledby="authority-status">
        <div className="flex items-center gap-2"><Radio className="size-4 text-court" aria-hidden="true" /><h2 id="authority-status" className="text-base font-semibold text-ink">Lease and authority</h2></div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-xs font-semibold text-ink/45">Heartbeat</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.heartbeatAt)}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">Lease expires</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.leaseExpiresAt)}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">Fencing token</dt><dd className="mt-1 break-all font-mono text-xs text-ink/70">{detail.fencingToken ?? "Not present"}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">Abort requested</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.abortRequestedAt)}</dd></div>
        </dl>
      </section>

      <section className="border-b border-rule bg-white px-4 py-5 sm:px-6" aria-labelledby="work-timeline">
        <div className="flex items-center gap-2"><Clock3 className="size-4 text-court" aria-hidden="true" /><h2 id="work-timeline" className="text-base font-semibold text-ink">Safe operational timeline</h2></div>
        <p className="mt-1 text-xs text-ink/50">Payloads, URLs, source text, content, provider output, and secrets are intentionally omitted.</p>
        {detail.timeline.length === 0 ? <div className="mt-5 border-y border-dashed border-rule py-10 text-center text-sm text-ink/55">No safe events are available for this item.</div> : (
          <ol className="mt-5 grid gap-0 border-t border-rule">
            {detail.timeline.map((event) => (
              <li key={`${event.category}:${event.id}`} className="grid gap-2 border-b border-rule py-3 text-sm md:grid-cols-[150px_minmax(180px,1fr)_160px_minmax(180px,1fr)] md:items-start">
                <div className="text-xs text-ink/50"><span className="block font-semibold uppercase text-court">{event.category}</span><span className="mt-1 block">{formatDateTime(event.occurredAt)}</span></div>
                <div className="min-w-0"><p className="break-words font-semibold text-ink">{event.title}</p><p className="mt-1 break-words text-xs text-ink/55">{event.state}</p></div>
                <div className="min-w-0 text-xs"><p className="font-semibold text-ink/45">Actor</p><p className="mt-1 break-all text-ink/65">{event.actor ?? "System"}</p></div>
                <div className="min-w-0 text-xs"><p className="font-semibold text-ink/45">Reason / correlation</p><p className="mt-1 break-words text-ink/65">{event.reason ?? "No bounded reason"}</p>{event.correlationId ? <p className="mt-1 break-all font-mono text-ink/48">{event.correlationId}</p> : null}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="related-admin-pages">
        <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-court" aria-hidden="true" /><h2 id="related-admin-pages" className="text-base font-semibold text-ink">Related administrator pages</h2></div>
        <div className="mt-4 flex flex-wrap gap-2">
          {detail.links.map((link) => <Link key={link.href} href={link.href} className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink/65 hover:bg-parchment">{link.label}<ExternalLink className="size-3.5" aria-hidden="true" /></Link>)}
        </div>
        <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-ink/48"><KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><p>Review ownership and manual outbox transitions are shown as unavailable because no accepted P2/P3 authority supports them. Existing article edit, retranslation, resummary, and immutable snapshot controls remain on the article page.</p></div>
      </section>
    </div>
  );
}
