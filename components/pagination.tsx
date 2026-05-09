import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageInfo } from "@/lib/db/types";

function pageHref(basePath: string, params: URLSearchParams, page: number) {
  const nextParams = new URLSearchParams(params);
  if (page <= 1) nextParams.delete("page");
  else nextParams.set("page", String(page));
  const query = nextParams.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function Pagination({ pageInfo, params, basePath = "/" }: { pageInfo: PageInfo; params: URLSearchParams; basePath?: string }) {
  const totalPages = Math.max(1, Math.ceil(pageInfo.total / pageInfo.pageSize));
  const hasPrevious = pageInfo.page > 1;
  const hasNext = pageInfo.page < totalPages;

  if (totalPages <= 1) return null;

  return (
    <nav className="mt-6 flex items-center justify-between gap-3 text-sm" aria-label="페이지">
      {hasPrevious ? (
        <Link href={pageHref(basePath, params, pageInfo.page - 1)} className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 font-medium text-ink/72">
          <ChevronLeft className="size-4" aria-hidden="true" />
          이전
        </Link>
      ) : (
        <span />
      )}
      <span className="text-ink/58">
        {pageInfo.page} / {totalPages}
      </span>
      {hasNext ? (
        <Link href={pageHref(basePath, params, pageInfo.page + 1)} className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 font-medium text-ink/72">
          다음
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
