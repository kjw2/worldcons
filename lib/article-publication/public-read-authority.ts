import { articlePublicationV4ReadsEnabled } from "@/lib/article-publication/compatibility";

export type PublicArticleReadAuthority = "projection" | "legacy";

export function publicArticleReadAuthority(
  includeUnpublished = false,
  environment: Record<string, string | undefined> = process.env,
): PublicArticleReadAuthority {
  if (includeUnpublished) return "legacy";
  return articlePublicationV4ReadsEnabled(environment) ? "projection" : "legacy";
}

export function publicProjectionReadsEnabled(
  includeUnpublished = false,
  environment: Record<string, string | undefined> = process.env,
) {
  return publicArticleReadAuthority(includeUnpublished, environment) === "projection";
}

export function publicArticleRelation(
  includeUnpublished = false,
  environment: Record<string, string | undefined> = process.env,
) {
  return publicProjectionReadsEnabled(includeUnpublished, environment)
    ? "public_article_projection_p3"
    : "articles";
}

export function publicVectorMatchRpc(
  includeUnpublished = false,
  environment: Record<string, string | undefined> = process.env,
) {
  return publicProjectionReadsEnabled(includeUnpublished, environment)
    ? "match_public_article_versions_p3"
    : "match_articles";
}
