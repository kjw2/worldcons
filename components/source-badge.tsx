import { cn } from "@/lib/utils/classnames";
import { jurisdictionThemeStyle, themeForSource } from "@/lib/ui/jurisdiction-theme";
import { displaySourceLabel } from "@/lib/ui/source-labels";

export function SourceBadge({ sourceKey, className }: { sourceKey: string; className?: string }) {
  const theme = themeForSource(sourceKey);

  return (
    <span
      style={jurisdictionThemeStyle(theme)}
      className={cn(
        "inline-flex min-h-7 items-center rounded-md border bg-white px-2.5 text-xs font-medium",
        "border-[color:var(--country-border)] text-[color:var(--country-text)]",
        className,
      )}
    >
      {displaySourceLabel(sourceKey)}
    </span>
  );
}
