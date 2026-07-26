"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import type { AdminArticleBulkAction, AdminArticleListItem } from "@/lib/db/admin-queries";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";

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

function articleStatusLabel(status: string, sourceKey: string) {
  if (status === "metadata_only" && sourceKey === "es-tribunal-constitucional") return "HJ 원문 공개 대기";
  return statusLabels[status] ?? status;
}

function formatDateTime(input?: string | null) {
  if (!input) return "없음";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function statusClass(status: string) {
  if (status === "summarized") return "border-mint/25 bg-mint/10 text-mint";
  if (status === "cleaned" || status === "summarizing") return "border-ink/15 bg-parchment text-ink/72";
  if (status === "needs_review" || status === "metadata_only") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (status.includes("failed") || status === "blocked" || status === "timeout" || status === "robots_disallowed") {
    return "border-court/25 bg-court/5 text-court";
  }
  return "border-rule bg-white text-ink/64";
}

function rowKey(article: AdminArticleListItem) {
  return article.id ? `id:${article.id}` : `slug:${article.slug}`;
}

function resultMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("bulk" in payload)) return "일괄 작업을 저장했습니다.";
  const bulk = (payload as { bulk?: { updatedCount?: number; matchedCount?: number; requestedCount?: number } }).bulk;
  return `${bulk?.updatedCount ?? 0}건 저장, ${bulk?.matchedCount ?? 0}건 매칭, ${bulk?.requestedCount ?? 0}건 요청`;
}

export function AdminArticlesTable({
  articles,
  csrfToken,
}: {
  articles: AdminArticleListItem[];
  csrfToken: string;
}) {
  const router = useRouter();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [action, setAction] = useState<AdminArticleBulkAction>("mark-needs-review");
  const [note, setNote] = useState("");
  const [closePrivateConfirmed, setClosePrivateConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const allKeys = useMemo(() => articles.map(rowKey), [articles]);
  const selectedArticles = articles.filter((article) => selectedKeys.has(rowKey(article)));
  const allCurrentSelected = allKeys.length > 0 && allKeys.every((key) => selectedKeys.has(key));

  function toggleArticle(key: string, checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleCurrentPage(checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of allKeys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function runBulkAction() {
    if (pending || selectedArticles.length === 0) return;
    setPending(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch("/api/admin/articles/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          action,
          note,
          confirmation: action === "close-private" && closePrivateConfirmed ? "close-private" : undefined,
          items: selectedArticles.map((article) => ({ id: article.id, slug: article.slug })),
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`;
        throw new Error(error);
      }
      setMessage(resultMessage(payload));
      setSelectedKeys(new Set());
      setClosePrivateConfirmed(false);
      router.refresh();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule p-4">
        <div>
          <p className="text-sm font-semibold text-court">기사 목록</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">관리 대상 자료</h2>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs font-semibold text-ink/58">
            일괄 작업
            <select
              value={action}
              onChange={(event) => {
                setAction(event.target.value as AdminArticleBulkAction);
                setClosePrivateConfirmed(false);
              }}
              className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink"
            >
              <option value="mark-needs-review">검토 필요로 표시</option>
              <option value="close-private">비공개 종결</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink/58">
            메모
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="focus-ring h-10 w-56 rounded-md border border-rule bg-white px-3 text-sm font-normal text-ink"
            />
          </label>
          <button
            type="button"
            disabled={pending || selectedArticles.length === 0 || selectedArticles.length > 100 || (action === "close-private" && !closePrivateConfirmed)}
            onClick={runBulkAction}
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/40"
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ShieldAlert className="size-4" aria-hidden="true" />}
            {pending ? "저장 중" : `${selectedArticles.length}건 적용`}
          </button>
        </div>
        {action === "close-private" ? (
          <label className="flex w-full items-start gap-2 rounded-md border border-court/20 bg-court/5 px-3 py-2 text-xs font-semibold leading-5 text-court">
            <input
              type="checkbox"
              checked={closePrivateConfirmed}
              onChange={(event) => setClosePrivateConfirmed(event.target.checked)}
              className="mt-0.5 size-4 rounded border-court/40 text-court"
            />
            선택한 자료를 비공개 종결하면 검토 큐에서 제외됩니다. 명시적으로 확인한 경우에만 실행합니다.
          </label>
        ) : null}
      </div>

      {message ? (
        <div className={`border-b border-rule px-4 py-3 text-sm font-semibold ${isError ? "text-court" : "text-mint"}`}>
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 p-4 md:hidden">
        {articles.length === 0 ? (
          <div className="rounded-md border border-dashed border-rule px-4 py-8 text-center text-sm text-ink/58">
            조건에 맞는 기사가 없습니다.
          </div>
        ) : (
          articles.map((article) => {
            const key = rowKey(article);
            return (
              <article key={key} className="rounded-md border border-rule bg-parchment/25 p-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(key)}
                    onChange={(event) => toggleArticle(key, event.target.checked)}
                    aria-label={`${article.title} 선택`}
                    className="mt-1 size-4 shrink-0 rounded border-rule text-court"
                  />
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/articles/${article.slug}`} className="focus-ring rounded-sm font-semibold leading-6 text-ink hover:text-court">
                      <span className="break-words">{article.title}</span>
                    </Link>
                    {article.originalTitle && article.originalTitle !== article.title ? (
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-ink/52">{article.originalTitle}</div>
                    ) : null}
                    <div className="mt-1 break-all text-xs text-ink/45">{article.slug}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${statusClass(article.status)}`}>
                    {articleStatusLabel(article.status, article.sourceKey)}
                  </span>
                  <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68">
                    {article.publishable ? "공개 가능" : "공개 불가"}
                  </span>
                  <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68">
                    {article.hasSummary ? "요약 있음" : "요약 없음"}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs leading-5 text-ink/60">
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="font-semibold text-ink/45">기관</dt>
                    <dd className="max-w-full break-words text-right font-semibold text-ink/72">{displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="font-semibold text-ink/45">수집원 키</dt>
                    <dd className="max-w-full break-all text-right">{article.sourceKey}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="font-semibold text-ink/45">국가</dt>
                    <dd className="text-right">{displayJurisdictionLabel(article.jurisdiction)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="font-semibold text-ink/45">기준일</dt>
                    <dd className="text-right">{formatDateTime(article.originalPublishedAt)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="font-semibold text-ink/45">요약일</dt>
                    <dd className="text-right">{formatDateTime(article.summarizedAt)}</dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <Link href={`/admin/articles/${article.slug}`} className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/68 hover:bg-parchment">
                    <Eye className="size-3.5" aria-hidden="true" />
                    상세
                  </Link>
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-rule text-sm">
          <thead className="bg-parchment">
            <tr className="text-left text-xs font-semibold uppercase text-ink/60">
              <th className="w-12 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allCurrentSelected}
                  onChange={(event) => toggleCurrentPage(event.target.checked)}
                  aria-label="현재 페이지 선택"
                  className="size-4 rounded border-rule text-court"
                />
              </th>
              <th className="px-4 py-3">제목</th>
              <th className="px-4 py-3">기관</th>
              <th className="px-4 py-3">국가</th>
              <th className="px-4 py-3">상태</th>
              <th className="px-4 py-3">공개 가능</th>
              <th className="px-4 py-3">요약</th>
              <th className="px-4 py-3">기준일</th>
              <th className="px-4 py-3">요약일</th>
              <th className="px-4 py-3">상세</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {articles.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-ink/58">
                  조건에 맞는 기사가 없습니다.
                </td>
              </tr>
            ) : (
              articles.map((article) => {
                const key = rowKey(article);
                return (
                  <tr key={key}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(key)}
                        onChange={(event) => toggleArticle(key, event.target.checked)}
                        aria-label={`${article.title} 선택`}
                        className="size-4 rounded border-rule text-court"
                      />
                    </td>
                    <td className="max-w-xl px-4 py-3">
                      <Link href={`/admin/articles/${article.slug}`} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
                        {article.title}
                      </Link>
                      {article.originalTitle && article.originalTitle !== article.title ? (
                        <div className="mt-1 line-clamp-1 text-xs text-ink/52">{article.originalTitle}</div>
                      ) : null}
                      <div className="mt-1 text-xs text-ink/45">{article.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName })}</div>
                      <div className="mt-1 text-xs text-ink/54">{article.sourceKey}</div>
                    </td>
                    <td className="px-4 py-3">{displayJurisdictionLabel(article.jurisdiction)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${statusClass(article.status)}`}>
                        {articleStatusLabel(article.status, article.sourceKey)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{article.publishable ? "가능" : "불가"}</td>
                    <td className="px-4 py-3 font-semibold">{article.hasSummary ? "있음" : "없음"}</td>
                    <td className="px-4 py-3">{formatDateTime(article.originalPublishedAt)}</td>
                    <td className="px-4 py-3">{formatDateTime(article.summarizedAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/articles/${article.slug}`} className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
                        <Eye className="size-3.5" aria-hidden="true" />
                        상세
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
