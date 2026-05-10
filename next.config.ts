import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: false,
  serverExternalPackages: ["@mozilla/readability", "cheerio", "crawlee", "jsdom", "pdf-parse", "playwright", "playwright-core", "rss-parser"],
  outputFileTracingExcludes: {
    "*": [".cache/**", ".crawlee-storage/**", "cache/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/next/dist/server/lib/incremental-cache/memory-cache.external.js",
      "./node_modules/next/dist/server/lib/incremental-cache/shared-cache-controls.external.js",
      "./node_modules/next/dist/server/lib/incremental-cache/tags-manifest.external.js",
    ],
  },
  experimental: {
    cpus: 1,
    memoryBasedWorkersCount: true,
    webpackBuildWorker: false,
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
