"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, Printer } from "lucide-react";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export function ArticlePrintActions({
  articleHref,
  originalUrl,
}: {
  articleHref: string;
  originalUrl?: string | null;
}) {
  const originalHref = safeExternalUrl(originalUrl);

  return (
    <div className="print-hidden mb-5 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-sm bg-court px-4 text-sm font-semibold text-white transition-colors hover:bg-court/90"
      >
        <Printer className="size-4" aria-hidden="true" />
        인쇄
      </button>
      <Link href={articleHref} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-sm border border-line bg-white px-4 text-sm font-semibold text-ink-muted transition-colors hover:border-line-strong hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" />
        상세로
      </Link>
      {originalHref ? (
        <a href={originalHref} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-sm border border-court/25 bg-court/5 px-4 text-sm font-semibold text-court transition-colors hover:bg-court/10">
          원문
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
