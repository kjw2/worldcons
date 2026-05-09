import { cn } from "@/lib/utils/classnames";
import { jurisdictionThemeStyle, themeForSource } from "@/lib/ui/jurisdiction-theme";

const SOURCE_LABELS: Record<string, string> = {
  "de-bverfg": "독일 연방헌재",
  "us-scotus": "미국 연방대법원",
  "fr-conseil-constitutionnel": "프랑스 헌법위원회",
};

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
      {SOURCE_LABELS[sourceKey] ?? sourceKey}
    </span>
  );
}
