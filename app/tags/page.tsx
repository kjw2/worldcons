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
    <PageShell>
      <SectionHeading
        className="mb-6"
        eyebrow="태그 허브"
        title="쟁점·권리·조문별 탐색"
        description="반복해서 등장하는 헌법 쟁점과 절차, 권리, 조문을 태그 단위로 모아봅니다. AI가 생성한 태그이므로 부정확할 수 있으니 반드시 확인하시기 바랍니다."
      />
      <TagHubList tags={tags} />
    </PageShell>
  );
}
