import { cn } from "@/lib/utils/classnames";
import { isRecentDecisionDate } from "@/lib/utils/dates";

export function RecentDecisionMark({
  publishedAt,
  className,
}: {
  publishedAt?: string | null;
  className?: string;
}) {
  if (!isRecentDecisionDate(publishedAt)) return null;

  return (
    <span
      aria-label="최근 선고"
      title="선고일 기준 15일 이내"
      className={cn(
        "ml-1.5 inline-flex size-[18px] shrink-0 -translate-y-px items-center justify-center rounded-full bg-[#c62828] align-middle text-[9px] font-extrabold leading-none tracking-normal text-white ring-1 ring-[#991b1b]/20",
        className,
      )}
    >
      N
    </span>
  );
}
