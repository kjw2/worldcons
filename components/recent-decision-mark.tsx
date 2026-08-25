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
        "ml-2 inline-flex shrink-0 -translate-y-px items-center border border-[#b42318]/35 px-1 py-0.5 align-middle text-[11px] font-bold leading-none tracking-normal text-[#9f1d14]",
        className,
      )}
    >
      NEW
    </span>
  );
}
