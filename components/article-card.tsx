"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { BookOpenText, CalendarDays, Check, ExternalLink, Eye, Share2 } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ArticleListItem } from "@/lib/db/types";
import { SourceBadge } from "@/components/source-badge";
import { TagPill } from "@/components/tag-pill";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { articleCaseNumber } from "@/lib/ui/article-case-number";
import { articleTitleForDisplay } from "@/lib/ui/article-title";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { articleHrefWithReturnTo, articleReturnPathForLocation } from "@/lib/navigation/article-return";
import { safeExternalUrl } from "@/lib/utils/safe-url";

function shouldSaveNavigation(event: MouseEvent<HTMLAnchorElement>) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function formatViewCount(count?: number) {
  return new Intl.NumberFormat("ko-KR").format(Math.max(0, Math.floor(count ?? 0)));
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function TagOverflowPopover({
  tags,
  hiddenTagCount,
  jurisdiction,
}: {
  tags: ArticleListItem["tags"];
  hiddenTagCount: number;
  jurisdiction?: string | null;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`전체 태그 ${tags.length}개 보기`}
        aria-haspopup="true"
        className="focus-ring inline-flex min-h-6 items-center border border-archive-line-strong bg-white px-2 text-[11px] font-medium text-archive-text transition hover:bg-archive-surface hover:text-archive-accent"
      >
        +{hiddenTagCount}
      </button>
      <span className="absolute right-0 top-[calc(100%-1px)] z-30 hidden w-72 max-w-[calc(100vw-2rem)] pt-1 group-hover:block group-focus-within:block">
        <span className="flex flex-wrap gap-1.5 rounded-sm border border-archive-line-strong bg-white p-2">
          {tags.map((tag) => (
            <TagPill key={tag.slug} tag={tag} jurisdiction={jurisdiction} className="max-w-full min-h-6 px-2 text-[11px]" />
          ))}
        </span>
      </span>
    </span>
  );
}

export function ArticleCard({
  article,
  onArticleNavigate,
}: {
  article: ArticleListItem;
  onArticleNavigate?: (slug: string) => void;
}) {
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const theme = themeForJurisdiction(article.jurisdiction);
  const handleArticleLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (shouldSaveNavigation(event)) {
      onArticleNavigate?.(article.slug);
    }
  };
  const visibleTags = article.tags.slice(0, 2);
  const hiddenTagCount = Math.max(0, article.tags.length - visibleTags.length);
  const summaryText = article.oneLineSummary || article.summaryJson?.summary.coreSummary[0] || "요약 준비 중입니다.";
  const title = articleTitleForDisplay(article);
  const caseNumber = articleCaseNumber(article);
  const originalHref = safeExternalUrl(article.originalUrl);
  const viewCountLabel = formatViewCount(article.viewCount);
  const canonicalArticleHref = `/articles/${article.slug}`;
  const articleHref = articleHrefWithReturnTo(article.slug, articleReturnPathForLocation(pathname, searchParams));

  async function shareArticle() {
    const url = new URL(canonicalArticleHref, window.location.origin).toString();
    const sharePayload = {
      title,
      text: summaryText,
      url,
    };

    try {
      if (navigator.share) {
        await navigator.share(sharePayload);
        return;
      }

      if (await copyTextToClipboard(url)) {
        setShareState("copied");
        window.setTimeout(() => setShareState("idle"), 1600);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      if (await copyTextToClipboard(url).catch(() => false)) {
        setShareState("copied");
        window.setTimeout(() => setShareState("idle"), 1600);
      }
    }
  }

  return (
    <article
      data-article-slug={article.slug}
      style={jurisdictionThemeStyle(theme)}
      className="relative border-b border-archive-line px-1 py-5 last:border-b-0 sm:grid sm:grid-cols-[132px_minmax(0,1fr)_auto] sm:gap-5 sm:px-3"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-archive-muted sm:mb-0 sm:block">
        <span className="inline-flex items-center gap-1.5 tabular-nums sm:flex">
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          {formattedArticleDate(article)}
        </span>
        <SourceBadge sourceKey={article.sourceKey} className="sm:mt-2" />
        <span className="text-[color:var(--country-text)] sm:mt-1 sm:block">{displayArticleTypeLabel(article)}</span>
      </div>

      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold leading-7 text-archive-heading sm:text-[18px]">
          <IntentPrefetchLink href={articleHref} onClick={handleArticleLinkClick} className="focus-ring rounded-sm hover:text-archive-accent">
            {title}
            {caseNumber ? <span className="ml-1 text-[0.72em] font-medium text-archive-muted">({caseNumber})</span> : null}
            <RecentDecisionMark publishedAt={article.originalPublishedAt} />
          </IntentPrefetchLink>
        </h2>
        <p className="mt-2 line-clamp-2 max-w-[72ch] text-sm leading-6 text-archive-text">{summaryText}</p>

        {visibleTags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {visibleTags.map((tag) => (
              <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} className="min-h-6 px-2 text-[11px]" />
            ))}
            {hiddenTagCount > 0 ? (
              <TagOverflowPopover tags={article.tags} hiddenTagCount={hiddenTagCount} jurisdiction={article.jurisdiction} />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-archive-muted sm:mt-0 sm:flex-col sm:items-end sm:justify-start">
        <span aria-label={`조회 ${viewCountLabel}회`} title={`조회 ${viewCountLabel}회`} className="inline-flex items-center gap-1 text-xs tabular-nums">
          <Eye className="size-3.5" aria-hidden="true" />
          {viewCountLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={shareArticle}
            aria-label={`공유: ${title}`}
            title={shareState === "copied" ? "링크 복사됨" : "공유"}
            className="focus-ring inline-flex size-8 items-center justify-center rounded-sm text-archive-muted transition-colors hover:bg-archive-surface-soft hover:text-archive-accent"
          >
            {shareState === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Share2 className="size-4" aria-hidden="true" />}
          </button>
          <IntentPrefetchLink
            href={articleHref}
            onClick={handleArticleLinkClick}
            aria-label={`자세히 읽기: ${title}`}
            title="자세히 읽기"
            className="focus-ring inline-flex size-8 items-center justify-center rounded-sm text-archive-muted transition-colors hover:bg-archive-surface-soft hover:text-archive-accent"
          >
            <BookOpenText className="size-4" aria-hidden="true" />
          </IntentPrefetchLink>
          {originalHref ? (
            <a
              href={originalHref}
              target="_blank"
              rel="noreferrer"
              aria-label={`공식 원문 보기: ${title}`}
              title="공식 원문"
              className="focus-ring inline-flex size-8 items-center justify-center rounded-sm text-archive-muted transition-colors hover:bg-archive-surface-soft hover:text-archive-accent"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
