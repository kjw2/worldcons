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
      className={cn("ml-1.5 inline-block align-[0.15em] text-[10px] font-bold leading-none text-[#b42318]", className)}
    >
      N
    </span>
  );
}
