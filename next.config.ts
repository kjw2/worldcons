import type { NextConfig } from "next";
import { assertProductionSecurityConfig } from "./lib/security/production-config";

if (process.env.VERCEL_ENV === "production") {
  assertProductionSecurityConfig(process.env);
}

const contentSecurityPolicyReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "report-uri /api/security/csp-report",
  "report-to csp",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicyReportOnly },
  { key: "Reporting-Endpoints", value: "csp=\"/api/security/csp-report\"" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

const legacyV2Redirects = [
  { source: "/v2", destination: "/" },
  { source: "/v2/:path*", destination: "/:path*" },
] as const;

const nextConfig: NextConfig = {
  typedRoutes: false,
  async redirects() {
    return legacyV2Redirects.map((route) => ({ ...route, permanent: true }));
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  serverExternalPackages: ["@mozilla/readability", "cheerio", "crawlee", "jsdom", "pdf-parse", "playwright", "playwright-core", "rss-parser"],
  outputFileTracingExcludes: {
    "*": [".cache/**", ".crawlee-storage/**", "cache/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/next/dist/server/lib/incremental-cache/memory-cache.external.js",
      "./node_modules/next/dist/server/lib/incremental-cache/shared-cache-controls.external.js",
      "./node_modules/next/dist/server/lib/incremental-cache/tags-manifest.external.js",
      "./node_modules/next/dist/server/response-cache/types.js",
      "./node_modules/undici/lib/**/*.js",
      "./node_modules/lru-cache/**/*",
      "./node_modules/.pnpm/lru-cache@*/node_modules/lru-cache/**/*",
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
