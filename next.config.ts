import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: false,
  serverExternalPackages: ["@mozilla/readability", "cheerio", "crawlee", "jsdom", "pdf-parse", "playwright", "playwright-core", "rss-parser"],
  outputFileTracingExcludes: {
    "*": [".cache/**", ".crawlee-storage/**", "cache/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  experimental: {
    cpus: 1,
    memoryBasedWorkersCount: true,
    webpackBuildWorker: false,
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
