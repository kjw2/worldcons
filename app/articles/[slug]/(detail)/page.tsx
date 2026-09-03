import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink, FileText, Languages, Scale } from "lucide-react";
import { ArticleReturnLink } from "@/components/article-detail-navigation";
import { ArticlePrintButton } from "@/components/article-print-button";
import { ArticleSourceAttribution } from "@/components/article-source-attribution";
import { ArticleSourceSnapshot } from "@/components/article-source-snapshot";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { PageViewTracker } from "@/components/page-view-tracker";
import { ReferencedProvisionList } from "@/components/referenced-provision-list";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { RelatedArticles } from "@/components/related-articles";
import { SummarySection } from "@/components/summary-section";
import { TagPill } from "@/components/tag-pill";
import { DisclosureCard } from "@/components/ui/disclosure-card";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import type { ArticleDetail } from "@/lib/db/types";
import { publicSourceAttribution } from "@/lib/case-catalog/source-attribution";
import { getCachedArticleDetailPageData } from "@/lib/public-article-detail-cache";
import { articleBreadcrumbJsonLd, articleJsonLd, jsonLdScriptValue } from "@/lib/seo/jsonld";
import { articleCaseNumber } from "@/lib/ui/article-case-number";
import { articleTitleForDisplay } from "@/lib/ui/article-title";
import { articleMetadata } from "@/lib/seo/metadata";
import { articleDateLabel, formattedArticleDate, spainBoeMetadata } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { formatDisplayDate } from "@/lib/utils/dates";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = 3_600;

export function generateStaticParams() {
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicCollectionNotice(article: ArticleDetail) {
  if (article.status === "robots_disallowed") {
    return {
      title: "자동 본문 수집이 제한된 자료입니다",
      description: "공식 기관의 robots 정책 때문에 원문 본문을 자동으로 보존하지 못했을 수 있습니다. 인용이나 법적 판단에는 공식 원문을 우선 확인하세요.",
    };
  }

  if (article.status === "blocked" || article.status === "timeout" || article.status === "failed_fetch") {
    return {
      title: "원문 수집 상태를 확인 중입니다",
      description: "공식 사이트 응답 제한이나 일시적인 네트워크 문제로 본문 수집이 완전하지 않을 수 있습니다. 가능한 경우 공식 원문 링크에서 전체 문맥을 확인하세요.",
    };
  }

  if (article.status === "metadata_only") {
    return {
      title: "본문 확보 전 metadata 중심 자료입니다",
      description: "현재는 제목, 기관, 기준일 등 기본 정보 중심으로 정리되어 있습니다. 본문과 요약은 수집이 완료된 뒤 보강됩니다.",
    };
  }

  return null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const detailData = await getCachedArticleDetailPageData(slug);
  if (!detailData) return {};
  return articleMetadata(detailData.article);
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detailData = await getCachedArticleDetailPageData(slug);
  if (!detailData) notFound();

  const { article, related } = detailData;
  const summary = article.summaryJson;
  const summaryModelName = summary?.aiMetadata?.model ?? "모델 정보 없음";
  const theme = themeForJurisdiction(article.jurisdiction);
  const articleViewEvent = {
    eventType: "article_view" as const,
    path: `/articles/${article.slug}`,
    articleId: article.id,
    articleSlug: article.slug,
    articleTitle: article.koreanTitle || article.originalTitle,
    sourceKey: article.sourceKey,
    jurisdiction: article.jurisdiction,
    institutionName: article.institutionName,
  };

  const primaryIssue = summary?.summary.coreSummary[0] ?? article.oneLineSummary;
  const collectionNotice = publicCollectionNotice(article);
  const originalHref = safeExternalUrl(article.originalUrl);
  const missingOriginalUrl = !originalHref;
  const boeMetadata = article.sourceKey === "es-tribunal-constitucional" ? spainBoeMetadata(article.sourceMetadata) : null;
  const sourceTextAvailable = isRecord(article.sourceMetadata?.collection) && article.sourceMetadata.collection.sourceTextAvailable === true;
  const summaryReprocessing = article.summaryStatus === "reprocessing";
  const sourceOnly = article.enrichmentStatus === "source_only";
  const sourceAttribution = publicSourceAttribution(article.sourceKey, article.sourceMetadata, article.originalUrl);
  const caseNumber = articleCaseNumber(article);
  const title = articleTitleForDisplay(article);

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <PageViewTracker event={articleViewEvent} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScriptValue(articleJsonLd(article)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScriptValue(articleBreadcrumbJsonLd(article)) }} />
      <nav className="mb-6 flex flex-wrap items-center gap-1.5 text-xs text-archive-muted" aria-label="현재 위치">
        <IntentPrefetchLink href="/" className="focus-ring rounded-sm hover:text-archive-accent">홈</IntentPrefetchLink><ChevronRight className="size-3" aria-hidden="true" />
        <IntentPrefetchLink href="/list" className="focus-ring rounded-sm hover:text-archive-accent">전체 판례</IntentPrefetchLink><ChevronRight className="size-3" aria-hidden="true" />
        <IntentPrefetchLink href={`/sources/${article.sourceKey}`} className="focus-ring rounded-sm hover:text-archive-accent">{displaySourceLabel(article.sourceKey)}</IntentPrefetchLink><ChevronRight className="size-3" aria-hidden="true" />
        <span className="max-w-[32rem] truncate">{title}</span>
      </nav>
      <section style={jurisdictionThemeStyle(theme)} className="mb-8 border-b border-archive-line-strong pb-8">
        <p className="text-sm font-semibold text-[color:var(--country-text)]">{displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })} · {displayArticleTypeLabel(article)}</p>
        <MetaRow
          className="mt-3"
          items={[
            displayJurisdictionLabel(article.jurisdiction),
            formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" }),
            article.originalLanguage,
          ]}
        />
        <h1 className="mt-4 max-w-5xl break-keep text-3xl font-bold leading-[1.3] text-archive-ink sm:text-4xl">
          {title}
          {caseNumber ? <span className="ml-1 font-sans text-[0.62em] font-medium tracking-normal text-archive-muted align-baseline">({caseNumber})</span> : null}
          <RecentDecisionMark publishedAt={article.originalPublishedAt} className="text-[11px]" />
        </h1>
        {primaryIssue ? <p className="mt-5 max-w-5xl break-keep text-base leading-8 text-archive-text sm:text-lg">{primaryIssue}</p> : null}
        {article.originalTitle ? <p className="mt-3 max-w-5xl break-keep text-sm leading-6 text-archive-subtle">원문 제목: {article.originalTitle}</p> : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {originalHref ? (
            <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-sm bg-archive-accent px-4 text-sm font-semibold text-white transition hover:bg-archive-accent-hover">
              원문 보기
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
          <ArticleReturnLink className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-sm border border-archive-line bg-white px-4 text-sm font-semibold text-archive-text transition hover:border-archive-accent hover:text-archive-accent" />
          <ArticlePrintButton printHref={`/articles/${article.slug}/print`} />
        </div>
      </section>

      <div style={jurisdictionThemeStyle(theme)} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start xl:gap-12">
        <article className="min-w-0 space-y-2">
          {collectionNotice ? (
            <DisclosureCard title={collectionNotice.title}>
              <p className="text-sm leading-6 text-ink-muted">{collectionNotice.description}</p>
            </DisclosureCard>
          ) : null}
          {missingOriginalUrl ? (
            <DisclosureCard title="공식 원문 링크가 아직 없습니다">
              <p className="text-sm leading-6 text-ink-muted">현재 보존된 원문 URL이 없어 기관 사이트에서 직접 자료를 확인해야 할 수 있습니다.</p>
            </DisclosureCard>
          ) : null}
          {summaryReprocessing ? (
            <DisclosureCard title="공식 원문이 갱신되어 한국어 요약을 재처리하고 있습니다">
              <p className="text-sm leading-6 text-ink-muted">
                현재 화면에는 검증된 최신 공식 정보만 표시합니다. 이전 원문을 바탕으로 만든 제목·요약·분류는 재처리가 끝날 때까지 제공하지 않습니다.
              </p>
            </DisclosureCard>
          ) : null}
          {sourceAttribution ? <ArticleSourceAttribution attribution={sourceAttribution} /> : null}
          {summary ? (
            <>
              <SummarySection title="핵심 요약" variant="primary">
                <ul className="list-disc space-y-3 pl-5">
                  {summary.summary.coreSummary.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ul>
              </SummarySection>
              <SummarySection title="배경" variant="body">{summary.summary.background}</SummarySection>
              <SummarySection title="사건 구조" variant="body">{summary.summary.caseStructure}</SummarySection>
              <div className="grid gap-2 md:grid-cols-2">
                <SummarySection title="시사점" variant="insight">{summary.summary.implications}</SummarySection>
                <SummarySection title="실무상 참고" variant="insight">{summary.summary.practicalNotes}</SummarySection>
              </div>
              {summary.riskFlags.length > 0 ? (
                <SummarySection title="검수 신호" variant="disclosure">
                  <div className="flex flex-wrap gap-2">
                    {summary.riskFlags.map((flag) => (
                      <span key={flag} className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-ink-muted">
                        {flag}
                      </span>
                    ))}
                  </div>
                </SummarySection>
              ) : null}
            </>
          ) : (
            <EmptyState
              title={sourceOnly ? "검증된 공식 판례가 먼저 공개되었습니다" : "AI 요약이 아직 준비되지 않았습니다"}
              description={summaryReprocessing
                ? "최신 공식 원문을 기준으로 한국어 요약을 다시 생성하고 있습니다. 그동안에는 공식 원문과 사건 정보를 확인해 주세요."
                : "한국어 요약이 준비되면 핵심 쟁점과 배경, 시사점이 이 영역에 추가됩니다."}
            />
          )}
          {sourceTextAvailable ? <ArticleSourceSnapshot slug={article.slug} /> : null}
          <SummarySection title="관련 기사" variant="body">
            <RelatedArticles articles={related} />
          </SummarySection>
        </article>

        <aside className="divide-y divide-archive-line border-y border-archive-line-strong bg-white lg:sticky lg:top-[calc(var(--chrome-header-height)+1rem)]">
          <section className="px-1 py-5 sm:px-4">
            <h2 className="archive-rule-title text-base font-semibold text-archive-heading">사건 정보</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-start gap-3">
                <Scale className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div>
                  <dt className="font-semibold text-ink">기관</dt>
                  <dd className="mt-1 text-ink-muted"><IntentPrefetchLink href={`/sources/${article.sourceKey}`} className="focus-ring rounded-sm hover:text-archive-accent">{displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })}</IntentPrefetchLink></dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div>
                  <dt className="font-semibold text-ink">{articleDateLabel(article.sourceKey)}</dt>
                  <dd className="mt-1 text-ink-muted">{formatDisplayDate(article.originalPublishedAt)}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Scale className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div><dt className="font-semibold text-ink">유형</dt><dd className="mt-1 text-ink-muted">{displayArticleTypeLabel(article)}</dd></div>
              </div>
              {boeMetadata?.boePublishedAt ? (
                <div className="flex items-start gap-3">
                  <FileText className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                  <div>
                    <dt className="font-semibold text-ink">BOE 공고일</dt>
                    <dd className="mt-1 text-ink-muted">
                      {formatDisplayDate(boeMetadata.boePublishedAt)}
                      {boeMetadata.referenceBoe ? ` · ${boeMetadata.referenceBoe}` : boeMetadata.boeNumber ? ` · BOE ${boeMetadata.boeNumber}` : ""}
                    </dd>
                  </div>
                </div>
              ) : null}
              <div className="flex items-start gap-3">
                <Languages className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div>
                  <dt className="font-semibold text-ink">언어</dt>
                  <dd className="mt-1 text-ink-muted">{article.originalLanguage}</dd>
                </div>
              </div>
            </dl>
            {originalHref ? (
              <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-sm border border-archive-line-strong bg-archive-tint px-4 text-sm font-semibold text-archive-accent transition hover:bg-archive-surface">
                공식 원문 확인
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            ) : null}
          </section>

          {summary ? (
            <section className="px-1 py-5 sm:px-4">
              <h2 className="mb-4 text-base font-semibold text-ink">참조 조문</h2>
              <ReferencedProvisionList provisions={summary.summary.referencedProvisions} />
            </section>
          ) : null}

          {article.tags.length > 0 ? (
            <section className="px-1 py-5 sm:px-4">
              <h2 className="mb-4 text-base font-semibold text-ink">태그</h2>
              <div className="flex flex-wrap gap-2">
                {article.tags.map((tag) => (
                  <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} />
                ))}
              </div>
            </section>
          ) : null}

          {summary ? (
            <section className="bg-archive-surface-soft px-1 py-5 sm:px-4">
              <h2 className="text-base font-semibold text-ink">AI 요약 참고</h2>
              <p className="mt-2 text-sm leading-6 text-ink-muted">
                이 요약은 AI 언어 모델({summaryModelName})을 사용해 생성한 참고용 정보입니다. 정확한 법적 판단이나 인용은 공식 원문을 확인하세요.
              </p>
            </section>
          ) : null}
        </aside>
      </div>
    </PageShell>
  );
}
