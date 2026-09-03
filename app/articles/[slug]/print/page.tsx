import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArticlePrintActions } from "@/components/article-print-actions";
import { publicSourceAttribution } from "@/lib/case-catalog/source-attribution";
import { getArticleBySlug } from "@/lib/db/queries";
import type { ArticleDetail, ReferencedProvision } from "@/lib/db/types";
import { articleCaseNumber } from "@/lib/ui/article-case-number";
import { articleDateLabel, spainBoeMetadata } from "@/lib/ui/article-date-label";
import { articleTitleForDisplay } from "@/lib/ui/article-title";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { provisionReviewLabel } from "@/lib/ui/provision-confidence";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { formatDisplayDate } from "@/lib/utils/dates";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function printTitle(article: ArticleDetail) {
  return articleTitleForDisplay(article);
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
  const article = await getArticleBySlug(slug, { includeSourceText: false });
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
  const article = await getArticleBySlug(slug, { includeUnpublished, includeSourceText: false });
  if (!article) notFound();

  const summary = article.summaryJson;
  const boeMetadata = article.sourceKey === "es-tribunal-constitucional" ? spainBoeMetadata(article.sourceMetadata) : null;
  const caseNumber = articleCaseNumber(article);
  const provisions = summary?.summary.referencedProvisions.filter((provision) => provisionLabel(provision)) ?? [];
  const originalHref = safeExternalUrl(article.originalUrl);
  const sourceAttribution = publicSourceAttribution(article.sourceKey, article.sourceMetadata, article.originalUrl);

  return (
    <main className="print-page mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <ArticlePrintActions articleHref={`/articles/${article.slug}`} originalUrl={originalHref} />

      <article className="print-document border border-line bg-white p-6 sm:p-8">
        <header className="pb-6">
          <p className="text-sm font-semibold text-court">헌법판례요약시스템</p>
          <h1 className="mt-3 break-keep text-3xl font-semibold leading-tight tracking-normal text-ink sm:text-4xl">
            {printTitle(article)}
            {caseNumber ? <span className="ml-1 font-sans text-[0.62em] font-medium tracking-normal text-ink-subtle align-baseline">({caseNumber})</span> : null}
          </h1>
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
          {originalHref ? (
            <p className="mt-5 break-all text-sm leading-6 text-ink-muted">
              공식 원문: <a href={originalHref}>{originalHref}</a>
            </p>
          ) : null}
        </PrintSection>

        {sourceAttribution ? (
          <PrintSection title="공식 데이터 출처와 이용조건">
            {sourceAttribution.kind === "germany-bverfg" ? (
              <>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <InfoItem label="공식 제공기관" value={sourceAttribution.providerLabel} />
                  <InfoItem label="공식 생산기관" value={sourceAttribution.authorityLabel} />
                  <InfoItem label="사건번호" value={sourceAttribution.docket} />
                  <InfoItem label="결정일" value={sourceAttribution.decisionDate} />
                  <InfoItem label="발견 보조 자료" value={sourceAttribution.discoveryProviderLabel} />
                  <InfoItem label="수집 범위" value={sourceAttribution.coverageLabel} />
                </dl>
                <p className="mt-5 break-all text-sm leading-6">
                  공식 원문: <a href={sourceAttribution.officialUrl}>독일 연방헌법재판소 결정문</a>
                </p>
                <p className="mt-2 break-all text-sm leading-6">
                  발견 기록: <a href={sourceAttribution.discoveryUrl}>dejure.org 판례 목록</a>
                </p>
                <p className="mt-4 text-sm leading-6">{sourceAttribution.integrityNotice}</p>
                <p className="mt-2 text-sm leading-6">{sourceAttribution.notice}</p>
              </>
            ) : (
              <>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <InfoItem label="제공기관" value={sourceAttribution.providerLabel} />
                  <InfoItem label="공식 생산기관" value={sourceAttribution.authorityLabel} />
                  <InfoItem label="DILA 자료 ID" value={sourceAttribution.dilaId} />
                  <InfoItem label="결정번호" value={sourceAttribution.decisionNumber} />
                  <InfoItem label="ECLI" value={sourceAttribution.ecli} />
                  <InfoItem label="자료 파일 기준시각" value={sourceAttribution.stockTimestamp} />
                </dl>
                <p className="mt-5 break-all text-sm leading-6">
                  자료 파일: <a href={sourceAttribution.stockUrl}>{sourceAttribution.stockFilename}</a>
                </p>
                <p className="mt-2 text-sm leading-6">
                  라이선스: <a href={sourceAttribution.licenseUrl}>{sourceAttribution.licenseLabel}</a>
                </p>
                <p className="mt-4 text-sm leading-6">{sourceAttribution.notice}</p>
              </>
            )}
          </PrintSection>
        ) : null}

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
                  {provisions.map((provision, index) => {
                    const reviewLabel = provisionReviewLabel(provision.confidence);
                    return (
                      <li key={`${provision.jurisdiction}-${provision.lawName}-${provision.article}-${index}`} className="print-section border border-line bg-surface-muted/60 p-4">
                        <strong className="text-ink">{provisionLabel(provision)}</strong>
                        {reviewLabel ? <span className="ml-2 text-xs font-semibold text-ink-subtle">{reviewLabel}</span> : null}
                        <p className="mt-2 text-sm leading-6 text-ink-muted">{provision.description}</p>
                      </li>
                    );
                  })}
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
