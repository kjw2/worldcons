import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { listSources } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "수집 대상 기관",
  description: "세계 헌법재판 큐레이션의 공식 수집 소스와 최신 자료를 확인합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/sources` },
};

export default async function SourcesPage() {
  const sources = await listSources();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-court">공식 소스</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">수집 대상 기관</h1>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {sources.map((source) => (
          <section key={source.sourceKey} className="rounded-md border border-rule bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-court">{source.jurisdiction}</p>
            <h2 className="mt-2 text-lg font-semibold">{source.name}</h2>
            <p className="mt-2 text-sm text-ink/62">
              source_key: {source.sourceKey} · language: {source.language}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/sources/${source.sourceKey}`} className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white">
                상세
              </Link>
              <a href={source.baseUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-sm">
                공식 사이트
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
