import Link from "next/link";
import { ArrowRight, CalendarDays, ExternalLink } from "lucide-react";
import type { ArticleListItem } from "@/lib/db/types";
import { JurisdictionBadge } from "@/components/jurisdiction-badge";
import { SourceBadge } from "@/components/source-badge";
import { TagPill } from "@/components/tag-pill";
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

const statusLabels: Record<string, string> = {
  metadata_only: "본문 수집 대기",
  robots_disallowed: "robots.txt 제한",
  blocked: "접근 차단",
  timeout: "시간 초과",
  summarized: "요약 완료",
  cleaned: "요약 대기",
  needs_review: "검수 필요",
  failed_fetch: "수집 실패",
  failed_summary: "요약 실패",
};

export function ArticleCard({ article }: { article: ArticleListItem }) {
  const theme = themeForJurisdiction(article.jurisdiction);

  return (
    <article
      style={jurisdictionThemeStyle(theme)}
      className="flex h-full flex-col rounded-md border border-[color:var(--country-border)] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-soft"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <JurisdictionBadge jurisdiction={article.jurisdiction} />
        <SourceBadge sourceKey={article.sourceKey} />
        <span className="inline-flex min-h-7 items-center rounded-md border border-[color:var(--country-border)] bg-[color:var(--country-accent-soft)] px-2.5 text-xs font-semibold text-[color:var(--country-text)]">
          {typeLabels[article.contentType]}
        </span>
      </div>
      <h2 className="text-lg font-semibold leading-snug tracking-normal text-ink">
        <Link href={`/articles/${article.slug}`} className="focus-ring rounded-sm hover:text-court">
          {article.koreanTitle || article.originalTitle || "제목 미상"}
        </Link>
      </h2>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-ink/70">핵심: {article.oneLineSummary}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {article.tags.slice(0, 5).map((tag) => (
          <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} />
        ))}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5 text-sm text-ink/58">
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="size-4" aria-hidden="true" />
          {formatDisplayDate(article.originalPublishedAt)}
        </span>
        <span>{statusLabels[article.status] ?? article.status}</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[color:var(--country-border)] pt-4">
        <Link href={`/articles/${article.slug}`} className="focus-ring inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-ink/90">
          자세히 보기
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
        <a href={article.originalUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-sm font-medium text-ink/70 transition hover:bg-parchment hover:text-ink">
          원문 보기
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </div>
    </article>
  );
}
