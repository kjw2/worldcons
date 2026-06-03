import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SummarySchema } from "@/lib/ai/schema";
import { normalizeTagForStorage } from "@/lib/ai/tags";
import { completeGeminiJson, getGeminiModels, getGeminiRoutes } from "@/lib/ai/gemini-router";
import { hasGeminiKey } from "@/lib/ai/client";
import { mockSummary } from "@/lib/ai/summarize";
import { runFranceSpider } from "@/lib/crawlee";
import { jsonLdScriptValue } from "@/lib/seo/jsonld";
import { canSummarizeArticle, deriveCollectionStatus, finalizeCollectionMetadata, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { parseRobotsTxt, robotsDelayMs } from "@/lib/crawler/robots";
import { isConstitutionallyRelevant } from "@/lib/sources/relevance";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { isAuthorizedRequest, safeAdminNextPath, validateAdminCredentials } from "@/lib/utils/auth";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { isWithinRange, toIsoDate } from "@/lib/utils/dates";
import { boundedInteger } from "@/lib/utils/numbers";
import { articleFiltersFromSearchParams } from "@/lib/utils/search-params";
import { generateArticleSlug } from "@/lib/utils/slug";
import type { NormalizedArticle } from "@/lib/sources/types";

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function pacificDayForCheck() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

const canonical = canonicalizeUrl("HTTPS://Example.COM/path/?utm_source=x&a=1#frag");
assert(canonical === "https://example.com/path?a=1", "canonical URL normalization failed");
const qpcCanonical = canonicalizeUrl("https://qpc360.conseil-constitutionnel.fr/2026-04-17/decision-2026-1194-qpc-17-avril-2026?searchParams=abc");
assert(
  qpcCanonical === "https://qpc360.conseil-constitutionnel.fr/2026-04-17/decision-2026-1194-qpc-17-avril-2026",
  "QPC360 search context parameter must not create duplicate canonicals",
);
assert(!jsonLdScriptValue({ title: "</script><script>" }).includes("</script>"), "JSON-LD script value must escape script-breaking text");

const article: NormalizedArticle = {
  sourceKey: "us-scotus",
  jurisdiction: "United States",
  institutionName: "Supreme Court of the United States",
  contentType: "opinion",
  originalUrl: "https://www.supremecourt.gov/opinions/test.pdf",
  canonicalUrl: "https://www.supremecourt.gov/opinions/test.pdf",
  originalLanguage: "en",
  originalTitle: "First Amendment standing case",
  originalPublishedAt: "2026-04-29T00:00:00.000Z",
  cleanedText: "The First Amendment and Article III standing are discussed in this opinion.",
};

assert(generateArticleSlug(article).includes("united-states-us-scotus-2026-04-29"), "slug generation failed");
assert(normalizeTagForStorage("Free Speech").slug === "free-speech", "tag normalization failed");
assert(isWithinRange("2026-05-08T10:00:00.000Z", "today", new Date("2026-05-08T12:00:00.000Z")), "date range filter failed");
assert(toIsoDate("17 avril 2026") === "2026-04-17T00:00:00.000Z", "French date parsing failed");
assert(toIsoDate("28.08.2025") === "2025-08-28T00:00:00.000Z", "German dotted date parsing failed");
assert(isConstitutionallyRelevant(article), "constitutional relevance keyword filter failed");
assert(articleFiltersFromSearchParams({ language: "fr" }).language === "fr", "language filter parsing failed");
assert(boundedInteger("-10", 5, { min: 1, max: 20 }) === 1, "bounded integer min clamp failed");
assert(boundedInteger("500", 5, { min: 1, max: 20 }) === 20, "bounded integer max clamp failed");

const originalNodeEnv = process.env.NODE_ENV;
const originalCronSecret = process.env.CRON_SECRET;
const originalAdminUsername = process.env.ADMIN_USERNAME;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
const originalAdminSessionSecret = process.env.ADMIN_SESSION_SECRET;
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV = "production";
delete mutableEnv.CRON_SECRET;
delete mutableEnv.ADMIN_USERNAME;
delete mutableEnv.ADMIN_PASSWORD;
delete mutableEnv.ADMIN_SESSION_SECRET;
assert(
  !isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: "Bearer undefined" } })),
  "missing production CRON_SECRET must not authorize Bearer undefined",
);
assert(!validateAdminCredentials("admin", "admin"), "development admin/admin fallback must stay disabled");
assert(!validateAdminCredentials("admin", "1234"), "legacy admin/1234 credentials must stay disabled");
mutableEnv.CRON_SECRET = "secret";
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest?secret=secret")),
  "query secret authorization failed",
);
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: "Bearer secret" } })),
  "bearer secret authorization failed",
);
mutableEnv.ADMIN_USERNAME = "ap570@naver.com";
mutableEnv.ADMIN_PASSWORD = "P@ssw0rd570";
assert(validateAdminCredentials("ap570@naver.com", "P@ssw0rd570"), "configured admin credentials failed");
assert(!validateAdminCredentials("ap570@naver.com", "secret"), "CRON_SECRET must not be accepted as admin login password");
assert(safeAdminNextPath("/articles/test") === "/admin", "admin login next path must stay within admin routes");
assert(safeAdminNextPath("/admin/analytics?days=7") === "/admin/analytics?days=7", "admin login next path should allow admin routes");
if (originalCronSecret === undefined) delete mutableEnv.CRON_SECRET;
else mutableEnv.CRON_SECRET = originalCronSecret;
if (originalAdminUsername === undefined) delete mutableEnv.ADMIN_USERNAME;
else mutableEnv.ADMIN_USERNAME = originalAdminUsername;
if (originalAdminPassword === undefined) delete mutableEnv.ADMIN_PASSWORD;
else mutableEnv.ADMIN_PASSWORD = originalAdminPassword;
if (originalAdminSessionSecret === undefined) delete mutableEnv.ADMIN_SESSION_SECRET;
else mutableEnv.ADMIN_SESSION_SECRET = originalAdminSessionSecret;
if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
else mutableEnv.NODE_ENV = originalNodeEnv;

const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalVercelUrl = process.env.VERCEL_URL;
delete process.env.APP_BASE_URL;
process.env.VERCEL_URL = "worldcons.example.vercel.app/";
assert(getAppBaseUrl() === "https://worldcons.example.vercel.app", "Vercel base URL fallback failed");
process.env.APP_BASE_URL = "https://library.example.org/";
assert(getAppBaseUrl() === "https://library.example.org", "APP_BASE_URL normalization failed");
if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
else process.env.APP_BASE_URL = originalAppBaseUrl;
if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
else process.env.VERCEL_URL = originalVercelUrl;

const scotusRobots = `User-agent:discobot
Disallow:/

User-agent: SOTScraper
Disallow: /

User-agent:*
Disallow: /images/
Disallow: /rss/
Disallow: /cdn/
Crawl-delay:1`;
const scotusOpinionRobots = parseRobotsTxt(scotusRobots, "https://www.supremecourt.gov/opinions/25pdf/24-781_pok0.pdf");
const scotusImageRobots = parseRobotsTxt(scotusRobots, "https://www.supremecourt.gov/images/test.png");
assert(scotusOpinionRobots.allowed, "SCOTUS /opinions/ PDF path should not inherit discobot disallow");
assert(scotusOpinionRobots.crawlDelaySeconds === 1, "SCOTUS crawl-delay parsing failed");
assert(robotsDelayMs(scotusOpinionRobots, 2000) >= 2000, "Operational crawl delay must default to at least 2 seconds");
assert(!scotusImageRobots.allowed && scotusImageRobots.matchedRule === "/images/", "SCOTUS disallowed asset path parsing failed");

const seedArticle: NormalizedArticle = {
  ...article,
  cleanedText: "",
  metadata: {
    collection: {
      strategy: "seed",
      confidence: "low",
      sourceUrlVerified: false,
      sourceTextAvailable: false,
      publishable: false,
    },
  },
};

assert(deriveCollectionStatus(seedArticle) === "metadata_only", "seed records must remain metadata-only");
assert(!finalizeCollectionMetadata(seedArticle).publishable, "seed records must never be publishable");
assert(
  !canSummarizeArticle({
    status: "metadata_only",
    cleaned_text: "",
    source_metadata: seedArticle.metadata,
  }),
  "seed metadata-only records must not be summarized",
);

const publishableText = "First Amendment Article III standing ".repeat(Math.ceil(MIN_PUBLISHABLE_TEXT_LENGTH / 36));
const publishableArticle: NormalizedArticle = {
  ...article,
  cleanedText: publishableText,
  metadata: {
    collection: {
      strategy: "fetch",
      confidence: "high",
      sourceUrlVerified: true,
      sourceTextAvailable: true,
      publishable: true,
    },
  },
};

assert(deriveCollectionStatus(publishableArticle) === "cleaned", "verified full-text records should be cleaned");
assert(finalizeCollectionMetadata(publishableArticle).publishable, "verified full-text records should be publishable");
assert(
  canSummarizeArticle({
    status: "cleaned",
    cleaned_text: publishableText,
    source_metadata: publishableArticle.metadata,
  }),
  "verified full-text records should be eligible for summarization",
);
assert(
  canSummarizeArticle({
    status: "failed_summary",
    cleaned_text: publishableText,
    source_metadata: publishableArticle.metadata,
  }),
  "failed_summary records with verified full text must be eligible for retry",
);

const originalGeminiAutoDiscoverModels = process.env.GEMINI_AUTO_DISCOVER_MODELS;
const originalGeminiModelCatalogPath = process.env.GEMINI_MODEL_CATALOG_PATH;
const originalGeminiModelCatalogTtlMs = process.env.GEMINI_MODEL_CATALOG_TTL_MS;
delete process.env.GEMINI_PINNED_MODEL;
delete process.env.GEMINI_ALLOW_MODEL_OVERRIDE;
process.env.GEMINI_SUMMARY_MODELS = "gemini-2.5-flash";
delete process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEYS = "one,two";
process.env.GEMINI_AUTO_DISCOVER_MODELS = "false";
assert(hasGeminiKey(), "Gemini key detection must support GEMINI_API_KEYS");
const defaultGeminiModels = getGeminiModels();
assert(defaultGeminiModels[0] === "gemini-3.1-flash-lite", "Gemini default routing must start with stable Gemini 3.1 Flash-Lite");
assert(defaultGeminiModels.includes("gemini-3.1-pro-preview"), "Gemini default routing must include Gemini 3.1 Pro Preview");
assert(!defaultGeminiModels.includes("gemini-3-pro-preview"), "Gemini default routing must not include shut down Gemini 3 Pro Preview");
assert(defaultGeminiModels.some((model) => model.startsWith("gemini-2.5")), "Gemini default routing must include Gemini 2.5 generation");
assert(defaultGeminiModels.some((model) => model.startsWith("gemini-2")), "Gemini default routing must include Gemini 2 generation");
const reasoningGeminiModels = getGeminiModels("Reasoning");
assert(reasoningGeminiModels[0] === "gemini-3.1-pro-preview", "Gemini reasoning routing must use Gemini 3.1 Pro Preview");

const geminiModelCatalogPath = path.join(os.tmpdir(), `worldcons-gemini-model-catalog-${process.pid}.json`);
fs.writeFileSync(
  geminiModelCatalogPath,
  JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    models: [
      {
        name: "models/gemini-4-flash-lite",
        baseModelId: "gemini-4-flash-lite",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-4-pro-preview",
        baseModelId: "gemini-4-pro-preview",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-4-flash-image",
        baseModelId: "gemini-4-flash-image",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-embedding-001",
        baseModelId: "gemini-embedding-001",
        supportedGenerationMethods: ["embedContent"],
      },
    ],
  }),
  "utf8",
);
process.env.GEMINI_AUTO_DISCOVER_MODELS = "true";
process.env.GEMINI_MODEL_CATALOG_PATH = geminiModelCatalogPath;
process.env.GEMINI_MODEL_CATALOG_TTL_MS = "86400000";
const dynamicGeminiModels = getGeminiModels();
assert(dynamicGeminiModels[0] === "gemini-4-flash-lite", "Gemini dynamic catalog routing must adopt newer Flash-Lite models");
assert(!dynamicGeminiModels.includes("gemini-4-flash-image"), "Gemini dynamic catalog routing must exclude image-output models");
assert(getGeminiModels("Reasoning")[0] === "gemini-4-pro-preview", "Gemini dynamic catalog reasoning route must prefer newer Pro models");
fs.rmSync(geminiModelCatalogPath, { force: true });
process.env.GEMINI_AUTO_DISCOVER_MODELS = "false";
if (originalGeminiModelCatalogPath === undefined) delete process.env.GEMINI_MODEL_CATALOG_PATH;
else process.env.GEMINI_MODEL_CATALOG_PATH = originalGeminiModelCatalogPath;
if (originalGeminiModelCatalogTtlMs === undefined) delete process.env.GEMINI_MODEL_CATALOG_TTL_MS;
else process.env.GEMINI_MODEL_CATALOG_TTL_MS = originalGeminiModelCatalogTtlMs;

const originalGeminiRouterStatePath = process.env.GEMINI_ROUTER_STATE_PATH;
const originalGeminiEnforceLocalRpd = process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS;
const geminiRouterStatePath = path.join(os.tmpdir(), `worldcons-gemini-router-${process.pid}.json`);
fs.writeFileSync(
  geminiRouterStatePath,
  JSON.stringify({
    version: 1,
    day: pacificDayForCheck(),
    routes: {
      "gemini-3.1-flash-lite::key-1": {
        rpdUsed: 999_999,
        rpmTimestamps: [],
        dailyExhausted: false,
        cooldownUntil: null,
      },
    },
  }),
  "utf8",
);
process.env.GEMINI_ROUTER_STATE_PATH = geminiRouterStatePath;
delete process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS;
assert(
  getGeminiRoutes().some((route) => route.model === "gemini-3.1-flash-lite"),
  "Gemini local RPD estimates must not disable routes unless explicitly enabled",
);
process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS = "true";
assert(
  !getGeminiRoutes().some((route) => route.model === "gemini-3.1-flash-lite" && route.keyLabel === "key-1"),
  "Gemini local RPD guard must remain available as an explicit opt-in per key",
);
fs.rmSync(geminiRouterStatePath, { force: true });
if (originalGeminiRouterStatePath === undefined) delete process.env.GEMINI_ROUTER_STATE_PATH;
else process.env.GEMINI_ROUTER_STATE_PATH = originalGeminiRouterStatePath;
if (originalGeminiEnforceLocalRpd === undefined) delete process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS;
else process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS = originalGeminiEnforceLocalRpd;
if (originalGeminiAutoDiscoverModels === undefined) delete process.env.GEMINI_AUTO_DISCOVER_MODELS;
else process.env.GEMINI_AUTO_DISCOVER_MODELS = originalGeminiAutoDiscoverModels;
process.env.GEMINI_ALLOW_MODEL_OVERRIDE = "true";
assert(getGeminiModels().length === 1 && getGeminiModels()[0] === "gemini-2.5-flash", "Gemini model override flag failed");

const fallbackSummary = mockSummary(article);
assert(fallbackSummary.aiMetadata?.model === "development-fallback", "mock summary metadata missing");

SummarySchema.parse({
  koreanTitle: "테스트",
  originalTitle: "Test",
  summary: {
    coreSummary: ["요약"],
    referencedProvisions: [],
    background: "배경",
    caseStructure: "구조",
    implications: "시사점",
    practicalNotes: "참고",
  },
  entities: [],
  tags: ["테스트"],
  categories: ["development"],
  riskFlags: ["source_text_incomplete"],
  aiMetadata: {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    generatedAt: "2026-05-08T00:00:00.000Z",
  },
});

async function assertGeminiRouterSurvivesUnwritableStorage() {
  const keysToRestore = [
    "GEMINI_API_KEY",
    "GEMINI_API_KEYS",
    "GEMINI_AUTO_DISCOVER_MODELS",
    "GEMINI_MODEL_CATALOG_PATH",
    "GEMINI_MODEL_CATALOG_TTL_MS",
    "GEMINI_ROUTER_STATE_PATH",
    "GEMINI_PINNED_MODEL",
    "GEMINI_ALLOW_MODEL_OVERRIDE",
    "GEMINI_SUMMARY_MODEL",
    "GEMINI_SUMMARY_MODELS",
  ];
  const originalEnv = new Map(keysToRestore.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const blockerPath = path.join(os.tmpdir(), `worldcons-gemini-unwritable-${process.pid}`);

  try {
    fs.writeFileSync(blockerPath, "not a directory", "utf8");
    process.env.GEMINI_API_KEYS = "test-key";
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_AUTO_DISCOVER_MODELS = "true";
    process.env.GEMINI_MODEL_CATALOG_PATH = path.join(blockerPath, "catalog.json");
    process.env.GEMINI_MODEL_CATALOG_TTL_MS = "86400000";
    process.env.GEMINI_ROUTER_STATE_PATH = path.join(blockerPath, "state.json");
    delete process.env.GEMINI_PINNED_MODEL;
    delete process.env.GEMINI_ALLOW_MODEL_OVERRIDE;
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_SUMMARY_MODELS;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":generateContent")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "{\"ok\":true}" }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/v1beta/models")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-4-flash-lite",
                baseModelId: "gemini-4-flash-lite",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await completeGeminiJson([{ role: "user", content: "요약 테스트" }]);
    if (!result) throw new Error("Gemini router must return a result when local storage is unwritable");
    assert(result.provider === "gemini", "Gemini router must return a result when local storage is unwritable");
    assert(result.model === "gemini-4-flash-lite", "Gemini router must use in-memory model catalog fallback when catalog save fails");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(blockerPath, { force: true });
    for (const key of keysToRestore) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  await assertGeminiRouterSurvivesUnwritableStorage();

  const franceSeedOnly = await withTimeout(runFranceSpider({ limit: 1, strategy: "seed", usePlaywright: false }), 10_000, {
    sourceKey: "fr-conseil-constitutionnel",
    items: [],
    diagnostics: { sourceKey: "fr-conseil-constitutionnel", attempts: [] },
    strategySequence: [],
    usedSeedFallback: false,
  });
  assert(franceSeedOnly.items.length === 0, "France seed fallback must save candidates only, not article rows");

  console.log("All checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
