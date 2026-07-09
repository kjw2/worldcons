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
import { articleFiltersFromSearchParams } from "@/lib/utils/search-params";
import { generateArticleSlug } from "@/lib/utils/slug";
import { canonicalizeTerminologyText, canonicalizeTerminologyValue } from "@/lib/ai/terminology";
import { adminAuditEntryFromSiteEvent } from "@/lib/db/analytics";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { tribunalConstitucionalAdapter } from "@/lib/sources/tribunalconstitucional";
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
    assert(
      /runSummarizePending\(\{\s*limit:\s*summarizeLimit,\s*sourceKey\s*\}\)/s.test(adminIngestRouteSource),
      "admin source-scoped summarize request must pass sourceKey to runSummarizePending",
    );

    const adminPageSource = fs.readFileSync(path.join(process.cwd(), "app/admin/page.tsx"), "utf8");
    const ingestionStatusPanelSource = fs.readFileSync(path.join(process.cwd(), "components/ingestion-status-panel.tsx"), "utf8");
    for (const [label, source] of [
      ["admin source table", adminPageSource],
      ["ingestion status panel", ingestionStatusPanelSource],
    ] as const) {
      assert(source.includes("/admin/articles?sourceKey="), `${label} must link source rows to filtered article management`);
      assert(source.includes("/admin/candidates?source="), `${label} must link source rows to filtered URL candidates`);
      assert(source.includes("/admin/audit?q="), `${label} must link source rows to filtered audit logs`);
      assert(source.includes('"failed_summary"'), `${label} must expose a clear failed-summary article link`);
      assert(source.includes('"failed_fetch"'), `${label} must expose a clear failed-fetch article link`);
      assert(source.includes('"metadata_only"'), `${label} must expose a clear metadata-only article link`);
    }
    assert(adminPageSource.includes('"cleaned"'), "admin source table must expose a clear pending-summary article link");

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
    assert(adminOperationsPageSource.includes("isAuthorizedPageRequest"), "admin operations page must keep the admin auth gate");
    assert(adminOperationsPageSource.includes('encodeURIComponent("/admin/operations")'), "admin operations page must redirect unauthenticated users back to /admin/operations");
    assert(adminOperationsPageSource.includes('<AdminTabs active="operations" />'), "admin operations page must select the operations tab");
    assert(adminOperationsPageSource.includes("/admin/ingestion-runs"), "admin operations page must link to ingestion runs");
    assert(adminOperationsPageSource.includes("/admin/articles"), "admin operations page must link to article management");
    assert(adminOperationsPageSource.includes("/admin/candidates"), "admin operations page must link to URL candidates");
    assert(adminOperationsPageSource.includes("/admin/llm"), "admin operations page must link to LLM management");
    assert(adminOperationsPageSource.includes("/admin/audit"), "admin operations page must link to audit logs");

    const adminTabsSource = fs.readFileSync(path.join(process.cwd(), "components/admin-tabs.tsx"), "utf8");
    assert(adminTabsSource.includes('"operations"'), "AdminTabs active union must include operations");
    assert(adminTabsSource.includes('href: "/admin/operations"'), "AdminTabs must include an operations home link");
    assert(adminTabsSource.includes('label: "운영 홈"'), "AdminTabs must label the operations link");

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
    assert(/\(await loadAdminDashboardSnapshot\(\)\) \?\? loadAdminDashboardLegacyData\(\)/.test(adminQueriesSource), "admin dashboard queries must fallback when the snapshot is unavailable");

    const analyticsQueriesSource = fs.readFileSync(path.join(process.cwd(), "lib/db/analytics.ts"), "utf8");
    assert(analyticsQueriesSource.includes('rpc("rpc_admin_analytics_health_snapshot"'), "analytics queries must try the health snapshot RPC");
    assert(analyticsQueriesSource.includes("loadAnalyticsHealthData"), "analytics queries must keep a callable health helper with fallback");
    assert(analyticsQueriesSource.includes("loadIngestionRunRows(days)") && analyticsQueriesSource.includes("loadArticleSummaryRows()"), "analytics health fallback must keep legacy collection/model reads");

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
