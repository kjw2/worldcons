import { Hash } from "lucide-react";
import { TrackedLink } from "@/components/tracked-link";
import type { TagSummary } from "@/lib/db/types";
import { cn } from "@/lib/utils/classnames";
import { isIndexablePublicTag } from "@/lib/seo/public-urls";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

export function TagPill({
  tag,
  jurisdiction,
  className,
}: {
  tag: Pick<TagSummary, "slug" | "name" | "type"> & { articleCount?: number | null };
  jurisdiction?: string | null;
  className?: string;
}) {
  const theme = themeForJurisdiction(jurisdiction);
  const sharedProps = {
    style: jurisdictionThemeStyle(theme),
    className: cn(
      "inline-flex min-h-7 items-center gap-1 rounded-sm border px-2.5 text-xs font-medium",
      "border-[color:var(--country-border)] bg-[color:var(--country-accent-softer)] text-[color:var(--country-text)]",
      className,
    ),
  };
  const content = (
    <>
      <Hash className="size-3.5" aria-hidden="true" />
      <span>{tag.name}</span>
    </>
  );

  if (!isIndexablePublicTag(tag)) {
    return <span {...sharedProps}>{content}</span>;
  }

  return (
    <TrackedLink
      href={`/tags/${tag.slug}`}
      event={{ eventType: "tag_click", tagSlug: tag.slug, tagName: tag.name, jurisdiction }}
      {...sharedProps}
      className={cn(sharedProps.className, "focus-ring transition hover:bg-[color:var(--country-accent-soft)]")}
    >
      {content}
    </TrackedLink>
  );
}
