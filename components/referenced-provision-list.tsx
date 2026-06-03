import type { ReferencedProvision } from "@/lib/db/types";

function provisionLabel(provision: ReferencedProvision) {
  return [provision.lawName, provision.article].map((item) => item.trim()).filter(Boolean).join(" ");
}

export function ReferencedProvisionList({ provisions }: { provisions: ReferencedProvision[] }) {
  const visibleProvisions = provisions.filter((provision) => provisionLabel(provision));

  if (visibleProvisions.length === 0) {
    return <p className="text-sm text-ink-muted">확인된 참조 조문이 없습니다.</p>;
  }

  return (
    <ul className="space-y-3">
      {visibleProvisions.map((provision, index) => (
        <li key={`${provision.jurisdiction}-${provision.lawName}-${provision.article}-${index}`} className="rounded-lg border border-line bg-surface-muted/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-ink">{provisionLabel(provision)}</strong>
            <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-ink-muted">신뢰도 {provision.confidence}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-muted">{provision.description}</p>
        </li>
      ))}
    </ul>
  );
}
