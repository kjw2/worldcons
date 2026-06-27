import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/admin/", "/api/", "/api/*", "/articles/*/print"],
      },
    ],
    sitemap: `${getAppBaseUrl()}/sitemap.xml`,
  };
}
