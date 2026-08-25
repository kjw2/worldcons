import type { ReferencedProvision } from "@/lib/db/types";
import { provisionReviewLabel } from "@/lib/ui/provision-confidence";

function provisionLabel(provision: ReferencedProvision) {
  return [provision.lawName, provision.article].map((item) => item.trim()).filter(Boolean).join(" ");
}

function ProvisionReviewBadge({ confidence }: { confidence: ReferencedProvision["confidence"] }) {
  const label = provisionReviewLabel(confidence);
  return label ? <span className="border-l border-archive-line pl-2 text-xs font-medium text-ink-muted">{label}</span> : null;
}

export function ReferencedProvisionList({ provisions }: { provisions: ReferencedProvision[] }) {
  const visibleProvisions = provisions.filter((provision) => provisionLabel(provision));

  if (visibleProvisions.length === 0) {
    return <p className="text-sm text-ink-muted">확인된 참조 조문이 없습니다.</p>;
  }

  return (
    <ul className="border-y border-archive-line-strong bg-white">
      {visibleProvisions.map((provision, index) => (
        <li key={`${provision.jurisdiction}-${provision.lawName}-${provision.article}-${index}`} className="border-b border-archive-line px-1 py-4 last:border-b-0 sm:px-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-ink">{provisionLabel(provision)}</strong>
            <ProvisionReviewBadge confidence={provision.confidence} />
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-muted">{provision.description}</p>
        </li>
      ))}
    </ul>
  );
}
