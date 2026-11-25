import assert from "node:assert/strict";
import test from "node:test";
import robots from "../app/robots";
import { getAppBaseUrl } from "../lib/seo/metadata";

test("robots blocks only designated training crawlers and preserves public search policy", () => {
  const result = robots();
  assert.deepEqual(result.rules, [
    { userAgent: "ClaudeBot", disallow: "/" },
    { userAgent: "meta-externalagent", disallow: "/" },
    { userAgent: "GPTBot", disallow: "/" },
    {
      userAgent: "*",
      allow: ["/", "/admin/login"],
      disallow: ["/admin", "/admin/", "/api/", "/api/*", "/articles/*/print"],
    },
  ]);
  assert.equal(result.sitemap, `${getAppBaseUrl()}/sitemap.xml`);
});
