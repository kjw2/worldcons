"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { BookOpenText, CalendarDays, Check, ExternalLink, Eye, Share2 } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ArticleListItem } from "@/lib/db/types";
import { SourceBadge } from "@/components/source-badge";
import { TagPill } from "@/components/tag-pill";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { surfaceCardClassName } from "@/components/ui/surface-card";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
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
        <span className="flex flex-wrap gap-1.5 rounded-sm border border-archive-line-strong bg-white p-2 shadow-panel">
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
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const originalHref = safeExternalUrl(article.originalUrl);
  const viewCountLabel = formatViewCount(article.viewCount);
  const canonicalArticleHref = `/v2/articles/${article.slug}`;
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
      className={surfaceCardClassName("interactive", "relative flex h-full flex-col overflow-visible border-archive-line bg-white p-4 sm:p-5")}
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <SourceBadge sourceKey={article.sourceKey} className="min-h-6 rounded-sm bg-[color:var(--country-accent-softer)] px-2 text-[11px] font-semibold" />
        <span className="inline-flex min-h-6 items-center rounded-sm border border-[color:var(--country-border)] bg-white px-2 text-[11px] font-semibold text-[color:var(--country-text)]">
          {displayArticleTypeLabel(article)}
        </span>
      </div>

      <h2 className="archive-serif text-[17px] font-semibold leading-7 text-archive-heading">
        <IntentPrefetchLink href={articleHref} onClick={handleArticleLinkClick} className="focus-ring rounded-sm hover:text-primary">
          {title}
          <RecentDecisionMark publishedAt={article.originalPublishedAt} />
        </IntentPrefetchLink>
      </h2>

      <p className="mt-3 line-clamp-3 text-sm leading-6 text-archive-text">{summaryText}</p>

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

      <div className="min-h-4 grow" aria-hidden="true" />

      <div className="flex items-center justify-between gap-3 border-t border-archive-line pt-4 text-xs text-archive-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{formattedArticleDate(article)}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            aria-label={`조회 ${viewCountLabel}회`}
            title={`조회 ${viewCountLabel}회`}
            className="inline-flex min-h-7 items-center gap-1 border border-archive-line bg-archive-surface px-2 text-[11px] font-semibold text-archive-text"
          >
            <Eye className="size-3.5" aria-hidden="true" />
            <span className="tabular-nums">{viewCountLabel}</span>
          </span>
          <button
            type="button"
            onClick={shareArticle}
            aria-label={`공유: ${title}`}
            title={shareState === "copied" ? "링크 복사됨" : "공유"}
            className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-ink-subtle transition hover:bg-surface-muted hover:text-primary"
          >
            {shareState === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Share2 className="size-4" aria-hidden="true" />}
          </button>
          <IntentPrefetchLink
            href={articleHref}
            onClick={handleArticleLinkClick}
            aria-label={`자세히 읽기: ${title}`}
            title="자세히 읽기"
            className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-ink-subtle transition hover:bg-surface-muted hover:text-primary"
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
