import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, FileText, Languages, Scale } from "lucide-react";
import { AdminArticleReviewPanelLoader } from "@/components/admin-article-review-panel";
import { ArticlePrintButton } from "@/components/article-print-button";
import { ArticleSourceSnapshot } from "@/components/article-source-snapshot";
import { PageViewTracker } from "@/components/page-view-tracker";
import { ReferencedProvisionList } from "@/components/referenced-provision-list";
import { RelatedArticles } from "@/components/related-articles";
import { SummarySection } from "@/components/summary-section";
import { TagPill } from "@/components/tag-pill";
import { DisclosureCard } from "@/components/ui/disclosure-card";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";
import { getArticleBySlug, getArticlePreviewBySlug, getRelatedArticles } from "@/lib/db/queries";
import type { ArticleDetail } from "@/lib/db/types";
import { articleJsonLd, jsonLdScriptValue } from "@/lib/seo/jsonld";
import { articleMetadata } from "@/lib/seo/metadata";
import { articleDateLabel, formattedArticleDate, spainBoeMetadata } from "@/lib/ui/article-date-label";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { formatDisplayDate } from "@/lib/utils/dates";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const revalidate = 60;

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
  const article = await getArticlePreviewBySlug(slug);
  if (!article) return {};
  return articleMetadata(article);
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug, { includeSourceText: false });
  if (!article) notFound();

  const related = await getRelatedArticles(article);
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

  return (
    <PageShell className="max-w-7xl">
      <PageViewTracker event={articleViewEvent} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScriptValue(articleJsonLd(article)) }} />
      <section style={jurisdictionThemeStyle(theme)} className="mb-7 border-b border-line pb-7">
        <MetaRow
          items={[
            displayJurisdictionLabel(article.jurisdiction),
            displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName }),
            formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" }),
            article.originalLanguage,
          ]}
        />
        <h1 className="mt-4 break-keep text-3xl font-semibold leading-tight tracking-normal text-ink sm:text-4xl">
          {article.koreanTitle || article.originalTitle}
        </h1>
        {primaryIssue ? <p className="mt-4 break-keep text-lg leading-8 text-ink-muted">{primaryIssue}</p> : null}
        {article.originalTitle ? <p className="mt-3 break-keep text-sm leading-6 text-ink-subtle">원문 제목: {article.originalTitle}</p> : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {originalHref ? (
            <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-court px-4 text-sm font-semibold text-white transition hover:bg-court/90">
              원문 보기
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
          <Link href="/" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            목록으로
          </Link>
          <ArticlePrintButton printHref={`/articles/${article.slug}/print`} />
        </div>
      </section>

      <AdminArticleReviewPanelLoader slug={article.slug} />

      <div style={jurisdictionThemeStyle(theme)} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <article className="space-y-5">
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
              <div className="grid gap-5 md:grid-cols-2">
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
              title="AI 요약이 아직 준비되지 않았습니다"
              description="원문 본문 확보 또는 요약 생성이 완료되면 핵심 쟁점과 배경, 시사점이 이 영역에 정리됩니다."
            />
          )}
          {sourceTextAvailable ? <ArticleSourceSnapshot slug={article.slug} /> : null}
          <SummarySection title="관련 기사" variant="body">
            <RelatedArticles articles={related} />
          </SummarySection>
        </article>

        <aside className="space-y-4 lg:sticky lg:top-28">
          <SurfaceCard className="p-5">
            <h2 className="text-base font-semibold text-ink">자료 정보</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-start gap-3">
                <Scale className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div>
                  <dt className="font-semibold text-ink">기관</dt>
                  <dd className="mt-1 text-ink-muted">{displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-4 text-[color:var(--country-text)]" aria-hidden="true" />
                <div>
                  <dt className="font-semibold text-ink">{articleDateLabel(article.sourceKey)}</dt>
                  <dd className="mt-1 text-ink-muted">{formatDisplayDate(article.originalPublishedAt)}</dd>
                </div>
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
              <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring mt-5 inline-flex w-full min-h-11 items-center justify-center gap-2 rounded-lg border border-court/25 bg-court/5 px-4 text-sm font-semibold text-court transition hover:bg-court/10">
                공식 원문 확인
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            ) : null}
          </SurfaceCard>

          {summary ? (
            <SurfaceCard className="p-5">
              <h2 className="mb-4 text-base font-semibold text-ink">참조 조문</h2>
              <ReferencedProvisionList provisions={summary.summary.referencedProvisions} />
            </SurfaceCard>
          ) : null}

          {article.tags.length > 0 ? (
            <SurfaceCard className="p-5">
              <h2 className="mb-4 text-base font-semibold text-ink">태그</h2>
              <div className="flex flex-wrap gap-2">
                {article.tags.map((tag) => (
                  <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} />
                ))}
              </div>
            </SurfaceCard>
          ) : null}

          {summary ? (
            <SurfaceCard variant="muted" className="p-5">
              <h2 className="text-base font-semibold text-ink">AI 요약 참고</h2>
              <p className="mt-2 text-sm leading-6 text-ink-muted">
                이 요약은 AI 언어 모델({summaryModelName})을 사용해 생성한 참고용 정보입니다. 정확한 법적 판단이나 인용은 공식 원문을 확인하세요.
              </p>
            </SurfaceCard>
          ) : null}
        </aside>
      </div>
    </PageShell>
  );
}
