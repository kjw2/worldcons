import type { Metadata } from "next";
import { headers } from "next/headers";
import { TagHubList } from "@/components/tag-hub-list";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listTags } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "태그 허브",
  description: "세계 헌법재판 자료를 쟁점, 권리, 조문, 절차 태그별로 탐색합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/tags` },
};

export default async function TagsPage() {
  const tags = await listTags({ sort: "count" });
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
      <SectionHeading
        className="mb-7 border-b border-archive-line-strong pb-6"
        eyebrow="Topics"
        title="헌법 주제"
      />
      <TagHubList tags={tags} />
    </PageShell>
  );
}
