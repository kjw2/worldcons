"use client";

import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { articleHrefWithReturnTo, safeArticleReturnPath } from "@/lib/navigation/article-return";

function useArticleReturnHref() {
  const [returnHref, setReturnHref] = useState("/v2");

  useEffect(() => {
    const resolveReturnHref = () => {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const legacySearchParams = new URLSearchParams(window.location.search);
      setReturnHref(
        safeArticleReturnPath(hashParams.get("returnTo") ?? legacySearchParams.get("returnTo")) ?? "/v2",
      );
    };

    resolveReturnHref();
    window.addEventListener("hashchange", resolveReturnHref);
    return () => window.removeEventListener("hashchange", resolveReturnHref);
  }, []);

  return returnHref;
}

export function ArticleReturnLink({ className }: { className?: string }) {
  const returnHref = useArticleReturnHref();

  return (
    <IntentPrefetchLink href={returnHref} className={className}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      목록으로
    </IntentPrefetchLink>
  );
}

export function RelatedArticleLink({
  slug,
  className,
  children,
}: {
  slug: string;
  className?: string;
  children: ReactNode;
}) {
  const returnHref = useArticleReturnHref();

  return (
    <IntentPrefetchLink href={articleHrefWithReturnTo(slug, returnHref)} className={className}>
      {children}
    </IntentPrefetchLink>
  );
}
