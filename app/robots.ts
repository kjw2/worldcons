import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Training crawlers only; search and user-initiated retrieval retain the default policy.
      ...["ClaudeBot", "meta-externalagent", "GPTBot"].map((userAgent) => ({
        userAgent,
        disallow: "/",
      })),
      {
        userAgent: "*",
        allow: ["/", "/admin/login"],
        disallow: ["/admin", "/admin/", "/api/", "/api/*", "/articles/*/print"],
      },
    ],
    sitemap: `${getAppBaseUrl()}/sitemap.xml`,
  };
}
