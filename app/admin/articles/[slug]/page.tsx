import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { AdminArticleReviewPanelLoader } from "@/components/admin-article-review-panel";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { getArticleBySlug } from "@/lib/db/queries";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const authorized = await isAuthorizedPageRequest();
  if (!authorized) {
    redirect(`/admin/login?next=/admin`);
  }

  const article = await getArticleBySlug(slug, { includeUnpublished: true, includeSourceText: false });
  if (!article) notFound();

  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const originalHref = safeExternalUrl(article.originalUrl);

  return (
    <PageShell className="max-w-7xl">
      <section className="mb-7 border-b border-line pb-7">
        <div className="mb-4 flex flex-wrap gap-2">
          <Link href="/admin" className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            관리자
          </Link>
          <Link href={`/articles/${article.slug}`} className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink">
            공개 상세
          </Link>
          {originalHref ? (
            <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg bg-court px-3 text-sm font-semibold text-white transition hover:bg-court/90">
              원문
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <MetaRow
          items={[
            "관리자 검토",
            displayJurisdictionLabel(article.jurisdiction),
            displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName }),
            formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" }),
            article.status,
          ]}
        />
        <h1 className="mt-4 break-keep text-3xl font-semibold leading-tight tracking-normal text-ink sm:text-4xl">{title}</h1>
        {article.originalTitle ? <p className="mt-3 break-keep text-sm leading-6 text-ink-subtle">원문 제목: {article.originalTitle}</p> : null}
      </section>

      <AdminArticleReviewPanelLoader slug={article.slug} />
    </PageShell>
  );
}
