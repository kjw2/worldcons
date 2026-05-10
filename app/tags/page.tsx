import type { Metadata } from "next";
import { TagHubList } from "@/components/tag-hub-list";
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

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-court">태그 허브</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">쟁점·권리·조문별 탐색</h1>
      </div>
      <TagHubList tags={tags} />
    </main>
  );
}
