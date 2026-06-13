"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Eye } from "lucide-react";
import { AdminSummaryRetryBadge } from "@/components/admin-summary-retry-badge";
import type { AdminAttentionArticle } from "@/lib/db/admin-queries";
import { formattedArticleDate } from "@/lib/ui/article-date-label";

const statusLabels: Record<string, string> = {
  discovered: "발견",
  metadata_only: "메타만 있음",
  robots_disallowed: "robots 제한",
  blocked: "접근 차단",
  timeout: "시간 초과",
  fetched: "수집됨",
  cleaned: "요약 대기",
  summarizing: "요약 중",
  summarized: "공개",
  failed_fetch: "수집 실패",
  failed_summary: "요약 실패",
  needs_review: "검토 필요",
};

function statusClass(status: string) {
  if (status === "summarized" || status === "completed") return "border-mint/25 bg-mint/10 text-mint";
  if (status === "cleaned" || status === "summarizing" || status === "running") return "border-ink/15 bg-parchment text-ink/72";
  if (status === "needs_review" || status === "metadata_only") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (status.includes("failed") || status === "blocked" || status === "timeout" || status === "robots_disallowed") {
    return "border-court/25 bg-court/5 text-court";
  }
  return "border-rule bg-white text-ink/64";
}

function StatusBadge({ status, href }: { status: string; href: string }) {
  return (
    <a
      href={href}
      title="검토 상세를 엽니다."
      className={`focus-ring inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold transition hover:brightness-95 ${statusClass(status)}`}
    >
      {statusLabels[status] ?? status}
    </a>
  );
}

export function AdminAttentionTable({
  data,
}: {
  data: AdminAttentionArticle[];
}) {
  const [resolvedSlugs, setResolvedSlugs] = useState<Set<string>>(() => new Set());
  const visibleData = useMemo(
    () => data.filter((article) => !resolvedSlugs.has(article.slug)),
    [data, resolvedSlugs],
  );

  function removeResolvedArticle(slug: string) {
    setResolvedSlugs((current) => {
      const next = new Set(current);
      next.add(slug);
      return next;
    });
  }

  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">검토</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">주의가 필요한 자료</h2>
      </div>
      {visibleData.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink/58">현재 검토 큐가 비어 있습니다.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">자료</th>
                <th className="px-4 py-3">기관</th>
                <th className="px-4 py-3">날짜</th>
                <th className="px-4 py-3">상태</th>
                <th className="px-4 py-3">링크</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {visibleData.map((article) => {
                const reviewHref = `/articles/${article.slug}`;

                return (
                  <tr key={`${article.sourceKey}-${article.slug}`}>
                    <td className="max-w-lg px-4 py-3">
                      <a href={reviewHref} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
                        {article.title}
                      </a>
                      {article.errorMessage ? <div className="mt-1 line-clamp-2 text-xs text-court">{article.errorMessage}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      <div>{article.institutionName}</div>
                      <div className="mt-1 text-xs text-ink/54">{article.sourceKey}</div>
                    </td>
                    <td className="px-4 py-3">{formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" })}</td>
                    <td className="px-4 py-3">
                      {article.status === "failed_summary" ? (
                        <div className="grid gap-2">
                          <AdminSummaryRetryBadge
                            articleId={article.id}
                            slug={article.slug}
                            onSummarized={removeResolvedArticle}
                          />
                          <a href={reviewHref} className="focus-ring inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-rule px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
                            <Eye className="size-3.5" aria-hidden="true" />
                            검토
                          </a>
                        </div>
                      ) : (
                        <StatusBadge status={article.status} href={reviewHref} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <a href={reviewHref} className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
                          <Eye className="size-3.5" aria-hidden="true" />
                          검토
                        </a>
                        {article.originalUrl ? (
                          <a href={article.originalUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
                            원문
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
