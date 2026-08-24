import type { Metadata } from "next";
import { headers } from "next/headers";
import { TagHubList } from "@/components/tag-hub-list";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listTags } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { MIN_INDEXABLE_TAG_ARTICLE_COUNT } from "@/lib/seo/public-urls";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "헌법 쟁점",
  description: "세계 헌법재판 자료를 기본권, 헌법원칙, 절차와 주요 쟁점별로 탐색합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/tags` },
};

export default async function TagsPage() {
  const tags = await listTags({ sort: "count", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT });
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
        <p className="text-sm font-bold text-archive-accent">헌법 쟁점</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.03em] text-archive-ink">주제별 판례 색인</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-7 text-archive-text">기본권, 헌법원칙, 절차와 주요 쟁점을 기준으로 관련 판례를 찾아볼 수 있습니다.</p>
      </header>
      <TagHubList tags={tags} />
    </PageShell>
  );
}
