import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArticlePrintActions } from "@/components/article-print-actions";
import { getArticleBySlug } from "@/lib/db/queries";
import type { ArticleDetail, ReferencedProvision } from "@/lib/db/types";
import { articleDateLabel, spainBoeMetadata } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { formatDisplayDate } from "@/lib/utils/dates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function printTitle(article: ArticleDetail) {
  return article.koreanTitle || article.originalTitle || "제목 미상";
}

function provisionLabel(provision: ReferencedProvision) {
  return [provision.lawName, provision.article].map((item) => item.trim()).filter(Boolean).join(" ");
}

function PrintSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="print-section border-t border-line py-6">
      <h2 className="mb-3 text-xl font-semibold leading-tight tracking-normal text-ink">{title}</h2>
      <div className="text-base leading-8 text-ink-muted">{children}</div>
    </section>
  );
}

function InfoItem({ label, value }: { label: string; value?: ReactNode }) {
  if (!value) return null;

  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-normal text-ink-subtle">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return {};

  return {
    title: {
      absolute: `${printTitle(article)} 인쇄용 HTML | 헌법판례요약시스템`,
    },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function ArticlePrintPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const includeUnpublished = await isAuthorizedPageRequest();
  const article = await getArticleBySlug(slug, { includeUnpublished });
  if (!article) notFound();

  const summary = article.summaryJson;
  const boeMetadata = article.sourceKey === "es-tribunal-constitucional" ? spainBoeMetadata(article.sourceMetadata) : null;
  const provisions = summary?.summary.referencedProvisions.filter((provision) => provisionLabel(provision)) ?? [];

  return (
    <main className="print-page mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <ArticlePrintActions articleHref={`/articles/${article.slug}`} originalUrl={article.originalUrl} />

      <article className="print-document rounded-lg border border-line bg-white p-6 shadow-card sm:p-8">
        <header className="pb-6">
          <p className="text-sm font-semibold text-court">헌법판례요약시스템</p>
          <h1 className="mt-3 break-keep text-3xl font-semibold leading-tight tracking-normal text-ink sm:text-4xl">{printTitle(article)}</h1>
          {summary?.summary.coreSummary[0] || article.oneLineSummary ? (
            <p className="mt-4 break-keep text-lg leading-8 text-ink-muted">{summary?.summary.coreSummary[0] || article.oneLineSummary}</p>
          ) : null}
          {article.originalTitle ? <p className="mt-3 break-keep text-sm leading-6 text-ink-subtle">원문 제목: {article.originalTitle}</p> : null}
        </header>

        <PrintSection title="자료 정보">
          <dl className="grid gap-4 sm:grid-cols-2">
            <InfoItem label="국가" value={displayJurisdictionLabel(article.jurisdiction)} />
            <InfoItem label="기관" value={displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })} />
            <InfoItem label="유형" value={displayArticleTypeLabel(article)} />
            <InfoItem label={articleDateLabel(article.sourceKey)} value={formatDisplayDate(article.originalPublishedAt)} />
            <InfoItem label="언어" value={article.originalLanguage} />
            {boeMetadata?.boePublishedAt ? (
              <InfoItem
                label="BOE 공고일"
                value={`${formatDisplayDate(boeMetadata.boePublishedAt)}${boeMetadata.referenceBoe ? ` · ${boeMetadata.referenceBoe}` : boeMetadata.boeNumber ? ` · BOE ${boeMetadata.boeNumber}` : ""}`}
              />
            ) : null}
          </dl>
          {article.originalUrl ? (
            <p className="mt-5 break-all text-sm leading-6 text-ink-muted">
              공식 원문: <a href={article.originalUrl}>{article.originalUrl}</a>
            </p>
          ) : null}
        </PrintSection>

        {summary ? (
          <>
            <PrintSection title="핵심 요약">
              <ul className="list-disc space-y-2 pl-5">
                {summary.summary.coreSummary.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </PrintSection>
            <PrintSection title="배경">
              <p>{summary.summary.background}</p>
            </PrintSection>
            <PrintSection title="사건 구조">
              <p>{summary.summary.caseStructure}</p>
            </PrintSection>
            <PrintSection title="시사점">
              <p>{summary.summary.implications}</p>
            </PrintSection>
            <PrintSection title="실무상 참고">
              <p>{summary.summary.practicalNotes}</p>
            </PrintSection>
            <PrintSection title="참조 조문">
              {provisions.length > 0 ? (
                <ul className="space-y-3">
                  {provisions.map((provision, index) => (
                    <li key={`${provision.jurisdiction}-${provision.lawName}-${provision.article}-${index}`} className="print-section rounded-lg border border-line bg-surface-muted/60 p-4">
                      <strong className="text-ink">{provisionLabel(provision)}</strong>
                      <span className="ml-2 text-xs font-semibold text-ink-subtle">신뢰도 {provision.confidence}</span>
                      <p className="mt-2 text-sm leading-6 text-ink-muted">{provision.description}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>확인된 참조 조문이 없습니다.</p>
              )}
            </PrintSection>
          </>
        ) : (
          <PrintSection title="AI 요약">
            <p>AI 요약이 아직 준비되지 않았습니다.</p>
          </PrintSection>
        )}

        {article.tags.length > 0 ? (
          <PrintSection title="태그">
            <div className="flex flex-wrap gap-2">
              {article.tags.map((tag) => (
                <span key={tag.slug} className="rounded-md border border-line bg-surface-muted px-2.5 py-1 text-sm font-semibold text-ink-muted">
                  {tag.name}
                </span>
              ))}
            </div>
          </PrintSection>
        ) : null}

        <footer className="border-t border-line pt-5 text-sm leading-6 text-ink-subtle">
          <p>AI 요약은 참고용입니다. 정확한 법적 판단이나 인용은 각 기관의 공식 원문을 확인하세요.</p>
        </footer>
      </article>
    </main>
  );
}
