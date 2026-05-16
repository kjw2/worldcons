import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { AdminReviewActions, type SummaryModelOption } from "@/components/admin-review-actions";
import { ReferencedProvisionList } from "@/components/referenced-provision-list";
import { RelatedArticles } from "@/components/related-articles";
import { SummarySection } from "@/components/summary-section";
import { TagPill } from "@/components/tag-pill";
import { hasGeminiKey, hasOpenAiKey } from "@/lib/ai/client";
import { getGeminiModels } from "@/lib/ai/gemini-router";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getArticleBySlug, getRelatedArticles } from "@/lib/db/queries";
import type { ArticleDetail } from "@/lib/db/types";
import { articleJsonLd, jsonLdScriptValue } from "@/lib/seo/jsonld";
import { articleMetadata } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { formatDisplayDate } from "@/lib/utils/dates";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const reviewStatusLabels: Record<string, string> = {
  metadata_only: "원문 본문이 아직 확보되지 않았습니다.",
  robots_disallowed: "robots.txt 정책 때문에 자동 본문 수집이 제한되었습니다.",
  blocked: "공식 사이트가 접근을 차단했거나 bot-protection 응답을 보냈습니다.",
  timeout: "공식 사이트 요청이 제한 시간 안에 끝나지 않았습니다.",
  failed_fetch: "원문 수집 단계에서 실패했습니다.",
  failed_summary: "AI 요약 단계에서 실패했습니다.",
  needs_review: "자동 수집은 되었지만 공개 전 사람이 확인해야 합니다.",
};

const MIN_REVIEW_TEXT_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function yesNo(value: unknown) {
  if (value === true) return "예";
  if (value === false) return "아니오";
  return "확인 필요";
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function textLength(value?: string | null) {
  return new Intl.NumberFormat("ko-KR").format((value ?? "").trim().length);
}

function rawTextLength(value?: string | null) {
  return (value ?? "").trim().length;
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function providerForModel(model: string): SummaryModelOption["provider"] {
  return /^gpt-|^o\d|^chatgpt-/i.test(model) ? "openai" : "gemini";
}

function summaryModelOptions(currentModel?: string | null): SummaryModelOption[] {
  const options: SummaryModelOption[] = [];

  if (hasGeminiKey()) {
    for (const model of getGeminiModels("Summarize").slice(0, 12)) {
      options.push({ provider: "gemini", model, label: `Gemini · ${model}` });
    }
  }

  if (hasOpenAiKey()) {
    for (const model of uniqueText([process.env.OPENAI_SUMMARY_MODEL, "gpt-4.1-mini", "gpt-4.1"])) {
      options.push({ provider: "openai", model, label: `OpenAI · ${model}` });
    }
  }

  if (currentModel && currentModel !== "development-fallback" && !options.some((option) => option.model === currentModel)) {
    const provider = providerForModel(currentModel);
    options.unshift({ provider, model: currentModel, label: `현재 모델 · ${currentModel}` });
  }

  return options;
}

function reviewPlan(article: ArticleDetail, collection: Record<string, unknown>) {
  const hasText = rawTextLength(article.cleanedText) >= MIN_REVIEW_TEXT_LENGTH;
  const hasSummary = Boolean(article.summaryJson);

  if (article.status === "summarized" && collection.publishable === true) {
    return {
      type: "공개 자료 재요약 검토",
      required: ["현재 공개 요약의 품질 확인", "재요약에 사용할 모델 선택", "재요약 후 제목과 핵심 요약 재확인"],
      next: "현재 공개 상태는 유지됩니다. 더 적합한 모델을 선택해 이 자료만 재요약합니다.",
    };
  }

  if (article.status === "failed_summary") {
    return {
      type: "요약 실패 검토",
      required: ["오류 metadata에서 실패 원인을 확인", "추출 본문이 원문과 맞는지 확인", "모델/quota 문제라면 재요약 실행"],
      next: hasText ? "본문이 정상이라면 `재요약 실행`을 선택합니다." : "추출 본문이 부족하므로 먼저 원문 수집을 다시 시도합니다.",
    };
  }

  if (article.status === "summarizing") {
    return {
      type: "중단된 요약 작업 검토",
      required: ["요약이 실제로 진행 중인지 확인", "오래된 상태라면 본문과 오류 이력을 확인", "재요약 실행 또는 비공개 종결 결정"],
      next: hasText ? "`요약 승인 후 실행`으로 상태를 복구하고 다시 요약합니다." : "본문이 부족하면 `수집원 재시도` 또는 `비공개 종결`을 선택합니다.",
    };
  }

  if (article.status === "metadata_only" || collection.sourceTextAvailable !== true) {
    return {
      type: "본문 확보 검토",
      required: ["공식 원문 링크가 맞는지 확인", "자동 추출 본문이 충분한지 확인", "본문이 없으면 수집원 재시도 또는 비공개 종결 결정"],
      next: hasText ? "본문이 충분하면 `요약 승인 후 실행`을 선택합니다." : "`수집원 재시도`로 본문 확보를 다시 시도하거나 `비공개 종결`합니다.",
    };
  }

  if (article.status === "blocked" || article.status === "timeout" || article.status === "failed_fetch" || article.status === "robots_disallowed") {
    return {
      type: "수집 장애 검토",
      required: ["공식 사이트 접근 제한 또는 timeout 원인 확인", "robots 정책상 자동 수집 가능한지 확인", "수집 재시도 가능성과 공개 보류 여부 결정"],
      next: "자동 수집이 가능한 상태라면 `수집원 재시도`, 정책상 불가하거나 원문 확인이 안 되면 `비공개 종결`합니다.",
    };
  }

  if (article.status === "needs_review") {
    return {
      type: "공개 전 품질 검토",
      required: ["헌법 쟁점 관련성 확인", "추출 본문이 공식 원문과 크게 어긋나지 않는지 확인", "요약이 있으면 공개 여부, 없으면 요약 실행 여부 결정"],
      next: hasSummary ? "`검토 완료 후 공개` 또는 `비공개 종결`을 선택합니다." : "`요약 승인 후 실행` 또는 `비공개 종결`을 선택합니다.",
    };
  }

  return {
    type: "운영 검토",
    required: ["원문, 본문, 요약, metadata를 확인", "공개 또는 비공개 유지 여부 결정"],
    next: hasSummary ? "`검토 완료 후 공개`를 선택할 수 있습니다." : "요약이 없으면 먼저 요약 실행 여부를 결정합니다.",
  };
}

function ReviewFact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="rounded-md border border-rule bg-parchment/45 px-3 py-2">
      <div className="text-xs font-semibold text-ink/52">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-ink">{value || "없음"}</div>
    </div>
  );
}

function JsonDetails({ title, value }: { title: string; value?: unknown }) {
  if (!value || (isRecord(value) && Object.keys(value).length === 0)) return null;

  return (
    <details className="rounded-md border border-rule bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{title}</summary>
      <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-ink/72">{prettyJson(value)}</pre>
    </details>
  );
}

function TextDetails({ title, text }: { title: string; text?: string | null }) {
  if (!text?.trim()) return null;

  return (
    <details className="rounded-md border border-rule bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        {title} <span className="text-ink/50">({textLength(text)}자)</span>
      </summary>
      <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6 text-ink/72">{text}</pre>
    </details>
  );
}

function AdminReviewPanel({ article, secret }: { article: ArticleDetail; secret?: string | null }) {
  const sourceMetadata = article.sourceMetadata;
  const collection = isRecord(sourceMetadata?.collection) ? sourceMetadata.collection : {};
  const errorMessage = asText(article.errorMetadata?.message);
  const reason = asText(collection.reason) ?? errorMessage ?? reviewStatusLabels[article.status] ?? "관리자 확인이 필요합니다.";
  const canonicalUrl = article.canonicalUrl && article.canonicalUrl !== article.originalUrl ? article.canonicalUrl : null;
  const plan = reviewPlan(article, collection);
  const hasPublishableText = rawTextLength(article.cleanedText) >= MIN_REVIEW_TEXT_LENGTH;
  const currentModel = article.summaryJson?.aiMetadata?.model ?? null;
  const isPublic = article.status === "summarized" && collection.publishable === true;

  return (
    <section className="mb-6 rounded-md border border-amber-400/35 bg-amber-50 p-5 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-amber-400/35 bg-white text-amber-800">
          <AlertTriangle className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-amber-900">관리자 검토 모드</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">검토 근거</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">{reason}</p>
        </div>
      </div>

      {errorMessage ? <p className="mb-4 rounded-md border border-court/20 bg-white p-3 text-sm leading-6 text-court">{errorMessage}</p> : null}

      <div className="mb-4 rounded-md border border-amber-400/30 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-900">검토 유형</p>
            <h3 className="mt-1 text-lg font-semibold tracking-normal text-ink">{plan.type}</h3>
          </div>
          <span className="rounded-md border border-rule bg-parchment px-2.5 py-1 text-xs font-semibold text-ink/68">다음 절차 결정 필요</span>
        </div>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-ink/54">확인할 것</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-ink/70">
              {plan.required.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-ink/54">권장 다음 절차</p>
            <p className="mt-2 text-sm leading-6 text-ink/70">{plan.next}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ReviewFact label="상태" value={article.status} />
        <ReviewFact label="수집 방식" value={asText(collection.strategy)} />
        <ReviewFact label="신뢰도" value={asText(collection.confidence)} />
        <ReviewFact label="공개 가능" value={yesNo(collection.publishable)} />
        <ReviewFact label="공식 URL 확인" value={yesNo(collection.sourceUrlVerified)} />
        <ReviewFact label="본문 확보" value={yesNo(collection.sourceTextAvailable)} />
        <ReviewFact label="robots 제한" value={yesNo(collection.robotsDisallowed)} />
        <ReviewFact label="추출 본문 길이" value={`${textLength(article.cleanedText)}자`} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <a href={article.originalUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-2 rounded-md bg-court px-3 py-2 text-sm font-semibold text-white hover:bg-court/90">
          공식 원문
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
        {canonicalUrl ? (
          <a href={canonicalUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-3 py-2 text-sm font-semibold text-ink/70 hover:bg-parchment">
            canonical URL
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4">
        <AdminReviewActions
          articleId={article.id}
          slug={article.slug}
          status={article.status}
          hasSummary={Boolean(article.summaryJson)}
          hasPublishableText={hasPublishableText}
          isPublic={isPublic}
          currentModel={currentModel}
          modelOptions={summaryModelOptions(currentModel)}
          secret={secret}
        />
        <TextDetails title="추출 본문" text={article.cleanedText} />
        {article.rawText && article.rawText !== article.cleanedText ? <TextDetails title="원시 본문" text={article.rawText} /> : null}
        <JsonDetails title="수집 metadata" value={article.sourceMetadata} />
        <JsonDetails title="오류 metadata" value={article.errorMetadata} />
      </div>
    </section>
  );
}

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
  if (!includeUnpublished) {
    await recordSiteEvent(
      {
        eventType: "article_view",
        path: `/articles/${article.slug}`,
        articleId: article.id,
        articleSlug: article.slug,
        articleTitle: article.koreanTitle || article.originalTitle,
        sourceKey: article.sourceKey,
        jurisdiction: article.jurisdiction,
        institutionName: article.institutionName,
      },
      await headers(),
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScriptValue(articleJsonLd(article)) }} />
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

      {includeUnpublished ? <AdminReviewPanel article={article} secret={getSearchParam(paramsObject, "secret")} /> : null}

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
