import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TagHubList } from "@/components/tag-hub-list";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listTags } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { MIN_INDEXABLE_TAG_ARTICLE_COUNT } from "@/lib/seo/public-urls";
import { paginateTagHub, parseTagHubPage, tagHubMetadata, tagHubPageHref } from "@/lib/seo/tag-hub-pagination";
import { resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ searchParams }: { searchParams?: Promise<SearchParams> }): Promise<Metadata> {
  const params = await resolveSearchParams(searchParams);
  return {
    title: "헌법 쟁점",
    description: "세계 헌법재판 자료를 기본권, 헌법원칙, 절차와 주요 쟁점별로 탐색합니다.",
    ...tagHubMetadata(parseTagHubPage(params.page), getAppBaseUrl()),
  };
}

export default async function TagsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const page = parseTagHubPage(params.page);
  if (page === null) notFound();
  const tags = await listTags({ sort: "count", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT });
  const pagination = paginateTagHub(tags, page);
  if (!pagination) notFound();
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/tags",
      resultCount: tags.length,
    },
    await headers(),
  );

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <header className="mb-7 border-b border-archive-line-strong pb-6">
        <h1 className="text-3xl font-semibold text-archive-ink">주제별 판례 색인</h1>
        <p className="mt-3 max-w-[72ch] text-[15px] leading-7 text-archive-text">기본권, 헌법원칙, 절차와 주요 쟁점을 기준으로 관련 판례를 찾아볼 수 있습니다.</p>
      </header>
      <p className="mb-5 text-sm text-archive-muted">
        전체 {pagination.total.toLocaleString("ko-KR")}개 주제 중
        {" "}{((page - 1) * pagination.pageSize + (pagination.tags.length ? 1 : 0)).toLocaleString("ko-KR")}–
        {((page - 1) * pagination.pageSize + pagination.tags.length).toLocaleString("ko-KR")}번째 · {page}/{pagination.totalPages}페이지
      </p>
      <TagHubList tags={pagination.tags} />
      {pagination.totalPages > 1 ? (
        <nav className="mt-10 border-t border-archive-line-strong pt-5" aria-label="주제 목록 페이지 이동">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {page > 1 ? <Link className="focus-ring rounded-sm border border-archive-line px-3 py-2 text-sm hover:bg-archive-surface" href={tagHubPageHref(page - 1)}>이전</Link> : null}
            {Array.from({ length: pagination.totalPages }, (_, index) => index + 1).map((target) => (
              <Link
                key={target}
                href={tagHubPageHref(target)}
                aria-current={target === page ? "page" : undefined}
                className={target === page
                  ? "focus-ring inline-flex size-9 items-center justify-center rounded-sm border border-archive-accent bg-archive-tint text-sm font-bold text-archive-accent"
                  : "focus-ring inline-flex size-9 items-center justify-center rounded-sm border border-archive-line text-sm hover:border-archive-accent hover:text-archive-accent"}
              >{target}</Link>
            ))}
            {page < pagination.totalPages ? <Link className="focus-ring rounded-sm border border-archive-line px-3 py-2 text-sm hover:bg-archive-surface" href={tagHubPageHref(page + 1)}>다음</Link> : null}
          </div>
        </nav>
      ) : null}
    </PageShell>
  );
}
