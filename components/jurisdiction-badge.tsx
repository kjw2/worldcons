import { cn } from "@/lib/utils/classnames";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

export function JurisdictionBadge({ jurisdiction, className }: { jurisdiction: string; className?: string }) {
  const theme = themeForJurisdiction(jurisdiction);

  return (
    <span
      style={jurisdictionThemeStyle(theme)}
      className={cn(
        "inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold",
        "border-[color:var(--country-border)] bg-[color:var(--country-accent-soft)] text-[color:var(--country-text)]",
        className,
      )}
    >
      {jurisdiction}
    </span>
  );
}
