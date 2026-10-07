import { cache } from "react";
import { getArticleDetailPageData } from "@/lib/db/queries";

export const getCachedArticleDetailPageData = cache(
  async (slug: string) => getArticleDetailPageData(slug),
);
