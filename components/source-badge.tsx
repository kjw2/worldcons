import { cn } from "@/lib/utils/classnames";
import { jurisdictionThemeStyle, themeForSource } from "@/lib/ui/jurisdiction-theme";
import { displaySourceLabel } from "@/lib/ui/source-labels";

export function SourceBadge({ sourceKey, className }: { sourceKey: string; className?: string }) {
  const theme = themeForSource(sourceKey);

  return (
    <span
      style={jurisdictionThemeStyle(theme)}
      className={cn(
        "inline-flex min-h-6 items-center text-xs font-semibold text-[color:var(--country-text)]",
        className,
      )}
    >
      {displaySourceLabel(sourceKey)}
    </span>
  );
}
