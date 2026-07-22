import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../next.config";
import { normalizeSummaryCandidate, SummarySchema } from "@/lib/ai/schema";
import { normalizeTagForStorage } from "@/lib/ai/tags";
import { completeGeminiJson, getGeminiModels, getGeminiRoutes } from "@/lib/ai/gemini-router";
import { hasGeminiKey, supportsOpenAiTemperature } from "@/lib/ai/client";
import { llmSettingsEncryptionSecretSource } from "@/lib/ai/llm-settings";
import { mockSummary } from "@/lib/ai/summarize";
import {
  buildSpainTcFallbackRawArticle,
  buildSpainTcRawArticleFromJson,
  contentTypeForResolutionType,
  normalizeSpainDecisionDate,
  parseSpanishLongDate,
  runFranceSpider,
} from "@/lib/crawlee";
import { effectiveRangeDaysForSource } from "@/lib/ingest/run";
import { normalizeRawArticle } from "@/lib/ingest/normalize";
import { jsonLdScriptValue } from "@/lib/seo/jsonld";
import { canSummarizeArticle, deriveCollectionStatus, finalizeCollectionMetadata, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import {
  isGlobalSummaryBackoff,
  orderSummaryCandidatesRoundRobin,
  summaryBatchHasHardFailure,
  summaryBatchNeedsFollowUp,
  summaryBatchWasDeferred,
  summaryRetryDelayMs,
} from "@/lib/ingest/summary-batch";
import { parseManualSummaryEditInput } from "@/lib/ingest/manual-summary-edit";
import { parseRobotsTxt, robotsDelayMs } from "@/lib/crawler/robots";
import { isConstitutionallyRelevant } from "@/lib/sources/relevance";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import {
  redactAdminAuditEventInput,
  redactAdminAuditMetadata,
  redactAdminAuditText,
  redactAdminAuditPath,
  isAdminAuditEventType,
} from "@/lib/security/audit-redaction";
import {
  parseAnalyticsEventBody,
  parseArticleListApiParams,
  parseSearchApiParams,
  parseSlugParam,
  parseSourceKeyParam,
  parseTagsApiParams,
} from "@/lib/security/public-api-validation";
import {
  ADMIN_SESSION_COOKIE,
  createAdminCsrfTokenForSession,
  createAdminSession,
  isAuthorizedAdminMutationRequest,
  isAuthorizedRequest,
  portalAuthFailureStatus,
  safeAdminNextPath,
  validateAdminCredentials,
  validateProductionSecurityConfig,
  WORLDLAWS_PORTAL_TOKEN_HEADER,
} from "@/lib/utils/auth";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { isWithinRange, toIsoDate } from "@/lib/utils/dates";
import { boundedInteger } from "@/lib/utils/numbers";
import { safeExternalUrl } from "@/lib/utils/safe-url";
import {
  articleHrefWithReturnTo,
  safeArticleReturnPath,
} from "@/lib/navigation/article-return";
import { articleFiltersFromSearchParams } from "@/lib/utils/search-params";
import { generateArticleSlug } from "@/lib/utils/slug";
import { canonicalizeTerminologyText, canonicalizeTerminologyValue } from "@/lib/ai/terminology";
import { adminAuditEntryFromSiteEvent } from "@/lib/db/analytics";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { tribunalConstitucionalAdapter } from "@/lib/sources/tribunalconstitucional";
import {
  classifyJudicialComplaint,
  ensureJudicialComplaintTags,
  JUDICIAL_COMPLAINT_TAG_NAME,
} from "@/lib/tags/judicial-complaint";
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
const xssFixtures = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "</script><script>alert(1)</script>",
  "javascript:alert(1)",
  "\"><svg onload=alert(1)>",
];
for (const fixture of xssFixtures) {
  const jsonLd = jsonLdScriptValue({ title: fixture, summary: fixture });
  assert(!/[<>]/.test(jsonLd), "JSON-LD must escape active markup delimiters");
  const inlineText = renderToStaticMarkup(createElement("div", null, fixture));
  assert(!/<(?:script|img|svg)\b|<[^>]+\s(?:onerror|onload)=/i.test(inlineText), "React text rendering must escape XSS fixtures");
  const sourceSnapshot = renderToStaticMarkup(createElement("pre", null, fixture));
  assert(!/<(?:script|img|svg)\b|<[^>]+\s(?:onerror|onload)=/i.test(sourceSnapshot), "source snapshot rendering must escape XSS fixtures");
}
assert(safeExternalUrl("javascript:alert(1)") === null, "javascript: URLs must not be rendered as external links");
assert(safeExternalUrl("data:text/html,<script>alert(1)</script>") === null, "data: URLs must not be rendered as external links");
assert(safeExternalUrl("https://example.test/source?id=1") === "https://example.test/source?id=1", "http(s) external URLs should remain available");
assert(
  safeArticleReturnPath("/v2/list?tag=f0cc9e78&page=7") === "/v2/list?tag=f0cc9e78&page=7",
  "article return paths must retain list filters and pagination",
);
assert(
  safeArticleReturnPath("/v2/search?q=%ED%91%9C%ED%98%84&page=3") === "/v2/search?q=%ED%91%9C%ED%98%84&page=3",
  "article return paths must retain search state",
);
assert(
  safeArticleReturnPath("/v2/tags/f0cc9e78") === "/v2/tags/f0cc9e78"
    && safeArticleReturnPath("/sources/de-bverfg") === "/sources/de-bverfg",
  "article return paths must allow public tag and source lists",
);
assert(
  safeArticleReturnPath("//evil.example/list") === null
    && safeArticleReturnPath("https://evil.example/list") === null
    && safeArticleReturnPath("/admin/articles") === null
    && safeArticleReturnPath("/api/articles") === null,
  "article return paths must reject external and privileged destinations",
);
assert(
  articleHrefWithReturnTo("example-case", "/v2/list?tag=f0cc9e78&page=7")
    === "/v2/articles/example-case#returnTo=%2Fv2%2Flist%3Ftag%3Df0cc9e78%26page%3D7",
  "article links must encode the complete return path",
);
assert(parseArticleListApiParams(new URLSearchParams("q=due+process&page=2&pageSize=100&tag=due-process")).ok, "valid article API params should pass");
assert(!parseArticleListApiParams(new URLSearchParams("pageSize=101")).ok, "oversized pageSize must fail validation");
assert(!parseArticleListApiParams(new URLSearchParams("tag=slug.eq.safe,name.eq.unsafe")).ok, "PostgREST .or metacharacters in tag filters must fail validation");
assert(!parseArticleListApiParams(new URLSearchParams(`q=${"a".repeat(201)}`)).ok, "oversized q must fail validation");
assert(!parseSearchApiParams(new URLSearchParams("mode=unexpected")).ok, "invalid search mode must fail validation");
assert(!parseTagsApiParams(new URLSearchParams("sort=unexpected")).ok, "invalid tag sort must fail validation");
assert(parseSlugParam("france-fr-conseil-constitutionnel-2026-06-12").ok, "valid slugs should pass validation");
assert(!parseSlugParam("javascript:alert(1)").ok, "unsafe slug characters must fail validation");
assert(!parseSourceKeyParam("../secret").ok, "unsafe sourceKey characters must fail validation");
assert(
  parseAnalyticsEventBody({ eventType: "tag_click", path: "/tags/due-process", tagSlug: "due-process", metadata: { surface: "card", count: 1 } }).ok,
  "valid analytics event body should pass validation",
);
assert(!parseAnalyticsEventBody({ eventType: "tag_click", path: "https://evil.test" }).ok, "absolute analytics event paths must fail validation");
assert(!parseAnalyticsEventBody({ eventType: "tag_click", path: "/x", metadata: { nested: { bad: true } } }).ok, "nested analytics metadata must fail validation");
const adminAuditEntry = adminAuditEntryFromSiteEvent({
  id: "audit-test",
  occurred_at: "2026-07-07T00:00:00.000Z",
  event_type: "admin_action",
  article_slug: null,
  source_key: "de-bverfg",
  path: "/api/admin/ingest?secret=plain-secret-value",
  metadata: {
    action: "ingest-and-summarize",
    requestedAction: "ingest-and-summarize",
    requestedLimit: 5,
    requestedSummarizeLimit: 10,
    requestedAllowVercelCrawling: false,
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    result: "completed",
    errorMessage: "provider returned sk-proj-secretvalue1234567890 with Bearer abcdefghijklmnopqrstuvwxyz012345",
    apiKey: "sk-test-should-not-be-promoted",
  },
});
assert(adminAuditEntry.action === "ingest-and-summarize", "admin audit helper must parse action metadata");
assert(adminAuditEntry.sourceKey === "de-bverfg", "admin audit helper must preserve source key");
assert(adminAuditEntry.provider === "gemini", "admin audit helper must parse provider");
assert(adminAuditEntry.model === "gemini-3.1-flash-lite", "admin audit helper must parse model");
assert(adminAuditEntry.result === "completed", "admin audit helper must parse result");
assert(JSON.stringify({ action: adminAuditEntry.action, path: adminAuditEntry.path, provider: adminAuditEntry.provider, model: adminAuditEntry.model, result: adminAuditEntry.result, error: adminAuditEntry.error }).includes("sk-test") === false, "admin audit display fields must not promote secret-like metadata");
assert(adminAuditEntry.path === "/api/admin/ingest?secret=[redacted]", "admin audit path query secrets must be redacted");
assert(!JSON.stringify({ error: adminAuditEntry.error }).includes("sk-proj-secretvalue"), "admin audit error must redact OpenAI-like keys");
assert(!JSON.stringify({ error: adminAuditEntry.error }).includes("abcdefghijklmnopqrstuvwxyz012345"), "admin audit error must redact bearer tokens");
assert(isAdminAuditEventType("admin_action"), "admin audit event detector must recognize admin_action");
assert(redactAdminAuditPath("/api/admin/ingest?secret=plain-secret-value&token=another-secret") === "/api/admin/ingest", "stored admin audit paths must drop query strings");
assert(redactAdminAuditText(`failed with sk-proj-${"a".repeat(24)} and Bearer ${"b".repeat(32)}`).includes("sk-proj-") === false, "stored admin audit text must mask OpenAI-like keys");
assert(redactAdminAuditText(`Gemini key AIza${"c".repeat(32)}`).includes("Gemini key"), "stored admin audit text must preserve non-secret context");
assert(!redactAdminAuditText(`Gemini key AIza${"c".repeat(32)}`).includes(`AIza${"c".repeat(32)}`), "stored admin audit text must mask Gemini-like keys");
const redactedAuditMetadata = redactAdminAuditMetadata({
  action: "ingest-and-summarize",
  sourceKey: "de-bverfg",
  status: "completed",
  count: 3,
  apiKey: `sk-proj-${"d".repeat(24)}`,
  password: "plain-password",
  authorization: `Bearer ${"e".repeat(32)}`,
  candidateUrl: "https://example.test/source/path?secret=plain&key=value",
  nested: {
    error: `request failed with sk-ant-api03-${"f".repeat(24)}`,
    items: [
      { token: "plain-token", url: "https://example.test/next?token=secret-token" },
      `Authorization: Bearer ${"g".repeat(32)}`,
    ],
  },
  longMessage: "x".repeat(520),
});
const redactedAuditJson = JSON.stringify(redactedAuditMetadata);
assert(redactedAuditMetadata.action === "ingest-and-summarize", "admin audit redaction must preserve action");
assert(redactedAuditMetadata.sourceKey === "de-bverfg", "admin audit redaction must preserve sourceKey");
assert(redactedAuditMetadata.status === "completed", "admin audit redaction must preserve status");
assert(redactedAuditMetadata.count === 3, "admin audit redaction must preserve counts");
assert(redactedAuditMetadata.apiKey === "[redacted]", "admin audit redaction must redact apiKey values");
assert(redactedAuditMetadata.password === "[redacted]", "admin audit redaction must redact password values");
assert(redactedAuditMetadata.authorization === "[redacted]", "admin audit redaction must redact authorization values");
assert(redactedAuditMetadata.candidateUrl === "https://example.test/source/path", "admin audit redaction must strip URL queries");
assert(redactedAuditJson.includes("plain-password") === false, "admin audit redaction must remove nested secret text");
assert(redactedAuditJson.includes("plain-token") === false, "admin audit redaction must remove nested token text");
assert(redactedAuditJson.includes("secret-token") === false, "admin audit redaction must remove URL query tokens");
assert(redactedAuditJson.includes("sk-ant-api03") === false, "admin audit redaction must mask Claude-like keys");
assert(redactedAuditJson.includes("Bearer g") === false, "admin audit redaction must mask nested bearer tokens");
assert(typeof redactedAuditMetadata.longMessage === "string" && redactedAuditMetadata.longMessage.endsWith("[truncated]"), "admin audit redaction must truncate long strings");
const redactedAuditEvent = redactAdminAuditEventInput({
  eventType: "admin_action" as const,
  path: "/api/admin/ingest?secret=stored-secret",
  sourceKey: "de-bverfg",
  metadata: { action: "ingest", error: `Bearer ${"h".repeat(32)}` },
});
assert(redactedAuditEvent.path === "/api/admin/ingest", "stored admin audit event paths must be redacted before insert");
assert(JSON.stringify(redactedAuditEvent).includes("stored-secret") === false, "stored admin audit events must not retain path query secrets");
assert(JSON.stringify(redactedAuditEvent).includes("Bearer h") === false, "stored admin audit events must not retain bearer tokens");

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
assert(
  displayArticleTypeLabel({ sourceKey: "us-scotus", contentType: "opinion", sourceMetadata: null }) === "판결",
  "SCOTUS Opinion of the Court records should display as 판결",
);
assert(
  displayArticleTypeLabel({ sourceKey: "fr-conseil-constitutionnel", contentType: "opinion", sourceMetadata: null }) === "의견",
  "generic opinion labels should remain 의견",
);
assert(
  canonicalizeTerminologyText("프랑스 헌법이사회와 프랑스 헌법재판소", "fr-conseil-constitutionnel") ===
    "프랑스 헌법위원회와 프랑스 헌법위원회",
  "French Conseil constitutionnel terminology must be canonicalized",
);
assert(
  canonicalizeTerminologyText("헌법이사회는 해당 조항을 심사했다", "fr-conseil-constitutionnel") ===
    "프랑스 헌법위원회는 해당 조항을 심사했다",
  "French Conseil terminology must canonicalize standalone 헌법이사회 references",
);
assert(
  canonicalizeTerminologyText("프랑스 헌법재판소", "es-tribunal-constitucional") === "프랑스 헌법재판소",
  "French Conseil terminology canonicalization must stay source-specific",
);
assert(
  canonicalizeTerminologyValue(
    { koreanTitle: "프랑스 헌법이사회 결정", summary: { coreSummary: ["프랑스 헌법재판소 판단"] } },
    "fr-conseil-constitutionnel",
  ).summary.coreSummary[0] === "프랑스 헌법위원회 판단",
  "French Conseil terminology must be canonicalized inside nested summary JSON",
);
const manualSummaryEdit = parseManualSummaryEditInput(
  {
    note: "기관명 수정",
    summary: {
      koreanTitle: "프랑스 헌법이사회 결정",
      summary: {
        coreSummary: ["헌법이사회 판단"],
        referencedProvisions: [],
        background: "배경",
        caseStructure: "구조",
        implications: "시사점",
        practicalNotes: "참고",
      },
      entities: [],
      tags: ["헌법이사회"],
      categories: ["qpc"],
      riskFlags: [],
    },
  },
  "fr-conseil-constitutionnel",
);
assert(manualSummaryEdit.ok, "manual summary edit input should parse valid summary payloads");
if (manualSummaryEdit.ok) {
  assert(manualSummaryEdit.data.summary.koreanTitle === "프랑스 헌법위원회 결정", "manual summary edits must canonicalize source terminology");
  const manualSummaryEditDataJson = JSON.stringify(manualSummaryEdit.data);
  assert(
    !["cleaned_text", "cleanedText", "raw_text", "rawText", "original_url", "originalUrl", "canonical_url", "canonicalUrl", "content_hash", "contentHash"].some((field) =>
      manualSummaryEditDataJson.includes(field),
    ),
    "manual summary edits must not expose source snapshot fields",
  );
}
function manualSummaryEditFixture(title: string) {
  return {
    koreanTitle: title,
    summary: {
      coreSummary: ["핵심 요약"],
      referencedProvisions: [],
      background: "배경",
      caseStructure: "구조",
      implications: "시사점",
      practicalNotes: "참고",
    },
    entities: [],
    tags: ["헌법"],
    categories: ["decision"],
    riskFlags: [],
  };
}
assert(
  classifyJudicialComplaint({
    sourceKey: "de-bverfg",
    canonicalUrl: "https://www.bundesverfassungsgericht.de/example_1bvr012325.html",
    cleanedText:
      "BUNDESVERFASSUNGSGERICHT - 1 BvR 123/25 - In dem Verfahren über die Verfassungsbeschwerde gegen den Beschluss des Landgerichts Berlin wird entschieden.",
  }).matched,
  "BVerfG constitutional complaints against court decisions must be classified as judicial complaints",
);
assert(
  !classifyJudicialComplaint({
    sourceKey: "de-bverfg",
    canonicalUrl: "https://www.bundesverfassungsgericht.de/example_1bvr045625.html",
    cleanedText:
      "BUNDESVERFASSUNGSGERICHT - 1 BvR 456/25 - In dem Verfahren über die Verfassungsbeschwerde gegen das Gesetz zur Änderung des Wahlrechts.",
  }).matched,
  "BVerfG constitutional complaints directly against legislation must not be tagged as judicial complaints",
);
assert(
  !classifyJudicialComplaint({
    sourceKey: "de-bverfg",
    canonicalUrl: "https://www.bundesverfassungsgericht.de/example_1bvq000125.html",
    cleanedText:
      "BUNDESVERFASSUNGSGERICHT - 1 BvQ 1/25 - Antrag auf Erlass einer einstweiligen Anordnung gegen den Beschluss des Landgerichts Berlin.",
  }).matched,
  "standalone BVerfG interim applications must not be tagged as judicial constitutional complaints",
);
assert(
  classifyJudicialComplaint({
    sourceKey: "es-tribunal-constitucional",
    cleanedText:
      "En el recurso de amparo núm. 123-2025, promovido por doña A, respecto de las sentencias dictadas por el Juzgado de lo Penal y la Audiencia Provincial. Se ha personado el Ministerio Fiscal.",
  }).matched,
  "Spanish amparo proceedings against judicial decisions must be classified as judicial complaints",
);
assert(
  !classifyJudicialComplaint({
    sourceKey: "es-tribunal-constitucional",
    cleanedText:
      "En el recurso de amparo núm. 456-2025, promovido por diputados, contra el acuerdo de la mesa del Parlamento. Ha intervenido el Ministerio Fiscal.",
  }).matched,
  "Spanish parliamentary amparo proceedings must not be tagged as judicial complaints",
);
const judicialComplaintSummary = ensureJudicialComplaintTags(manualSummaryEditFixture("재판소원 판례"), {
  sourceKey: "es-tribunal-constitucional",
  cleanedText:
    "En el recurso de amparo núm. 789-2025, promovido por don A en pleito social, ha dictado el siguiente auto. Antecedentes",
});
assert(
  judicialComplaintSummary.tags.includes("헌법소원") && judicialComplaintSummary.tags.includes(JUDICIAL_COMPLAINT_TAG_NAME),
  "judicial complaint summaries must retain both parent and child tags",
);
const manualSummaryEditForbiddenSnakeFields = ["cleaned_text", "raw_text", "original_url", "canonical_url", "content_hash", "source_text"] as const;
for (const field of manualSummaryEditForbiddenSnakeFields) {
  const blocked = parseManualSummaryEditInput(
    {
      [field]: "원문 스냅샷 변조 시도",
      summary: manualSummaryEditFixture("프랑스 헌법이사회 결정"),
    },
    "fr-conseil-constitutionnel",
  );
  assert(!blocked.ok, `manual summary edit input must reject forbidden ${field}`);
  if (!blocked.ok) {
    assert(blocked.error.includes("원문 스냅샷 필드는 직접 수정할 수 없습니다"), `manual summary edit forbidden ${field} error must explain the boundary`);
  }
}
const manualSummaryEditForbiddenCamelFields = ["cleanedText", "rawText", "originalUrl", "canonicalUrl", "contentHash", "sourceText"] as const;
for (const field of manualSummaryEditForbiddenCamelFields) {
  const blocked = parseManualSummaryEditInput(
    {
      [field]: "source snapshot tamper",
      summary: manualSummaryEditFixture("미국 연방대법원 결정"),
    },
    "us-scotus",
  );
  assert(!blocked.ok, `manual summary edit input must reject forbidden ${field}`);
}
assert(
  canonicalizeTerminologyText(
    "Supreme Court of the United States, 미국 대법원, 미국 연방 대법원, 미 연방대법원, 미 대법원, 연방대법원",
    "us-scotus",
  ) === "미국 연방대법원, 미국 연방대법원, 미국 연방대법원, 미국 연방대법원, 미국 연방대법원, 미국 연방대법원",
  "SCOTUS terminology must be canonicalized",
);
assert(
  canonicalizeTerminologyText("미국 연방대법원", "us-scotus") === "미국 연방대법원",
  "canonical SCOTUS terminology must not be double-rewritten",
);
assert(
  canonicalizeTerminologyText("독일 연방대법원", "us-scotus") === "독일 연방대법원",
  "SCOTUS terminology canonicalization must not rewrite German federal court references",
);

const originalBverfgIngestRangeDays = process.env.BVERFG_INGEST_RANGE_DAYS;
delete process.env.BVERFG_INGEST_RANGE_DAYS;
assert(effectiveRangeDaysForSource("us-scotus", 7) === 14, "SCOTUS ingest range must be at least 14 days");
assert(effectiveRangeDaysForSource("fr-conseil-constitutionnel", 7) === 14, "France ingest range must be at least 14 days");
assert(effectiveRangeDaysForSource("us-scotus", 21) === 21, "SCOTUS ingest range must allow wider explicit ranges");
assert(effectiveRangeDaysForSource("de-bverfg", 14) === 60, "BVerfG ingest range must remain at least 60 days by default");
assert(effectiveRangeDaysForSource("es-tribunal-constitucional", 14) === 180, "Spain HJ ingest range must be at least 180 days by default");
process.env.BVERFG_INGEST_RANGE_DAYS = "45";
assert(effectiveRangeDaysForSource("de-bverfg", 14) === 45, "BVerfG env override must set the minimum ingest range");
if (originalBverfgIngestRangeDays === undefined) delete process.env.BVERFG_INGEST_RANGE_DAYS;
else process.env.BVERFG_INGEST_RANGE_DAYS = originalBverfgIngestRangeDays;

const originalSpainIngestRangeDays = process.env.SPAIN_INGEST_RANGE_DAYS;
const originalSpainRangeCapDays = process.env.SPAIN_INGEST_RANGE_DAYS_CAP;
process.env.SPAIN_INGEST_RANGE_DAYS = "210";
delete process.env.SPAIN_INGEST_RANGE_DAYS_CAP;
assert(effectiveRangeDaysForSource("es-tribunal-constitucional", 14) === 210, "Spain env range override must raise the minimum ingest range");
process.env.SPAIN_INGEST_RANGE_DAYS_CAP = "200";
assert(effectiveRangeDaysForSource("es-tribunal-constitucional", 14) === 200, "Spain ingest range cap must bound automatic widening");
if (originalSpainIngestRangeDays === undefined) delete process.env.SPAIN_INGEST_RANGE_DAYS;
else process.env.SPAIN_INGEST_RANGE_DAYS = originalSpainIngestRangeDays;
if (originalSpainRangeCapDays === undefined) delete process.env.SPAIN_INGEST_RANGE_DAYS_CAP;
else process.env.SPAIN_INGEST_RANGE_DAYS_CAP = originalSpainRangeCapDays;

function spainPayload(overrides: Record<string, unknown> = {}) {
  const longText = "Texto constitucional sobre tutela judicial efectiva, recurso de amparo y garantías procesales. ".repeat(45);
  return {
    ID: 32085,
    TIPO_RESOLUCION: "SENTENCIA",
    NUMERO_RESOLUCION: 34,
    ANNO_RESOLUCION: 2026,
    FECHA_REGISTRO: "2026-04-27T00:00:00",
    FECHA_BOE: "2026-06-05T00:00:00",
    FECHA_FIRMA: "de 27 de abril de 2026",
    NUMERO_BOE: 137,
    REFERENCIA_BOE: "BOE-A-2026-12183",
    ULTIMA_ACTUALIZACION: "2026-06-06T00:00:00",
    CONTENIDO_IRRELEVANTE_PARA_INTERNET: false,
    SINTESIS_DESCRIPTIVA: "Recurso de amparo.",
    SINTESIS_ANALITICA: "Tutela judicial efectiva.",
    RESUMEN: "Resumen auxiliar.",
    RESOLUCIONES_CABECERA: [{ COMPONENTES: "La Sala Segunda del Tribunal Constitucional.", TEXTO: "Encabezamiento del recurso." }],
    RESOLUCIONES_ANTECEDENTES: [{ NUMERO: 1, TEXTO: `${longText}${longText}` }],
    RESOLUCIONES_FUNDAMENTOS: [{ NUMERO: 1, TEXTO: `${longText}${longText}` }],
    RESOLUCIONES_DICTAMEN: [{ TITULO: "FALLO", TEXTO: `${longText}` }],
    RESOLUCIONES_PIE: [{ TEXTO: "Publíquese esta sentencia." }],
    ...overrides,
  };
}

const spainNormalRaw = buildSpainTcRawArticleFromJson(spainPayload());
const spainNormalArticle = normalizeRawArticle(spainNormalRaw, tribunalConstitucionalAdapter);
assert(normalizeSpainDecisionDate("2026-04-27T00:00:00") === "2026-04-27", "Spain HJ FECHA_REGISTRO must normalize as date-only");
assert(parseSpanishLongDate("de 27 de abril de 2026") === "2026-04-27", "Spanish FECHA_FIRMA parsing failed");
assert(spainNormalRaw.publishedAt === "2026-04-27T00:00:00.000Z", "Spain publishedAt must use FECHA_REGISTRO, not BOE");
assert(spainNormalArticle.originalPublishedAt === "2026-04-27T00:00:00.000Z", "Spain original_published_at must use FECHA_REGISTRO, not BOE");
assert(spainNormalRaw.metadata?.decisionDate === "2026-04-27", "Spain metadata must preserve decisionDate date-only");
assert(spainNormalRaw.metadata?.boePublishedAt === "2026-06-05", "Spain BOE date must be supplementary metadata");
assert(spainNormalRaw.metadata?.boeUsedForFiltering === false, "Spain BOE date must never be marked as a filter basis");
assert(spainNormalRaw.metadata?.collection?.publishable === true, "Spain normal HJ JSON with substantive text should be publishable");
assert(spainNormalRaw.metadata?.collection?.sourceTextAvailable === true, "Spain normal HJ JSON should pass strict source gate");
assert(contentTypeForResolutionType("AUTO") === "order", "Spain AUTO must map to order");
assert(contentTypeForResolutionType("DECLARACION") === "decision", "Spain DECLARACION must map to existing decision content type");

const spainAutoRaw = buildSpainTcRawArticleFromJson(spainPayload({ TIPO_RESOLUCION: "AUTO" }));
assert(spainAutoRaw.contentType === "order", "Spain AUTO JSON content type mapping failed");
const spainDeclarationRaw = buildSpainTcRawArticleFromJson(spainPayload({ TIPO_RESOLUCION: "DECLARACION" }));
assert(spainDeclarationRaw.contentType === "decision", "Spain DECLARACION JSON content type mapping failed");
assert(spainDeclarationRaw.metadata?.contentTypeMapped === "DECLARACION -> decision", "Spain DECLARACION mapping metadata missing");

const spainFallbackRaw = buildSpainTcFallbackRawArticle({
  hjId: "99999",
  title: "Sistema HJ - Resolución: SENTENCIA 1/2026",
  text: "Fallback HTML text ".repeat(300),
  decisionDate: "2026-04-27",
  fetchMethod: "html_fallback",
  jsonApiError: "JSON failed",
});
const spainFallbackArticle = normalizeRawArticle(spainFallbackRaw, tribunalConstitucionalAdapter);
assert(spainFallbackRaw.metadata?.review?.reason === "fallback_parse", "Spain HTML fallback must require review");
assert(deriveCollectionStatus(spainFallbackArticle) === "needs_review", "Spain fallback parse must stay in needs_review");
assert(spainFallbackRaw.metadata?.collection?.publishable === false, "Spain fallback parse must not be publishable");

const spainNoSubstantiveRaw = buildSpainTcRawArticleFromJson(
  spainPayload({
    RESOLUCIONES_ANTECEDENTES: [],
    RESOLUCIONES_FUNDAMENTOS: [],
    RESOLUCIONES_DICTAMEN: [],
  }),
);
const spainNoSubstantiveArticle = normalizeRawArticle(spainNoSubstantiveRaw, tribunalConstitucionalAdapter);
assert(spainNoSubstantiveRaw.metadata?.collection?.sourceTextAvailable === false, "Spain header/pie-only JSON must fail sourceTextAvailable");
assert(deriveCollectionStatus(spainNoSubstantiveArticle) === "metadata_only", "Spain header/pie-only JSON must not be summarized");

const spainIrrelevantRaw = buildSpainTcRawArticleFromJson(spainPayload({ CONTENIDO_IRRELEVANTE_PARA_INTERNET: true }));
const spainIrrelevantArticle = normalizeRawArticle(spainIrrelevantRaw, tribunalConstitucionalAdapter);
assert(spainIrrelevantRaw.metadata?.review?.reason === "contenido_irrelevante_para_internet", "Spain public suitability flag must require review");
assert(deriveCollectionStatus(spainIrrelevantArticle) === "needs_review", "Spain public suitability flag must block publish and require review");
assert(
  !canSummarizeArticle({
    status: deriveCollectionStatus(spainIrrelevantArticle),
    cleaned_text: spainIrrelevantArticle.cleanedText,
    source_metadata: spainIrrelevantArticle.metadata,
  }),
  "Spain public suitability flag must block summarization",
);

const spainDateMismatchRaw = buildSpainTcRawArticleFromJson(spainPayload({ FECHA_FIRMA: "de 25 de marzo de 2026" }));
const spainDateMismatchArticle = normalizeRawArticle(spainDateMismatchRaw, tribunalConstitucionalAdapter);
assert(spainDateMismatchRaw.metadata?.review?.reason === "date_validation_failed", "Spain date validation mismatch must require review");
assert(deriveCollectionStatus(spainDateMismatchArticle) === "needs_review", "Spain date validation mismatch must be needs_review");

const originalNodeEnv = process.env.NODE_ENV;
const originalCronSecret = process.env.CRON_SECRET;
const originalAdminUsername = process.env.ADMIN_USERNAME;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
const originalAdminSessionSecret = process.env.ADMIN_SESSION_SECRET;
const originalLlmSettingsSecret = process.env.LLM_SETTINGS_SECRET;
const originalPortalToken = process.env.WORLDCONS_PORTAL_TOKEN;
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV = "production";
delete mutableEnv.CRON_SECRET;
delete mutableEnv.ADMIN_USERNAME;
delete mutableEnv.ADMIN_PASSWORD;
delete mutableEnv.ADMIN_SESSION_SECRET;
delete mutableEnv.LLM_SETTINGS_SECRET;
delete mutableEnv.WORLDCONS_PORTAL_TOKEN;
assert(
  !isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: "Bearer undefined" } })),
  "missing production CRON_SECRET must not authorize Bearer undefined",
);
assert(!validateAdminCredentials("admin", "admin"), "development admin/admin fallback must stay disabled");
assert(!validateAdminCredentials("admin", "1234"), "legacy admin/1234 credentials must stay disabled");
mutableEnv.CRON_SECRET = "c".repeat(32);
assert(
  !isAuthorizedRequest(new Request(`https://example.test/api/admin/ingest?secret=${mutableEnv.CRON_SECRET}`)),
  "URL query secret authorization must be disabled",
);
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { authorization: `Bearer ${mutableEnv.CRON_SECRET}` } })),
  "bearer secret authorization failed",
);
assert(
  isAuthorizedRequest(new Request("https://example.test/api/admin/ingest", { headers: { "x-cron-secret": mutableEnv.CRON_SECRET } })),
  "x-cron-secret authorization failed",
);
assert(
  isAuthorizedAdminMutationRequest(new Request("https://example.test/api/admin/ingest", { method: "POST", headers: { authorization: `Bearer ${mutableEnv.CRON_SECRET}` } })),
  "server secret header should authorize admin mutations without CSRF",
);
mutableEnv.ADMIN_USERNAME = "ap570@naver.com";
mutableEnv.ADMIN_PASSWORD = "P@ssw0rd570";
mutableEnv.ADMIN_SESSION_SECRET = "s".repeat(32);
assert(validateAdminCredentials("ap570@naver.com", "P@ssw0rd570"), "configured admin credentials failed");
assert(!validateAdminCredentials("ap570@naver.com", "secret"), "CRON_SECRET must not be accepted as admin login password");
const adminSession = createAdminSession("ap570@naver.com");
const adminCsrfToken = createAdminCsrfTokenForSession(adminSession);
assert(adminCsrfToken, "admin CSRF token creation failed");
const validAdminCsrfToken = adminCsrfToken ?? "";
const adminCookie = `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(adminSession)}`;
assert(
  isAuthorizedAdminMutationRequest(
    new Request("https://example.test/api/admin/ingest", {
      method: "POST",
      headers: { cookie: adminCookie, origin: "https://example.test", "x-csrf-token": validAdminCsrfToken },
    }),
  ),
  "same-origin admin session mutation with CSRF should pass",
);
assert(
  !isAuthorizedAdminMutationRequest(
    new Request("https://example.test/api/admin/ingest", {
      method: "POST",
      headers: { cookie: adminCookie, origin: "https://example.test" },
    }),
  ),
  "admin session mutation without CSRF must be rejected",
);
assert(
  !isAuthorizedAdminMutationRequest(
    new Request("https://example.test/api/admin/ingest", {
      method: "POST",
      headers: { cookie: adminCookie, origin: "https://evil.example", "x-csrf-token": validAdminCsrfToken },
    }),
  ),
  "cross-origin admin session mutation must be rejected",
);
assert(llmSettingsEncryptionSecretSource() === null, "production LLM settings encryption must not fall back to unrelated secrets");
mutableEnv.LLM_SETTINGS_SECRET = "l".repeat(32);
assert(llmSettingsEncryptionSecretSource() === "LLM_SETTINGS_SECRET", "LLM settings encryption must use the dedicated secret");
mutableEnv.WORLDCONS_PORTAL_TOKEN = "portal-secret-value";
assert(
  portalAuthFailureStatus(new Request("https://example.test/api/portal/latest")) === 401,
  "portal latest API must reject missing tokens with 401",
);
assert(
  portalAuthFailureStatus(new Request("https://example.test/api/portal/latest", { headers: { [WORLDLAWS_PORTAL_TOKEN_HEADER]: "wrong" } })) === 403,
  "portal latest API must reject wrong tokens with 403",
);
assert(
  portalAuthFailureStatus(
    new Request("https://example.test/api/portal/latest", { headers: { [WORLDLAWS_PORTAL_TOKEN_HEADER]: mutableEnv.WORLDCONS_PORTAL_TOKEN } }),
  ) === null,
  "portal latest API must accept the shared worldlaws token header",
);
const validProductionEnv = {
  NODE_ENV: "production",
  ADMIN_PASSWORD: "admin6",
  ADMIN_SESSION_SECRET: "b".repeat(32),
  CRON_SECRET: "c".repeat(32),
  LLM_SETTINGS_SECRET: "d".repeat(32),
  SUPABASE_SERVICE_ROLE_KEY: "e".repeat(32),
};
assert(validateProductionSecurityConfig(validProductionEnv).ok, "valid production security config should pass");
assert(!validateProductionSecurityConfig({ ...validProductionEnv, ADMIN_PASSWORD: "short" }).ok, "short admin passwords must fail");
assert(!validateProductionSecurityConfig({ ...validProductionEnv, CRON_SECRET: "short" }).ok, "short production secrets must fail");
assert(
  !validateProductionSecurityConfig({ ...validProductionEnv, LLM_SETTINGS_SECRET: validProductionEnv.CRON_SECRET }).ok,
  "production secrets must not reuse values",
);
assert(
  !validateProductionSecurityConfig({ ...validProductionEnv, NEXT_PUBLIC_CRON_SECRET: validProductionEnv.CRON_SECRET }).ok,
  "NEXT_PUBLIC server secret exposure must fail",
);
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
if (originalLlmSettingsSecret === undefined) delete mutableEnv.LLM_SETTINGS_SECRET;
else mutableEnv.LLM_SETTINGS_SECRET = originalLlmSettingsSecret;
if (originalPortalToken === undefined) delete mutableEnv.WORLDCONS_PORTAL_TOKEN;
else mutableEnv.WORLDCONS_PORTAL_TOKEN = originalPortalToken;
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

assert(!supportsOpenAiTemperature("gpt-5.5"), "GPT-5.x chat requests must omit non-default temperature");
assert(!supportsOpenAiTemperature("gpt-5.4"), "GPT-5.x chat requests must omit non-default temperature");
assert(!supportsOpenAiTemperature("o3-mini"), "OpenAI reasoning chat requests must omit non-default temperature");
assert(supportsOpenAiTemperature("gpt-4.1-mini"), "GPT-4.1 chat requests should keep configured temperature");

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

const fairSummaryCandidates = orderSummaryCandidatesRoundRobin([
  { id: "de-2", source_key: "de-bverfg", created_at: "2026-07-10T00:04:00Z" },
  { id: "fr-2", source_key: "fr-conseil-constitutionnel", created_at: "2026-07-10T00:05:00Z" },
  { id: "de-1", source_key: "de-bverfg", created_at: "2026-07-10T00:00:00Z" },
  { id: "us-1", source_key: "us-scotus", created_at: "2026-07-10T00:02:00Z" },
  { id: "fr-1", source_key: "fr-conseil-constitutionnel", created_at: "2026-07-10T00:01:00Z" },
]);
assert(
  fairSummaryCandidates.map((candidate) => candidate.id).join(",") === "de-1,fr-1,us-1,de-2,fr-2",
  "summary candidates must be processed in a deterministic per-source round robin",
);
assert(summaryRetryDelayMs("Please retry in 3.2s.", 0, 65_000) === 65_000, "summary retry must outlast the router cooldown");
assert(summaryRetryDelayMs("Please retry after 120 seconds.", 0, 65_000) === 122_000, "provider Retry-After must override the default delay");
assert(isGlobalSummaryBackoff("All Gemini routes failed with 429 quota errors"), "Gemini quota errors must pause the batch");
assert(!isGlobalSummaryBackoff("One model timed out while parsing this article"), "article-local timeouts must not pause every source");
assert(summaryBatchWasDeferred({ deferredCount: 1 }), "deferred summary work must be detected");
assert(summaryBatchNeedsFollowUp({ limitReached: true }), "a full summary batch must trigger another drain pass");
assert(
  !summaryBatchHasHardFailure({ mode: "database", failedCount: 1, deferredCount: 1 }),
  "retryable deferred work must not be classified as a hard failure",
);
assert(
  summaryBatchHasHardFailure({ mode: "database", failedCount: 1, deferredCount: 0 }),
  "non-retryable summary failures must be visible to automation",
);

const scheduledSummaryWorkflowSource = fs.readFileSync(path.join(process.cwd(), ".github/workflows/crawlee-worker.yml"), "utf8");
for (const requiredFlag of ["--drain", "--strict", "--max-passes=4", "--pass-delay-ms=300000", "--retry-attempts=1", "--retry-delay-ms=65000"]) {
  assert(scheduledSummaryWorkflowSource.includes(requiredFlag), `scheduled summary workflow must include ${requiredFlag}`);
}
for (const requiredCacheRevalidationText of [
  "Revalidate production public caches",
  "secrets.CRON_SECRET",
  "Authorization: Bearer $CRON_SECRET",
  "/api/admin/public-content/revalidate",
]) {
  assert(
    scheduledSummaryWorkflowSource.includes(requiredCacheRevalidationText),
    `scheduled summary workflow must include ${requiredCacheRevalidationText}`,
  );
}
const publicContentCacheSource = fs.readFileSync(path.join(process.cwd(), "lib/public-content-cache.ts"), "utf8");
for (const requiredCacheHelperText of [
  "PUBLIC_ARTICLES_CACHE_TAG",
  "PUBLIC_ARTICLE_COUNTS_CACHE_TAG",
  "PUBLIC_TAGS_CACHE_TAG",
  "PUBLIC_PORTAL_CACHE_TAG",
  "revalidateTag(tag)",
  'revalidatePath("/articles/[slug]", "page")',
]) {
  assert(publicContentCacheSource.includes(requiredCacheHelperText), `public cache helper must include ${requiredCacheHelperText}`);
}
assert(publicContentCacheSource.includes('revalidatePath("/v2/articles/[slug]", "page")'), "v2 article pages must be invalidated after public mutations");
const vercelConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { regions?: string[] };
assert(vercelConfig.regions?.length === 1 && vercelConfig.regions[0] === "icn1", "Vercel functions must run in the Seoul region");
const articleDetailPageSource = fs.readFileSync(path.join(process.cwd(), "app/articles/[slug]/(detail)/page.tsx"), "utf8");
assert(articleDetailPageSource.includes("getCachedArticleDetailPageData"), "article detail and metadata must share the persistent detail cache");
assert(!articleDetailPageSource.includes("searchParams"), "article detail server rendering must not vary by returnTo search params");
assert(articleDetailPageSource.includes('dynamic = "force-static"') && articleDetailPageSource.includes("generateStaticParams"), "article detail HTML must use on-demand ISR");
const articleDetailCacheSource = fs.readFileSync(path.join(process.cwd(), "lib/public-article-detail-cache.ts"), "utf8");
assert(articleDetailCacheSource.includes("unstable_cache") && articleDetailCacheSource.includes("PUBLIC_ARTICLES_CACHE_TAG"), "article detail cache must be tag invalidated");
const detailNavigationSource = fs.readFileSync(path.join(process.cwd(), "components/article-detail-navigation.tsx"), "utf8");
assert(detailNavigationSource.includes("window.location.hash") && detailNavigationSource.includes("safeArticleReturnPath"), "returnTo must be resolved safely from a client-only fragment");
const intentPrefetchSource = fs.readFileSync(path.join(process.cwd(), "components/intent-prefetch-link.tsx"), "utf8");
for (const intentEvent of ["onFocus", "onMouseEnter", "onTouchStart"]) {
  assert(intentPrefetchSource.includes(intentEvent), `intent prefetch links must handle ${intentEvent}`);
}
const layoutSource = fs.readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");
assert(layoutSource.includes("nanum-gothic-regular.woff2"), "the public UI must use the Nanum Gothic regular font");
assert(!layoutSource.includes("nanum-square-neo") && !layoutSource.includes("nanum-gothic-bold"), "the initial font payload must include only Nanum Gothic regular");
for (const cacheConsumer of [
  "app/page.tsx",
  "app/list/page.tsx",
  "app/api/articles/route.ts",
  "app/api/home/range/route.ts",
  "app/api/articles/[slug]/route.ts",
  "app/api/articles/[slug]/source-text/route.ts",
  "app/api/portal/latest/route.ts",
  "app/api/portal/latest-by-country/route.ts",
]) {
  const source = fs.readFileSync(path.join(process.cwd(), cacheConsumer), "utf8");
  assert(source.includes("@/lib/public-content-cache"), `${cacheConsumer} must use public cache tags`);
}
const summarizePendingScriptSource = fs.readFileSync(path.join(process.cwd(), "scripts/summarize-pending.ts"), "utf8");
assert(summarizePendingScriptSource.includes('event: "summary_batch_pass"'), "summary CLI must log each drain pass");
assert(summarizePendingScriptSource.includes("process.exitCode = 1"), "strict summary CLI must fail visibly when work remains incomplete");
const summaryRunnerSource = fs.readFileSync(path.join(process.cwd(), "lib/ingest/summary.ts"), "utf8");
assert(summaryRunnerSource.includes("orderSummaryCandidatesRoundRobin"), "summary runner must use fair source ordering");
assert(summaryRunnerSource.includes("summaryRetryDelayMs"), "summary runner must honor bounded retry delays");
assert(summaryRunnerSource.includes('.contains("source_metadata", { collection: { publishable: true } })'), "summary query must exclude non-publishable review rows");

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

const normalizedOpenAiSummary = SummarySchema.parse(
  normalizeSummaryCandidate({
    koreanTitle: "침묵권 고지 관련\nQPC 결정",
    summary: {
      coreSummary: "문제 된 조항은 침묵권 고지 규정이 없다는 이유만으로\n위헌이라고 볼 수 없다고 판단했다.",
      referencedProvisions: [
        {
          jurisdiction: "",
          lawName: "",
          article: "",
          description: "무죄추정에서 자기부죄거부 원칙 및 진술거부권이 도출된다고 판시됨.",
          confidence: "low",
        },
        {
          jurisdiction: "France",
          lawName: "Code de la consommation",
          article: "Article L.522-5",
          description: "행정제재 전 의견 제출 요청 절차가 심판대상이 됨.",
          confidence: "medium",
        },
      ],
      background: "배경",
      caseStructure: "구조",
      implications: "시사점",
      practicalNotes: "참고",
    },
    entities: [
      { name: "Conseil constitutionnel", type: "기관" },
      { name: "소비자법", type: "법령" },
      { name: "Corsica Ferries", type: "회사" },
    ],
    tags: "QPC",
    categories: ["decision"],
    riskFlags: ["원문은 실체적 배경을 제한적으로만 설명한다."],
  }),
);
assert(normalizedOpenAiSummary.koreanTitle === "침묵권 고지 관련 QPC 결정", "summary title whitespace must normalize to one line");
assert(Array.isArray(normalizedOpenAiSummary.summary.coreSummary), "summary coreSummary string must be normalized to array");
assert(!normalizedOpenAiSummary.summary.coreSummary[0].includes("\n"), "summary coreSummary items must normalize to one line");
assert(normalizedOpenAiSummary.summary.referencedProvisions.length === 1, "description-only referenced provisions must be dropped");
assert(normalizedOpenAiSummary.summary.referencedProvisions[0].article === "Article L.522-5", "valid referenced provisions must be retained");
assert(normalizedOpenAiSummary.entities[0].type === "institution", "Korean entity type labels must normalize to enum values");
assert(normalizedOpenAiSummary.entities[0].normalizedName === "Conseil constitutionnel", "missing normalizedName must default to name");
assert(normalizedOpenAiSummary.riskFlags.includes("source_text_incomplete"), "risk flag notes must normalize to known risk flags");

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

async function assertAdminRouteSecurityControls() {
  const keysToRestore = ["NODE_ENV", "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "CRON_SECRET", "LLM_SETTINGS_SECRET"] as const;
  const originalEnv = new Map(keysToRestore.map((key) => [key, process.env[key]]));
  const mutableEnv = process.env as Record<string, string | undefined>;

  try {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.ADMIN_USERNAME = "ap570@naver.com";
    mutableEnv.ADMIN_PASSWORD = "p".repeat(32);
    mutableEnv.ADMIN_SESSION_SECRET = "s".repeat(32);
    mutableEnv.CRON_SECRET = "c".repeat(32);
    mutableEnv.LLM_SETTINGS_SECRET = "l".repeat(32);

    const { GET: logoutGet } = await import("@/app/api/admin/logout/route");
    const logoutGetResponse = await logoutGet();
    assert(logoutGetResponse.status === 405, "GET /api/admin/logout must be rejected with 405");
    assert(logoutGetResponse.headers.get("allow") === "POST", "GET /api/admin/logout must advertise POST as the allowed method");

    const { GET: cacheRevalidateGet, POST: cacheRevalidatePost } = await import("@/app/api/admin/public-content/revalidate/route");
    const cacheRevalidateGetResponse = cacheRevalidateGet();
    assert(cacheRevalidateGetResponse.status === 405, "GET /api/admin/public-content/revalidate must be rejected with 405");
    assert(cacheRevalidateGetResponse.headers.get("allow") === "POST", "cache revalidation GET must advertise POST as the allowed method");
    const unauthenticatedCacheRevalidateResponse = await cacheRevalidatePost(
      new Request("https://example.test/api/admin/public-content/revalidate", { method: "POST" }),
    );
    assert(unauthenticatedCacheRevalidateResponse.status === 401, "cache revalidation POST without authentication must return 401");
    const wrongSecretCacheRevalidateResponse = await cacheRevalidatePost(
      new Request("https://example.test/api/admin/public-content/revalidate", {
        method: "POST",
        headers: { "x-cron-secret": "x".repeat(32) },
      }),
    );
    assert(wrongSecretCacheRevalidateResponse.status === 401, "cache revalidation POST with a wrong secret must return 401");
    const querySecretCacheRevalidateResponse = await cacheRevalidatePost(
      new Request(`https://example.test/api/admin/public-content/revalidate?secret=${"c".repeat(32)}`, { method: "POST" }),
    );
    assert(querySecretCacheRevalidateResponse.status === 401, "cache revalidation POST must reject query string secrets");

    const session = createAdminSession("ap570@naver.com");
    const cookie = `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session)}`;
    const csrfToken = createAdminCsrfTokenForSession(session);
    assert(csrfToken, "route security CSRF token creation failed");

    const { GET: cronGet } = await import("@/app/api/admin/cron/ingest/route");
    const cronCookieOnlyResponse = await cronGet(
      new Request("https://example.test/api/admin/cron/ingest", {
        method: "GET",
        headers: { cookie },
      }),
    );
    assert(cronCookieOnlyResponse.status === 401, "cron ingest GET must require a secret header, not only an admin cookie");

    const { GET: adminJobsCronGet } = await import("@/app/api/admin/cron/jobs/route");
    const adminJobsCronCookieOnlyResponse = await adminJobsCronGet(
      new Request("https://example.test/api/admin/cron/jobs", {
        method: "GET",
        headers: { cookie },
      }),
    );
    assert(adminJobsCronCookieOnlyResponse.status === 401, "admin jobs cron GET must require a secret header, not only an admin cookie");
    const adminJobsCronQuerySecretResponse = await adminJobsCronGet(
      new Request(`https://example.test/api/admin/cron/jobs?secret=${"c".repeat(32)}`, {
        method: "GET",
      }),
    );
    assert(adminJobsCronQuerySecretResponse.status === 401, "admin jobs cron GET must reject query string secrets");

    const { POST: ingestPost } = await import("@/app/api/admin/ingest/route");
    const unauthenticatedIngestResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert(unauthenticatedIngestResponse.status === 401, "admin POST without authentication must return 401");

    const invalidIngestActionResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ action: "delete-everything" }),
      }),
    );
    assert(invalidIngestActionResponse.status === 400, "admin ingest POST must reject invalid actions before work starts");

    const { PATCH: candidatesPatch } = await import("@/app/api/admin/candidates/route");
    const unauthenticatedCandidateMutationResponse = await candidatesPatch(
      new Request("https://example.test/api/admin/candidates", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId: "00000000-0000-0000-0000-000000000000", action: "ignore" }),
      }),
    );
    assert(unauthenticatedCandidateMutationResponse.status === 401, "admin candidate mutation without authentication must return 401");

    const invalidCandidateActionResponse = await candidatesPatch(
      new Request("https://example.test/api/admin/candidates", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ candidateId: "00000000-0000-0000-0000-000000000000", action: "delete" }),
      }),
    );
    assert(invalidCandidateActionResponse.status === 400, "admin candidate mutation with invalid action must return 400");

    const invalidCandidateStatusResponse = await candidatesPatch(
      new Request("https://example.test/api/admin/candidates", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ candidateId: "00000000-0000-0000-0000-000000000000", status: "deleted" }),
      }),
    );
    assert(invalidCandidateStatusResponse.status === 400, "admin candidate mutation with invalid status must return 400");

    const oversizedCandidateIdResponse = await candidatesPatch(
      new Request("https://example.test/api/admin/candidates", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ candidateId: "x".repeat(121), action: "retrying" }),
      }),
    );
    assert(oversizedCandidateIdResponse.status === 400, "admin candidate mutation must reject oversized candidate ids before DB access");

    const missingCsrfResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test" },
        body: "{}",
      }),
    );
    assert(missingCsrfResponse.status === 403, "admin POST without CSRF must return 403");

    const crossOriginResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://evil.example", "x-csrf-token": csrfToken ?? "" },
        body: "{}",
      }),
    );
    assert(crossOriginResponse.status === 403, "cross-origin admin POST must return 403");

    const oversizedIngestRefResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ sourceKey: "x".repeat(241) }),
      }),
    );
    assert(oversizedIngestRefResponse.status === 400, "admin ingest POST must reject oversized sourceKey before work starts");

    const oversizedIngestArticleIdResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ action: "retry-summary", articleId: "x".repeat(241) }),
      }),
    );
    assert(oversizedIngestArticleIdResponse.status === 400, "admin ingest POST must reject oversized articleId before work starts");

    const oversizedIngestSlugResponse = await ingestPost(
      new Request("https://example.test/api/admin/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ action: "retry-summary", slug: "x".repeat(241) }),
      }),
    );
    assert(oversizedIngestSlugResponse.status === 400, "admin ingest POST must reject oversized slug before work starts");

    const adminIngestRouteSource = fs.readFileSync(path.join(process.cwd(), "app/api/admin/ingest/route.ts"), "utf8");
    const adminIngestExecutorSource = fs.readFileSync(path.join(process.cwd(), "lib/admin/admin-ingest-jobs.ts"), "utf8");
    assert(
      /runSummarizePending\(\{\s*limit:\s*summarizeLimit,\s*sourceKey\s*\}\)/s.test(adminIngestExecutorSource),
      "admin source-scoped summarize request must pass sourceKey to runSummarizePending",
    );
    assert(adminIngestRouteSource.includes("createAdminJob"), "admin ingest route must enqueue admin jobs");
    assert(adminIngestRouteSource.includes("buildAdminJobIdempotencyKey"), "admin ingest route must build stable job idempotency keys");
    assert(adminIngestRouteSource.includes("executeAdminIngestJobContext"), "admin ingest route inline fallback must use the shared executor");
    assert(adminIngestRouteSource.includes('mode: "queued"'), "admin ingest route must return queued mode for queued jobs");
    assert(adminIngestRouteSource.includes("{ status: 202 }"), "admin ingest route must return 202 for queued jobs");
    assert(adminIngestRouteSource.includes("canRunInlineFallback"), "admin ingest route must keep inline execution as an explicit fallback only");
    assert(adminIngestRouteSource.includes('process.env.NODE_ENV !== "production"'), "admin ingest route must not default production to inline fallback");
    assert(adminIngestExecutorSource.includes("compactAdminIngestExecutionSummary"), "admin ingest executor must produce compact job summaries");
    assert(adminIngestExecutorSource.includes("redactAdminAuditMetadata"), "admin ingest executor summaries must use audit redaction");
    assert(adminIngestExecutorSource.includes("summaryBatchWasDeferred"), "admin ingest jobs must not mark deferred summary work as succeeded");
    assert(adminIngestExecutorSource.includes("summaryBatchHasHardFailure"), "admin ingest jobs must surface hard summary failures");
    assert(adminIngestExecutorSource.includes("invalidatePublicContentCaches"), "admin ingest jobs must invalidate public caches after mutations");
    for (const publicMutationRoute of [
      "app/api/admin/review/route.ts",
      "app/api/admin/articles/[articleRef]/summary/route.ts",
      "app/api/admin/articles/bulk/route.ts",
      "app/api/admin/cron/ingest/route.ts",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), publicMutationRoute), "utf8");
      assert(source.includes("invalidatePublicContentCaches"), `${publicMutationRoute} must invalidate public caches after mutations`);
    }
    const cacheRevalidationRouteSource = fs.readFileSync(path.join(process.cwd(), "app/api/admin/public-content/revalidate/route.ts"), "utf8");
    assert(cacheRevalidationRouteSource.includes("adminMutationAuthFailureStatus"), "cache revalidation route must use admin mutation auth");
    assert(cacheRevalidationRouteSource.includes("invalidatePublicContentCaches"), "cache revalidation route must invalidate public caches");
    assert(!cacheRevalidationRouteSource.includes("searchParams"), "cache revalidation route must not accept query string secrets");
    for (const forbiddenSnapshotField of ["raw_text", "cleaned_text", "source_text", "rawText", "cleanedText", "sourceText"]) {
      assert(!adminIngestExecutorSource.includes(forbiddenSnapshotField), `admin ingest executor result summary must not store ${forbiddenSnapshotField}`);
    }

    const adminPageSource = fs.readFileSync(path.join(process.cwd(), "app/admin/page.tsx"), "utf8");
    const adminOverviewSource = fs.readFileSync(path.join(process.cwd(), "components/admin-operations-overview.tsx"), "utf8");
    const adminShellSource = fs.readFileSync(path.join(process.cwd(), "components/admin-shell.tsx"), "utf8");
    assert(adminPageSource.includes("AdminOperationsOverview"), "admin dashboard must render the redesigned operations overview");
    assert(!adminPageSource.includes("AdminTabs"), "admin dashboard must not retain the old tab strip");
    assert(!fs.existsSync(path.join(process.cwd(), "components/admin-tabs.tsx")), "old admin tabs component must be removed");
    assert(!adminShellSource.includes("/admin/operations") && !adminShellSource.includes("/admin/jobs"), "new shell must not link retired admin screens");
    const ingestionStatusPanelSource = fs.readFileSync(path.join(process.cwd(), "components/ingestion-status-panel.tsx"), "utf8");
    assert(adminOverviewSource.includes("/admin/work?"), "redesigned overview must link operational signals to the unified queue");
    assert(ingestionStatusPanelSource.includes("/admin/articles?sourceKey="), "ingestion runs must link source rows to filtered article management");
    assert(ingestionStatusPanelSource.includes("/admin/candidates?source="), "ingestion runs must link source rows to URL candidates");
    assert(ingestionStatusPanelSource.includes("/admin/audit?q="), "ingestion runs must link source rows to audit logs");

    const adminAnalyticsPageSource = fs.readFileSync(path.join(process.cwd(), "app/admin/analytics/page.tsx"), "utf8");
    assert(!/item\.clientIp(?!Hash)/.test(adminAnalyticsPageSource), "admin analytics page must not render raw item.clientIp");
    assert(!/item\.userAgent(?!Family)/.test(adminAnalyticsPageSource), "admin analytics page must not render raw item.userAgent");
    assert(adminAnalyticsPageSource.includes("item.clientIpHash"), "admin analytics page must keep hash-based client identifiers");
    assert(adminAnalyticsPageSource.includes("item.userAgentFamily"), "admin analytics page must keep browser family summary");
    assert(adminAnalyticsPageSource.includes("item.deviceType"), "admin analytics page must keep device type summary");
    assert(adminAnalyticsPageSource.includes("접속 식별"), "admin analytics page must label IP-derived values as client identifiers");
    assert(adminAnalyticsPageSource.includes("환경 요약"), "admin analytics page must label user-agent-derived values as a summary");

    const analyticsDataSource = fs.readFileSync(path.join(process.cwd(), "lib/db/analytics.ts"), "utf8");
    assert(!/event\.client_ip\b/.test(analyticsDataSource), "admin analytics dimensions must not aggregate raw client IP values");
    assert(!/event\.user_agent\b/.test(analyticsDataSource), "admin analytics access logs must not expose raw user-agent values");

    const adminOperationsPageSource = fs.readFileSync(path.join(process.cwd(), "app/admin/operations/page.tsx"), "utf8");
    assert(adminOperationsPageSource.includes('permanentRedirect("/admin")'), "retired operations screen must redirect to the redesigned overview");

    const adminDashboardSummaryMigration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql"),
      "utf8",
    );
    for (const dbObject of [
      "admin_article_status_summary_v",
      "admin_source_health_v",
      "admin_candidate_summary_v",
      "admin_attention_articles_v",
      "rpc_admin_dashboard_snapshot",
      "rpc_admin_analytics_health_snapshot",
    ]) {
      assert(adminDashboardSummaryMigration.includes(dbObject), `admin dashboard summary migration must define ${dbObject}`);
    }

    const adminQueriesSource = fs.readFileSync(path.join(process.cwd(), "lib/db/admin-queries.ts"), "utf8");
    assert(adminQueriesSource.includes('rpc("rpc_admin_dashboard_snapshot")'), "admin dashboard queries must try the summary snapshot RPC");
    assert(adminQueriesSource.includes("loadAdminDashboardLegacyData"), "admin dashboard queries must keep the legacy fallback path");
    assert(
      adminQueriesSource.includes("const snapshot = await loadAdminDashboardSnapshot()")
        && adminQueriesSource.includes("const legacy = await loadAdminDashboardLegacyData()"),
      "admin dashboard queries must fallback when the snapshot is unavailable",
    );

    const analyticsQueriesSource = fs.readFileSync(path.join(process.cwd(), "lib/db/analytics.ts"), "utf8");
    assert(analyticsQueriesSource.includes('rpc("rpc_admin_analytics_health_snapshot"'), "analytics queries must try the health snapshot RPC");
    assert(analyticsQueriesSource.includes("loadAnalyticsHealthData"), "analytics queries must keep a callable health helper with fallback");
    assert(analyticsQueriesSource.includes("loadIngestionRunRows(days)") && analyticsQueriesSource.includes("loadArticleSummaryRows()"), "analytics health fallback must keep legacy collection/model reads");

    const adminAuditHistoryMigration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260709130000_admin_audit_and_edit_history.sql"),
      "utf8",
    );
    for (const requiredSql of [
      "create table if not exists admin_audit_logs",
      "create table if not exists admin_article_edit_history",
      "admin_audit_logs_occurred_at_idx",
      "admin_audit_logs_action_occurred_at_idx",
      "admin_audit_logs_target_idx",
      "admin_audit_logs_job_id_idx",
      "admin_article_edit_history_article_id_edited_at_idx",
      "admin_article_edit_history_article_slug_edited_at_idx",
    ]) {
      assert(adminAuditHistoryMigration.includes(requiredSql), `admin audit history migration must include ${requiredSql}`);
    }

    const analyticsEventsSource = fs.readFileSync(path.join(process.cwd(), "lib/analytics/events.ts"), "utf8");
    assert(analyticsEventsSource.includes("recordAdminAuditLog"), "recordAdminSiteEvent must dual-write to admin_audit_logs");

    const manualSummaryEditSource = fs.readFileSync(path.join(process.cwd(), "lib/ingest/manual-summary-edit.ts"), "utf8");
    assert(manualSummaryEditSource.includes("recordAdminArticleEditHistory"), "manual summary edit success path must record edit history");

    const adminAuditHelperSource = fs.readFileSync(path.join(process.cwd(), "lib/db/admin-audit.ts"), "utf8");
    assert(adminAuditHelperSource.includes("redacted_metadata") || adminAuditHelperSource.includes("redactedMetadata"), "admin audit helper must write redacted metadata");
    assert(adminAuditHelperSource.includes("previous_summary_hash") && adminAuditHelperSource.includes("next_summary_hash"), "edit history helper must store summary hashes");
    assert(!adminAuditHelperSource.includes("raw_text") && !adminAuditHelperSource.includes("cleaned_text"), "edit history helper must not include source snapshot fields in diffs");

    const adminArticleTriageMigration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260709140000_admin_article_triage_columns.sql"),
      "utf8",
    );
    for (const requiredSql of [
      "alter table articles add column if not exists error_class text",
      "alter table articles add column if not exists error_context jsonb",
      "alter table articles add column if not exists review_state text",
      "articles_error_class_updated_at_idx",
      "articles_review_state_updated_at_idx",
      "articles_source_key_review_state_updated_at_idx",
      "create or replace view admin_source_health_v",
      "create or replace view admin_attention_articles_v",
    ]) {
      assert(adminArticleTriageMigration.includes(requiredSql), `admin article triage migration must include ${requiredSql}`);
    }

    const articleTriageSource = fs.readFileSync(path.join(process.cwd(), "lib/db/article-triage.ts"), "utf8");
    assert(articleTriageSource.includes("ARTICLE_ERROR_CLASSES"), "article triage helper must expose error_class taxonomy");
    for (const errorClass of [
      "crawl.robots_disallowed",
      "crawl.timeout_response",
      "crawl.blocked_403",
      "extract.empty_text",
      "summary.model_error",
      "summary.retryable_quota",
      "llm.key_missing",
      "auth.csrf_failed",
      "db.query_failed",
      "job.stale_running",
    ]) {
      assert(articleTriageSource.includes(errorClass), `article triage taxonomy must include ${errorClass}`);
    }

    const articleTypesSource = fs.readFileSync(path.join(process.cwd(), "lib/db/types.ts"), "utf8");
    const articleStatusBlock = articleTypesSource.match(/export type ArticleStatus =([\s\S]*?);/);
    assert(Boolean(articleStatusBlock), "ArticleStatus type must exist");
    const articleStatusValues = [...(articleStatusBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert(
      JSON.stringify(articleStatusValues) ===
        JSON.stringify([
          "discovered",
          "metadata_only",
          "robots_disallowed",
          "blocked",
          "timeout",
          "fetched",
          "cleaned",
          "summarizing",
          "summarized",
          "failed_fetch",
          "failed_summary",
          "needs_review",
        ]),
      "ArticleStatus must not gain new triage states",
    );

    const responsiveAdminFiles = [
      ["admin articles table", "components/admin-articles-table.tsx"],
      ["admin candidates page", "app/admin/candidates/page.tsx"],
      ["admin audit page", "app/admin/audit/page.tsx"],
      ["ingestion status panel", "components/ingestion-status-panel.tsx"],
    ] as const;
    for (const [label, relativePath] of responsiveAdminFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
      assert(source.includes("md:hidden"), `${label} must include a mobile card branch`);
      assert(source.includes("<table"), `${label} must keep the desktop table`);
      assert(source.includes("hidden overflow-x-auto md:block") || source.includes("hidden md:block"), `${label} must hide the desktop table on narrow screens`);
    }

    const { POST: articlesBulkPost } = await import("@/app/api/admin/articles/bulk/route");
    const unauthenticatedBulkResponse = await articlesBulkPost(
      new Request("https://example.test/api/admin/articles/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-needs-review", slugs: ["sample"] }),
      }),
    );
    assert(unauthenticatedBulkResponse.status === 401, "admin article bulk POST without authentication must return 401");

    const oversizedBulkResponse = await articlesBulkPost(
      new Request("https://example.test/api/admin/articles/bulk", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({
          action: "mark-needs-review",
          slugs: Array.from({ length: 101 }, (_, index) => `article-${index}`),
        }),
      }),
    );
    assert(oversizedBulkResponse.status === 400, "admin article bulk POST must reject more than 100 explicit articles");

    const invalidBulkActionResponse = await articlesBulkPost(
      new Request("https://example.test/api/admin/articles/bulk", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "publish-all-filter-results", slugs: ["sample"] }),
      }),
    );
    assert(invalidBulkActionResponse.status === 400, "admin article bulk POST must reject unsupported actions");

    const oversizedBulkNoteResponse = await articlesBulkPost(
      new Request("https://example.test/api/admin/articles/bulk", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "mark-needs-review", slugs: ["sample"], note: "n".repeat(1001) }),
      }),
    );
    assert(oversizedBulkNoteResponse.status === 400, "admin article bulk POST must reject oversized notes");

    const unconfirmedBulkClosePrivateResponse = await articlesBulkPost(
      new Request("https://example.test/api/admin/articles/bulk", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "close-private", slugs: ["sample"] }),
      }),
    );
    assert(unconfirmedBulkClosePrivateResponse.status === 400, "admin article bulk POST must require explicit confirmation for close-private");

    const { POST: reviewPost } = await import("@/app/api/admin/review/route");
    const invalidReviewActionResponse = await reviewPost(
      new Request("https://example.test/api/admin/review", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "delete", slug: "sample" }),
      }),
    );
    assert(invalidReviewActionResponse.status === 400, "admin review POST must reject invalid actions");

    const unconfirmedReviewClosePrivateResponse = await reviewPost(
      new Request("https://example.test/api/admin/review", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "close-private", slug: "sample" }),
      }),
    );
    assert(unconfirmedReviewClosePrivateResponse.status === 400, "admin review POST must require explicit confirmation for close-private");

    const oversizedReviewModelResponse = await reviewPost(
      new Request("https://example.test/api/admin/review", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://example.test", "x-csrf-token": csrfToken ?? "" },
        body: JSON.stringify({ action: "resummarize-with-model", slug: "sample", model: "m".repeat(121) }),
      }),
    );
    assert(oversizedReviewModelResponse.status === 400, "admin review POST must reject oversized model names");

    const { POST: llmSettingsPost } = await import("@/app/api/admin/llm-settings/route");
    const invalidLlmProviderResponse = await llmSettingsPost(
      new Request("https://example.test/api/admin/llm-settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ summary: { provider: "bad-provider", model: "gpt-4.1-mini" } }),
      }),
    );
    assert(invalidLlmProviderResponse.status === 400, "admin LLM settings POST must reject invalid providers before storage access");

    const invalidLlmModelResponse = await llmSettingsPost(
      new Request("https://example.test/api/admin/llm-settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ summary: { provider: "gemini", model: "m".repeat(161) } }),
      }),
    );
    assert(invalidLlmModelResponse.status === 400, "admin LLM settings POST must reject oversized model names before storage access");

    const invalidLlmBaseUrlResponse = await llmSettingsPost(
      new Request("https://example.test/api/admin/llm-settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ providers: { "openai-compatible": { baseUrl: "ftp://example.test/v1" } } }),
      }),
    );
    assert(invalidLlmBaseUrlResponse.status === 400, "admin LLM settings POST must reject invalid baseUrl values before storage access");

    const invalidLlmKeyPayloadResponse = await llmSettingsPost(
      new Request("https://example.test/api/admin/llm-settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ providers: { openai: { keys: [{ label: "primary", value: "k".repeat(20_001) }] } } }),
      }),
    );
    assert(invalidLlmKeyPayloadResponse.status === 400, "admin LLM settings POST must reject oversized key payloads before storage access");

    const { POST: llmSettingsTestPost } = await import("@/app/api/admin/llm-settings/test/route");
    const unauthenticatedLlmTestResponse = await llmSettingsTestPost(
      new Request("https://example.test/api/admin/llm-settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "gemini", model: "gemini-3.1-flash-lite" }),
      }),
    );
    assert(unauthenticatedLlmTestResponse.status === 401, "admin LLM test POST without authentication must return 401");

    const invalidLlmTestProviderResponse = await llmSettingsTestPost(
      new Request("https://example.test/api/admin/llm-settings/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ provider: "bad-provider", model: "gpt-4.1-mini" }),
      }),
    );
    assert(invalidLlmTestProviderResponse.status === 400, "admin LLM test POST must reject invalid providers before LLM calls");

    const invalidLlmTestModelResponse = await llmSettingsTestPost(
      new Request("https://example.test/api/admin/llm-settings/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ provider: "openai", model: "m".repeat(161) }),
      }),
    );
    assert(invalidLlmTestModelResponse.status === 400, "admin LLM test POST must reject oversized model names before LLM calls");

    const llmTestRouteSource = fs.readFileSync(path.join(process.cwd(), "app/api/admin/llm-settings/test/route.ts"), "utf8");
    assert(llmTestRouteSource.includes("recordAdminSiteEvent"), "admin LLM test route must record audit events");
    assert(llmTestRouteSource.includes("llm_test"), "admin LLM test route must record action llm_test");
    assert(llmTestRouteSource.includes("completeJsonWithMetadata"), "admin LLM test route must use the existing LLM client");
    assert(llmTestRouteSource.includes("parseAdminLlmTestBody"), "admin LLM test route must validate payload before calling LLM");

    const adminLlmPanelSource = fs.readFileSync(path.join(process.cwd(), "components/admin-llm-settings-panel.tsx"), "utf8");
    assert(adminLlmPanelSource.includes("/api/admin/llm-settings/test"), "admin LLM panel must call the LLM test endpoint");
    assert(adminLlmPanelSource.includes("테스트 호출"), "admin LLM panel must expose a test call button");

    const adminApiValidationSource = fs.readFileSync(path.join(process.cwd(), "lib/security/admin-api-validation.ts"), "utf8");
    assert(adminApiValidationSource.includes("parseAdminLlmTestBody"), "admin API validation must expose an LLM test payload parser");

    const articleTriageHelperSource = fs.readFileSync(path.join(process.cwd(), "lib/db/article-triage.ts"), "utf8");
    assert(articleTriageHelperSource.includes("classifyLlmError"), "article triage helper must classify LLM test errors");

    const adminJobsMigration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260709150000_admin_jobs.sql"),
      "utf8",
    );
    for (const requiredSql of [
      "create table if not exists admin_jobs",
      "create table if not exists admin_job_events",
      "idempotency_key text not null unique",
      "claim_admin_job",
      "append_admin_job_event",
      "for update skip locked",
      "admin_jobs_status_priority_requested_at_idx",
      "admin_jobs_source_key_status_idx",
      "admin_jobs_idempotency_key_idx",
      "admin_jobs_lease_until_idx",
      "admin_job_events_job_id_occurred_at_idx",
    ]) {
      assert(adminJobsMigration.toLowerCase().includes(requiredSql), `admin jobs migration must include ${requiredSql}`);
    }

    const adminJobClaimFixMigration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql"),
      "utf8",
    );
    for (const requiredSql of ["v_worker_id alias for $1", "v_job_types alias for $2", "v_lease_seconds alias for $3"]) {
      assert(
        adminJobClaimFixMigration.toLowerCase().includes(requiredSql),
        `admin job claim fix migration must include ${requiredSql}`,
      );
    }
    assert(
      !adminJobClaimFixMigration.includes("fn."),
      "admin job claim fix migration must not qualify PL/pgSQL parameters as SQL table aliases",
    );

    const adminJobsHelperSource = fs.readFileSync(path.join(process.cwd(), "lib/db/admin-jobs.ts"), "utf8");
    for (const requiredExport of [
      "export const ADMIN_JOB_TYPES",
      "export const ADMIN_JOB_STATUSES",
      "export function buildAdminJobIdempotencyKey",
      "export async function createAdminJob",
      "export async function claimAdminJob",
      "export async function appendAdminJobEvent",
      "export async function markAdminJobSucceeded",
      "export async function markAdminJobFailed",
      "export async function requestAdminJobCancel",
      "export async function markAdminJobCancelled",
      "export async function retryAdminJob",
      "export async function listAdminJobs",
      "export async function listAdminJobEvents",
      "export async function getAdminJobSummary",
    ]) {
      assert(adminJobsHelperSource.includes(requiredExport), `admin jobs helper must include ${requiredExport}`);
    }
    assert(adminJobsHelperSource.includes("redactAdminAuditMetadata"), "admin jobs helper must redact JSON payloads before storage");
    assert(adminJobsHelperSource.includes("unavailable: true"), "admin jobs helper must expose unavailable fallbacks for unapplied migrations");
    assert(adminJobsHelperSource.includes("admin-job-retry:"), "admin jobs helper must use retry-specific idempotency keys");
    const markSucceededBlock = adminJobsHelperSource.slice(
      adminJobsHelperSource.indexOf("export async function markAdminJobSucceeded"),
      adminJobsHelperSource.indexOf("export async function markAdminJobFailed"),
    );
    const markFailedBlock = adminJobsHelperSource.slice(
      adminJobsHelperSource.indexOf("export async function markAdminJobFailed"),
      adminJobsHelperSource.indexOf("export async function requestAdminJobCancel"),
    );
    assert(!markSucceededBlock.includes("is no longer cancellable"), "markAdminJobSucceeded must not use cancel-only guard errors");
    assert(!markFailedBlock.includes("is no longer cancellable"), "markAdminJobFailed must not use cancel-only guard errors");

    const adminJobRunnerSource = fs.readFileSync(path.join(process.cwd(), "lib/admin/admin-job-runner.ts"), "utf8");
    for (const requiredCall of ["claimAdminJob", "markAdminJobSucceeded", "markAdminJobFailed", "markAdminJobCancelled", "appendAdminJobEvent"]) {
      assert(adminJobRunnerSource.includes(requiredCall), `admin job runner must use ${requiredCall}`);
    }
    assert(adminJobRunnerSource.includes("executeAdminIngestJobOptions"), "admin job runner must execute queued ingest jobs through the shared executor");
    assert(adminJobRunnerSource.includes('mode: "unavailable"'), "admin job runner must return unavailable mode when queue schema is missing");

    const adminJobRunRouteSource = fs.readFileSync(path.join(process.cwd(), "app/api/admin/jobs/run/route.ts"), "utf8");
    assert(adminJobRunRouteSource.includes("adminMutationAuthFailureStatus"), "admin job run route must use admin mutation auth");
    assert(adminJobRunRouteSource.includes("runAdminJobWorker"), "admin job run route must call the bounded job worker");
    assert(adminJobRunRouteSource.includes("parseAdminJobRunBody"), "admin job run route must validate worker payloads");

    const adminJobCronRoutePath = path.join(process.cwd(), "app/api/admin/cron/jobs/route.ts");
    assert(fs.existsSync(adminJobCronRoutePath), "admin job cron route must exist");
    const adminJobCronRouteSource = fs.readFileSync(adminJobCronRoutePath, "utf8");
    assert(adminJobCronRouteSource.includes("isAuthorizedSecretRequest"), "admin job cron route must use secret-only auth");
    assert(adminJobCronRouteSource.includes("runAdminJobWorker"), "admin job cron route must drain the admin job worker");
    assert(adminJobCronRouteSource.includes("ADMIN_JOB_CRON_MAX_JOBS"), "admin job cron route must support bounded max jobs env");
    assert(adminJobCronRouteSource.includes("ADMIN_JOB_CRON_LEASE_SECONDS"), "admin job cron route must support bounded lease seconds env");
    assert(adminJobCronRouteSource.includes("ADMIN_JOB_CRON_TYPES"), "admin job cron route must support optional job type env");

    const adminJobWorkflowPath = path.join(process.cwd(), ".github/workflows/admin-job-worker.yml");
    assert(fs.existsSync(adminJobWorkflowPath), "admin job worker workflow must exist");
    const adminJobWorkflowSource = fs.readFileSync(adminJobWorkflowPath, "utf8");
    assert(adminJobWorkflowSource.includes("/api/admin/cron/jobs"), "admin job workflow must call the cron jobs endpoint");
    assert(adminJobWorkflowSource.includes("Authorization: Bearer"), "admin job workflow must pass CRON_SECRET through an Authorization header");
    assert(adminJobWorkflowSource.includes("*/15 * * * *"), "admin job workflow must run on a 15 minute schedule");
    assert(!adminJobWorkflowSource.includes("?secret="), "admin job workflow must not use query string secrets");

    const adminJobsPagePath = path.join(process.cwd(), "app/admin/jobs/page.tsx");
    assert(fs.existsSync(adminJobsPagePath), "retired admin jobs route must preserve a redirect");
    const adminJobsPageSource = fs.readFileSync(adminJobsPagePath, "utf8");
    assert(adminJobsPageSource.includes('permanentRedirect("/admin/work?type=execution")'), "retired jobs screen must redirect to the unified queue");
    assert(!fs.existsSync(path.join(process.cwd(), "components/admin-job-drain-button.tsx")), "retired job drain UI must be removed");
    assert(!fs.existsSync(path.join(process.cwd(), "components/admin-job-actions.tsx")), "retired job action UI must be removed");

    const adminJobActionRoutePath = path.join(process.cwd(), "app/api/admin/jobs/[jobId]/route.ts");
    assert(fs.existsSync(adminJobActionRoutePath), "admin job action route must exist");
    const adminJobActionRouteSource = fs.readFileSync(adminJobActionRoutePath, "utf8");
    assert(adminJobActionRouteSource.includes("adminMutationAuthFailureStatus"), "admin job action route must use admin mutation auth");
    assert(adminJobActionRouteSource.includes("parseAdminJobActionBody"), "admin job action route must validate cancel/retry payloads");
    assert(adminJobActionRouteSource.includes("markAdminJobCancelled"), "admin job action route must cancel jobs through the queue helper");
    assert(adminJobActionRouteSource.includes("retryAdminJob"), "admin job action route must retry jobs through the queue helper");
    assert(adminJobActionRouteSource.includes("appendAdminJobEvent"), "admin job action route must append queue events");
    assert(adminJobActionRouteSource.includes("recordAdminSiteEvent"), "admin job action route must write admin audit events");

    assert(adminApiValidationSource.includes("parseAdminJobActionBody"), "admin API validation must expose a job action parser");
    assert(adminApiValidationSource.includes('const JOB_ACTIONS = ["cancel", "retry"]'), "admin job action parser must restrict actions to cancel/retry");
    assert(adminApiValidationSource.includes("ADMIN_JOB_REASON_MAX_LENGTH"), "admin job action parser must limit reason length");

    const readmeSource = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    for (const requiredReadmeText of [
      "/admin/jobs",
      "작업 큐",
      "HTTP `202`",
      "`mode: \"queued\"`",
      "`POST` | `/api/admin/jobs/run`",
      "`POST` | `/api/admin/jobs/[jobId]`",
      "`GET` | `/api/admin/cron/jobs`",
      "legacy/direct cron 수집 endpoint",
      "pnpm admin:readiness",
    ]) {
      assert(readmeSource.includes(requiredReadmeText), `README must document ${requiredReadmeText}`);
    }

    const productionChecklistSource = fs.readFileSync(path.join(process.cwd(), "docs/security/production-checklist.md"), "utf8");
    for (const requiredChecklistText of [
      "20260709120000_admin_dashboard_summary_views.sql",
      "20260709130000_admin_audit_and_edit_history.sql",
      "20260709140000_admin_article_triage_columns.sql",
      "20260709150000_admin_jobs.sql",
      "admin-job-worker.yml",
      "pnpm admin:readiness",
      "/admin/jobs",
      "/api/admin/cron/jobs",
      "/api/admin/jobs/run",
      "HTTP 202 queued",
    ]) {
      assert(productionChecklistSource.includes(requiredChecklistText), `production checklist must document ${requiredChecklistText}`);
    }

    const readinessScriptPath = path.join(process.cwd(), "scripts/admin-ops-readiness.ts");
    assert(fs.existsSync(readinessScriptPath), "admin ops readiness script must exist");
    const readinessScriptSource = fs.readFileSync(readinessScriptPath, "utf8");
    for (const requiredReadinessText of [
      "getSupabaseAdmin",
      "admin_jobs",
      "admin_job_events",
      "claim_admin_job",
      "__readiness_never_claim__",
      "admin_audit_logs",
      "admin_article_edit_history",
      "admin_article_status_summary_v",
      "admin_source_health_v",
      "rpc_admin_dashboard_snapshot",
      "rpc_admin_analytics_health_snapshot",
      "error_class,error_context,review_state",
    ]) {
      assert(readinessScriptSource.includes(requiredReadinessText), `readiness script must check ${requiredReadinessText}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
    assert(packageJson.scripts?.["admin:readiness"] === "tsx scripts/admin-ops-readiness.ts", "package.json must expose pnpm admin:readiness");

    const { GET: adminJobsRunGet, POST: adminJobsRunPost } = await import("@/app/api/admin/jobs/run/route");
    const adminJobsRunGetResponse = adminJobsRunGet();
    assert(adminJobsRunGetResponse.status === 405, "GET /api/admin/jobs/run must be rejected with 405");
    const unauthenticatedAdminJobsRunResponse = await adminJobsRunPost(
      new Request("https://example.test/api/admin/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert(unauthenticatedAdminJobsRunResponse.status === 401, "admin job worker POST without authentication must return 401");
    const invalidAdminJobsRunResponse = await adminJobsRunPost(
      new Request("https://example.test/api/admin/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ maxJobs: 11 }),
      }),
    );
    assert(invalidAdminJobsRunResponse.status === 400, "admin job worker POST must reject oversized maxJobs before claiming jobs");

    const { GET: adminJobActionGet, POST: adminJobActionPost } = await import("@/app/api/admin/jobs/[jobId]/route");
    const adminJobActionGetResponse = adminJobActionGet();
    assert(adminJobActionGetResponse.status === 405, "GET /api/admin/jobs/[jobId] must be rejected with 405");
    const unauthenticatedAdminJobActionResponse = await adminJobActionPost(
      new Request("https://example.test/api/admin/jobs/00000000-0000-0000-0000-000000000000", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      }),
      { params: Promise.resolve({ jobId: "00000000-0000-0000-0000-000000000000" }) },
    );
    assert(unauthenticatedAdminJobActionResponse.status === 401, "admin job action POST without authentication must return 401");
    const invalidAdminJobActionResponse = await adminJobActionPost(
      new Request("https://example.test/api/admin/jobs/00000000-0000-0000-0000-000000000000", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "c".repeat(32) },
        body: JSON.stringify({ action: "delete" }),
      }),
      { params: Promise.resolve({ jobId: "00000000-0000-0000-0000-000000000000" }) },
    );
    assert(invalidAdminJobActionResponse.status === 400, "admin job action POST must reject invalid actions before touching jobs");
  } finally {
    for (const key of keysToRestore) {
      const value = originalEnv.get(key);
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

async function assertSecurityHeadersConfigured() {
  const headers = nextConfig.headers;
  if (typeof headers !== "function") {
    throw new Error("Next.js security headers must be configured");
  }
  const routes = await headers();
  const allHeaders = new Map(routes.flatMap((route) => route.headers).map((header) => [header.key.toLowerCase(), header.value]));
  const cspReportOnly = allHeaders.get("content-security-policy-report-only") ?? "";

  assert(cspReportOnly.includes("default-src 'self'"), "CSP report-only must define default-src");
  assert(cspReportOnly.includes("frame-ancestors 'self'"), "CSP report-only must allow same-origin print framing only");
  assert(cspReportOnly.includes("frame-src 'self'"), "CSP report-only must allow same-origin print frames");
  assert(cspReportOnly.includes("report-uri /api/security/csp-report"), "CSP report-only must report to the local CSP collector");
  assert(cspReportOnly.includes("report-to csp"), "CSP report-only must declare the csp reporting group");
  assert(allHeaders.get("reporting-endpoints") === 'csp="/api/security/csp-report"', "Reporting-Endpoints must expose the CSP collector");
  assert(allHeaders.get("strict-transport-security")?.includes("max-age="), "HSTS header must be configured");
  assert(allHeaders.get("x-content-type-options") === "nosniff", "X-Content-Type-Options must be nosniff");
  assert(allHeaders.get("referrer-policy") === "strict-origin-when-cross-origin", "Referrer-Policy must be configured");
  assert(allHeaders.get("permissions-policy")?.includes("camera=()"), "Permissions-Policy must be configured");
  assert(allHeaders.get("x-frame-options") === "SAMEORIGIN", "X-Frame-Options must allow same-origin print frames");
}

async function assertCspReportEndpointControls() {
  const { POST: cspReportPost } = await import("@/app/api/security/csp-report/route");
  const validResponse = await cspReportPost(
    new Request("https://example.test/api/security/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "https://worldcons.vercel.app/articles/sample?x=1",
          "violated-directive": "script-src-elem",
          "effective-directive": "script-src-elem",
          "blocked-uri": "inline",
          disposition: "report",
          "status-code": 200,
        },
      }),
    }),
  );
  assert(validResponse.status === 204, "valid CSP reports must be accepted with 204");

  const oversizedResponse = await cspReportPost(
    new Request("https://example.test/api/security/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report", "content-length": String(17 * 1024) },
      body: JSON.stringify({ "csp-report": { "document-uri": "https://worldcons.vercel.app/" } }),
    }),
  );
  assert(oversizedResponse.status === 413, "oversized CSP reports must be rejected before parsing");

  const streamedOversizedResponse = await cspReportPost(
    new Request("https://example.test/api/security/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { sample: "x".repeat(17 * 1024) } }),
    }),
  );
  assert(streamedOversizedResponse.status === 413, "oversized CSP reports without content-length must be rejected while reading");

  const invalidResponse = await cspReportPost(
    new Request("https://example.test/api/security/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "not-json",
    }),
  );
  assert(invalidResponse.status === 400, "invalid CSP report bodies must return 400");
}

async function assertPublicApiRouteValidationControls() {
  const { GET: articlesGet } = await import("@/app/api/articles/route");
  const articlesResponse = await articlesGet(new Request("https://example.test/api/articles?pageSize=101"));
  assert(articlesResponse.status === 400, "invalid /api/articles query params must return 400");

  const { GET: searchGet } = await import("@/app/api/search/route");
  const searchResponse = await searchGet(new Request("https://example.test/api/search?mode=unexpected"));
  assert(searchResponse.status === 400, "invalid /api/search query params must return 400");

  const { GET: tagsGet } = await import("@/app/api/tags/route");
  const tagsResponse = await tagsGet(new Request("https://example.test/api/tags?sort=unexpected"));
  assert(tagsResponse.status === 400, "invalid /api/tags query params must return 400");

  const { GET: articleSlugGet } = await import("@/app/api/articles/[slug]/route");
  const articleSlugResponse = await articleSlugGet(new Request("https://example.test/api/articles/javascript:alert(1)"), {
    params: Promise.resolve({ slug: "javascript:alert(1)" }),
  });
  assert(articleSlugResponse.status === 400, "invalid /api/articles/[slug] params must return 400");

  const { GET: sourceGet } = await import("@/app/api/sources/[sourceKey]/route");
  const sourceResponse = await sourceGet(new Request("https://example.test/api/sources/..%2Fsecret"), {
    params: Promise.resolve({ sourceKey: "../secret" }),
  });
  assert(sourceResponse.status === 400, "invalid /api/sources/[sourceKey] params must return 400");

  const { POST: analyticsPost } = await import("@/app/api/analytics/event/route");
  const analyticsResponse = await analyticsPost(
    new Request("https://example.test/api/analytics/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType: "tag_click", path: "https://evil.test" }),
    }),
  );
  assert(analyticsResponse.status === 400, "invalid /api/analytics/event body must return 400");
}

async function main() {
  await assertSecurityHeadersConfigured();
  await assertCspReportEndpointControls();
  await assertPublicApiRouteValidationControls();
  await assertAdminRouteSecurityControls();
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
