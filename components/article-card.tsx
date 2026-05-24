"use client";

import Link from "next/link";
import { BookOpenText, CalendarDays, ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import type { ArticleListItem } from "@/lib/db/types";
import { SourceBadge } from "@/components/source-badge";
import { TagPill } from "@/components/tag-pill";
import { surfaceCardClassName } from "@/components/ui/surface-card";
import { formatDisplayDate } from "@/lib/utils/dates";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

const typeLabels: Record<string, string> = {
  news: "뉴스",
  press_release: "보도자료",
  decision: "결정",
  opinion: "의견",
  order: "명령",
  other: "기타",
};

function shouldSaveNavigation(event: MouseEvent<HTMLAnchorElement>) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function ArticleCard({
  article,
  onArticleNavigate,
}: {
  article: ArticleListItem;
  onArticleNavigate?: (slug: string) => void;
}) {
  const theme = themeForJurisdiction(article.jurisdiction);
  const handleArticleLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (shouldSaveNavigation(event)) {
      onArticleNavigate?.(article.slug);
    }
  };
  const visibleTags = article.tags.slice(0, 2);
  const hiddenTagCount = Math.max(0, article.tags.length - visibleTags.length);
  const summaryText = article.oneLineSummary || article.summaryJson?.summary.coreSummary[0] || "요약 준비 중입니다.";
  const title = article.koreanTitle || article.originalTitle || "제목 미상";

  return (
    <article
      data-article-slug={article.slug}
      style={jurisdictionThemeStyle(theme)}
      className={surfaceCardClassName("interactive", "flex h-full flex-col overflow-hidden border-line bg-white p-4")}
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <SourceBadge sourceKey={article.sourceKey} className="min-h-6 rounded-full bg-[color:var(--country-accent-softer)] px-2 text-[11px] font-semibold" />
        <span className="inline-flex min-h-6 items-center rounded-full border border-[color:var(--country-border)] bg-white px-2 text-[11px] font-semibold text-[color:var(--country-text)]">
          {typeLabels[article.contentType]}
        </span>
      </div>

      <h2 className="line-clamp-2 text-base font-bold leading-6 tracking-normal text-ink">
        <Link href={`/articles/${article.slug}`} onClick={handleArticleLinkClick} className="focus-ring rounded-sm hover:text-primary">
          {title}
        </Link>
      </h2>

      <p className="mt-3 line-clamp-3 text-sm leading-6 text-ink-muted">{summaryText}</p>

      {visibleTags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} className="min-h-6 px-2 text-[11px]" />
          ))}
          {hiddenTagCount > 0 ? (
            <span className="inline-flex min-h-6 items-center rounded-md border border-line bg-white px-2 text-[11px] font-medium text-ink-muted">
              +{hiddenTagCount}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-4 grow" aria-hidden="true" />

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-xs text-ink-subtle">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{formatDisplayDate(article.originalPublishedAt)}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/articles/${article.slug}`}
            onClick={handleArticleLinkClick}
            aria-label={`자세히 읽기: ${title}`}
            title="자세히 읽기"
            className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-ink-subtle transition hover:bg-surface-muted hover:text-primary"
          >
            <BookOpenText className="size-4" aria-hidden="true" />
          </Link>
          {article.originalUrl ? (
            <a
              href={article.originalUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`공식 원문 보기: ${title}`}
              title="공식 원문"
              className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-ink-subtle transition hover:bg-surface-muted hover:text-court"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
