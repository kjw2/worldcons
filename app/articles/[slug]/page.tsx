import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ReferencedProvisionList } from "@/components/referenced-provision-list";
import { RelatedArticles } from "@/components/related-articles";
import { SummarySection } from "@/components/summary-section";
import { TagPill } from "@/components/tag-pill";
import { getArticleBySlug, getRelatedArticles } from "@/lib/db/queries";
import { articleJsonLd } from "@/lib/seo/jsonld";
import { articleMetadata } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { formatDisplayDate } from "@/lib/utils/dates";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return {};
  return articleMetadata(article);
}

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const paramsObject = await resolveSearchParams(searchParams);
  const includeUnpublished = await isAuthorizedPageRequest(getSearchParam(paramsObject, "secret"));
  const article = await getArticleBySlug(slug, { includeUnpublished });
  if (!article) notFound();

  const related = await getRelatedArticles(article);
  const summary = article.summaryJson;
  const summaryModelName = summary?.aiMetadata?.model ?? "모델 정보 없음";
  const theme = themeForJurisdiction(article.jurisdiction);
  const collection = article.sourceMetadata?.collection as
    | { strategy?: string; confidence?: string; sourceUrlVerified?: boolean; diagnosticsId?: string }
    | undefined;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd(article)) }} />
      <div style={jurisdictionThemeStyle(theme)} className="mb-6 rounded-md border border-[color:var(--country-border)] bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink/58">
          <span>{article.jurisdiction}</span>
          <span>·</span>
          <span>{article.institutionName}</span>
          <span>·</span>
          <span>{formatDisplayDate(article.originalPublishedAt)}</span>
          <span>·</span>
          <span>{article.originalLanguage}</span>
          {article.readingMinutes ? (
            <>
              <span>·</span>
              <span>{article.readingMinutes}분 읽기</span>
            </>
          ) : null}
          <span>·</span>
          <span>{article.status}</span>
          {collection?.strategy ? (
            <>
              <span>·</span>
              <span>
                수집 {collection.strategy}/{collection.confidence ?? "unknown"}
              </span>
            </>
          ) : null}
        </div>
        <h1 className="text-3xl font-semibold leading-tight tracking-normal text-ink">{article.koreanTitle || article.originalTitle}</h1>
        {article.originalTitle ? <p className="mt-3 text-sm text-ink/58">원문 제목: {article.originalTitle}</p> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {article.tags.map((tag) => (
            <TagPill key={tag.slug} tag={tag} jurisdiction={article.jurisdiction} />
          ))}
        </div>
        <a href={article.originalUrl} target="_blank" rel="noreferrer" className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-court px-4 py-2 text-sm font-semibold text-white transition hover:bg-court/90">
          원문 보기
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </div>

      <article style={jurisdictionThemeStyle(theme)} className="rounded-md border border-[color:var(--country-border)] bg-white p-5 shadow-sm">
        {summary ? (
          <>
            <SummarySection title="핵심 요약">
              <ul className="list-disc space-y-2 pl-5">
                {summary.summary.coreSummary.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </SummarySection>
            <SummarySection title="참조 조문">
              <ReferencedProvisionList provisions={summary.summary.referencedProvisions} />
            </SummarySection>
            <SummarySection title="배경">{summary.summary.background}</SummarySection>
            <SummarySection title="사건 구조">{summary.summary.caseStructure}</SummarySection>
            <SummarySection title="시사점">{summary.summary.implications}</SummarySection>
            <SummarySection title="실무상 참고">{summary.summary.practicalNotes}</SummarySection>
            {summary.riskFlags.length > 0 ? (
              <SummarySection title="검수 신호">
                <div className="flex flex-wrap gap-2">
                  {summary.riskFlags.map((flag) => (
                    <span key={flag} className="rounded-md bg-parchment px-2.5 py-1 text-xs font-semibold text-ink/70">
                      {flag}
                    </span>
                  ))}
                </div>
              </SummarySection>
            ) : null}
            <SummarySection title="AI 요약 참고 고지">
              <p className="rounded-md border border-court/20 bg-court/5 p-4 text-court">
                이 요약은 AI 언어 모델({summaryModelName})을 사용해 생성된 참고용 정보입니다. 정확한 법적 판단이나 인용을 위해서는 반드시 원문과 공식 자료를 확인해야 합니다.
              </p>
            </SummarySection>
          </>
        ) : (
          <p className="text-sm text-ink/62">요약이 아직 생성되지 않았습니다.</p>
        )}
        {article.cleanedText ? (
          <SummarySection title="보존된 원문 스냅샷">
            <details className="rounded-md border border-rule bg-parchment/40 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink">추출 원문 보기</summary>
              <pre className="mt-4 max-h-96 whitespace-pre-wrap overflow-auto text-xs leading-6 text-ink/72">{article.cleanedText}</pre>
            </details>
          </SummarySection>
        ) : null}
        <SummarySection title="관련 기사">
          <RelatedArticles articles={related} />
        </SummarySection>
      </article>
    </main>
  );
}
