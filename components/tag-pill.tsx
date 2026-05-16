import { Hash } from "lucide-react";
import { TrackedLink } from "@/components/tracked-link";
import type { TagSummary } from "@/lib/db/types";
import { cn } from "@/lib/utils/classnames";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

export function TagPill({
  tag,
  jurisdiction,
  className,
}: {
  tag: Pick<TagSummary, "slug" | "name" | "type">;
  jurisdiction?: string | null;
  className?: string;
}) {
  const theme = themeForJurisdiction(jurisdiction);

  return (
    <TrackedLink
      href={`/tags/${tag.slug}`}
      event={{ eventType: "tag_click", tagSlug: tag.slug, tagName: tag.name, jurisdiction }}
      style={jurisdictionThemeStyle(theme)}
      className={cn(
        "focus-ring inline-flex min-h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition",
        "border-[color:var(--country-border)] bg-[color:var(--country-accent-softer)] text-[color:var(--country-text)] hover:bg-[color:var(--country-accent-soft)]",
        className,
      )}
    >
      <Hash className="size-3.5" aria-hidden="true" />
      <span>{tag.name}</span>
    </TrackedLink>
  );
}
