import "dotenv/config";
import { SummarySchema } from "@/lib/ai/schema";
import { normalizeTagForStorage } from "@/lib/ai/tags";
import { getGeminiModels } from "@/lib/ai/gemini-router";
import { hasGeminiKey } from "@/lib/ai/client";
import { mockSummary } from "@/lib/ai/summarize";
import { runFranceSpider } from "@/lib/crawlee";
import { canSummarizeArticle, deriveCollectionStatus, finalizeCollectionMetadata, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { parseRobotsTxt, robotsDelayMs } from "@/lib/crawler/robots";
import { isConstitutionallyRelevant } from "@/lib/sources/relevance";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { isAuthorizedRequest } from "@/lib/utils/auth";
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

const canonical = canonicalizeUrl("HTTPS://Example.COM/path/?utm_source=x&a=1#frag");
assert(canonical === "https://example.com/path?a=1", "canonical URL normalization failed");

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
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV = "production";
delete mutableEnv.CRON_SECRET;
assert(
  !isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: "Bearer undefined" } })),
  "missing production CRON_SECRET must not authorize Bearer undefined",
);
mutableEnv.CRON_SECRET = "secret";
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest?secret=secret")),
  "query secret authorization failed",
);
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: "Bearer secret" } })),
  "bearer secret authorization failed",
);
if (originalCronSecret === undefined) delete mutableEnv.CRON_SECRET;
else mutableEnv.CRON_SECRET = originalCronSecret;
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

delete process.env.GEMINI_PINNED_MODEL;
delete process.env.GEMINI_ALLOW_MODEL_OVERRIDE;
process.env.GEMINI_SUMMARY_MODELS = "gemini-2.5-flash";
delete process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEYS = "one,two";
assert(hasGeminiKey(), "Gemini key detection must support GEMINI_API_KEYS");
const defaultGeminiModels = getGeminiModels();
assert(defaultGeminiModels[0]?.startsWith("gemini-3"), "Gemini default routing must start with Gemini 3 generation");
assert(defaultGeminiModels.some((model) => model.startsWith("gemini-2.5")), "Gemini default routing must include Gemini 2.5 generation");
assert(defaultGeminiModels.some((model) => model.startsWith("gemini-2")), "Gemini default routing must include Gemini 2 generation");
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

async function main() {
  const franceSeedOnly = await withTimeout(runFranceSpider({ limit: 1, strategy: "seed", usePlaywright: false }), 10_000, {
    sourceKey: "fr-conseil-constitutionnel",
    items: [],
    diagnostics: { sourceKey: "fr-conseil-constitutionnel", attempts: [] },
    strategySequence: [],
    usedSeedFallback: false,
  });
  assert(franceSeedOnly.items.length === 0, "France seed fallback must save candidates only, not article rows");

  console.log("All checks passed.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
