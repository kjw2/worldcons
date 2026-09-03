import zlib from "node:zlib";
import { load } from "cheerio";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import type { CrawlAttemptLog, CrawlerDiagnosticsCollector, CrawlerExecutionHooks } from "@/lib/crawler/types";
import { governedBufferedFetch } from "@/lib/crawler/request-governor";
import { crawlerUserAgent } from "@/lib/crawler/user-agents";
import { cleanText } from "@/lib/ingest/extract-text";
import type { CrawleeSpiderItem, CrawleeSpiderOptions, CrawleeSpiderResult } from "@/lib/crawlee/types";
import type { DiscoveredItem, RawArticle } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { createHash } from "@/lib/utils/hash";

export const SPAIN_TC_SOURCE_KEY = "es-tribunal-constitucional";
export const SPAIN_TC_BASE_URL = "https://hj.tribunalconstitucional.es";
export const SPAIN_TC_BACKFILL_START_DECISION_DATE = "2025-01-01";
export const SPAIN_TC_DEFAULT_INGEST_RANGE_DAYS = 180;
export const SPAIN_TC_INGEST_RANGE_CAP_DAYS = 730;
export const SPAIN_TC_DEFAULT_DISCOVERY_MAX_PAGES = 20;
export const SPAIN_TC_DEFAULT_BACKFILL_MAX_PAGES = 200;
export const SPAIN_TC_DEFAULT_STOP_AFTER_OLD_PAGES = 5;
export const SPAIN_TC_MIN_SOURCE_TEXT_LENGTH = 2000;
export const SPAIN_TC_DEFAULT_TAIL_PROBE_LIMIT = 30;
export const SPAIN_TC_DEFAULT_TAIL_PROBE_EMPTY_STOP = 3;

const SEARCH_INDEX_PATHS = ["/HJ/es/Busqueda/Index", "/es/Busqueda/Index"];
const SEARCH_AJAX_PATHS = ["/HJ/es/Busqueda/BuscarAjax", "/es/Busqueda/BuscarAjax"];
const LIST_PATHS = ["/HJ/es/Resolucion/List", "/es/Resolucion/List"];
const RESOLUTION_TYPES = ["SENTENCIA", "AUTO", "DECLARACION"] as const;
const spainRobotsByOrigin = new Map<string, RobotsResult>();

export type SpainResolutionType = (typeof RESOLUTION_TYPES)[number];

export interface SpainTcInventoryItem {
  stableItemKey: string;
  sourceRecordId: string;
  discoveredUrl: string;
  documentType: SpainResolutionType;
  decisionDateHint: string | null;
  title: string | null;
}

export interface SpainTcInventoryResult {
  sourceKey: typeof SPAIN_TC_SOURCE_KEY;
  year: number;
  documentType: SpainResolutionType;
  items: SpainTcInventoryItem[];
  pageCount: number;
  coverageEvidence: Record<string, unknown>;
}

interface SearchSession {
  indexUrl: string;
  ajaxUrl: string;
  listUrl: string;
  token: string;
  cookies: Map<string, string>;
}

interface SpainHjJson extends Record<string, unknown> {
  ID?: number | string;
  TIPO_RESOLUCION?: string | null;
  NUMERO_RESOLUCION?: number | string | null;
  ANNO_RESOLUCION?: number | string | null;
  BIS_RESOLUCION?: string | null;
  FECHA_REGISTRO?: string | null;
  FECHA_BOE?: string | null;
  FECHA_FIRMA?: string | null;
  NUMERO_BOE?: number | string | null;
  REFERENCIA_BOE?: string | null;
  ULTIMA_ACTUALIZACION?: string | null;
  CONTENIDO_IRRELEVANTE_PARA_INTERNET?: boolean | null;
  AVISO?: string | null;
  SINTESIS_DESCRIPTIVA?: string | null;
  SINTESIS_ANALITICA?: string | null;
  RESUMEN?: string | null;
}

interface DateValidation {
  ok: boolean;
  checks: Array<{
    source: "FECHA_REGISTRO" | "FECHA_FIRMA" | "html_title_date";
    value?: string;
    matches?: boolean;
  }>;
  warnings: string[];
  reason?: string;
}

interface SectionSnapshot {
  key: string;
  label: string;
  textLength: number;
  substantive: boolean;
}

interface BuildRawOptions {
  jsonApiUrl?: string;
  fetchMethod?: "json_api" | "html_fallback" | "document_fallback";
  parseConfidence?: "high" | "medium" | "low";
  jsonApiError?: string;
  htmlTitleDate?: string;
  htmlTitle?: string;
  fallbackReason?: string;
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function requestTimeoutMs() {
  return envNumber("SPAIN_REQUEST_TIMEOUT_MS", envNumber("CRAWLER_TIMEOUT_MS", 30000));
}

function requestDelayMs() {
  const configuredDelayMs = Number(process.env.SPAIN_REQUEST_DELAY_MS);
  if (Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0) return configuredDelayMs;
  const sameDomainDelaySeconds = Number(process.env.CRAWLEE_SAME_DOMAIN_DELAY_SECS);
  return Number.isFinite(sameDomainDelaySeconds) && sameDomainDelaySeconds >= 0
    ? sameDomainDelaySeconds * 1000
    : 2000;
}

function userAgent() {
  return crawlerUserAgent();
}

function pathUrl(path: string) {
  return new URL(path, SPAIN_TC_BASE_URL).toString();
}

function cookieHeader(cookies: Map<string, string>) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function getSetCookies(headers: Headers) {
  const withMethod = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = withMethod.getSetCookie?.();
  if (cookies?.length) return cookies;
  const header = headers.get("set-cookie");
  return header ? [header] : [];
}

function mergeSetCookies(cookies: Map<string, string>, setCookieHeaders: string[]) {
  for (const header of setCookieHeaders) {
    const firstPart = header.split(";")[0];
    const separator = firstPart.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(firstPart.slice(0, separator), firstPart.slice(separator + 1));
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, hooks?: CrawlerExecutionHooks) {
  await checkpointCrawlerExecution(hooks);
  const origin = new URL(url).origin;
  let robots = spainRobotsByOrigin.get(origin);
  if (!robots) {
    robots = await checkRobotsAllowed(url, hooks);
    spainRobotsByOrigin.set(origin, robots);
  }
  if (!robots.allowed) {
    throw new Error(`Spain HJ robots policy disallows ${new URL(url).pathname}.`);
  }
  await respectRateLimit(url, robotsDelayMs(robots, requestDelayMs()), hooks?.signal);
  await checkpointCrawlerExecution(hooks);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const signals = [init.signal, hooks?.signal, controller.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const response = await governedBufferedFetch(url, {
      ...init,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      headers: {
        "User-Agent": userAgent(),
        ...init.headers,
      },
    }, hooks);
    await checkpointCrawlerExecution(hooks);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function addAttempt(diagnostics: CrawlerDiagnosticsCollector | undefined, attempt: CrawlAttemptLog) {
  addDiagnosticAttempt(diagnostics, { sourceKey: SPAIN_TC_SOURCE_KEY, ...attempt });
}

export function canonicalSpainTcUrl(hjId: string | number) {
  return `${SPAIN_TC_BASE_URL}/HJ/es/Resolucion/Show/${hjId}`;
}

export function spainTcDocumentUrl(hjId: string | number) {
  return `${SPAIN_TC_BASE_URL}/HJ/es/Resolucion/GetDocumentResolucion/${hjId}`;
}

export function jsonApiUrls(hjId: string | number) {
  return [
    `${SPAIN_TC_BASE_URL}/HJ/Resolucion/Api/json/${hjId}`,
    `${SPAIN_TC_BASE_URL}/Resolucion/Api/json/${hjId}`,
  ];
}

export function hjIdFromUrl(url: string) {
  return url.match(/\/Resolucion\/(?:Show|Api\/json|GetDocumentResolucion)\/(\d+)/i)?.[1];
}

function dateOnlyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function normalizeSpainDecisionDate(value?: string | null) {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) return validDateOnly(iso[1], iso[2], iso[3]);

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/);
  if (slash) return validDateOnly(slash[3], slash[2], slash[1]);
  return undefined;
}

function validDateOnly(yearValue: string, monthValue: string, dayValue: string) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || year < 1900 || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateOnlyToUtcIso(dateOnly?: string) {
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : undefined;
}

function compareDateOnly(left?: string, right?: string) {
  if (!left || !right) return 0;
  return left.localeCompare(right);
}

function daysAgoDateOnly(days: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return dateOnlyFromDate(start);
}

function todayDateOnly() {
  const now = new Date();
  return dateOnlyFromDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

function ddMmYyyy(dateOnly: string) {
  const [year, month, day] = dateOnly.split("-");
  return `${day}/${month}/${year}`;
}

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

export function parseSpanishLongDate(value?: string | null, fallbackYear?: number | string | null) {
  if (!value) return undefined;
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/(?:^|\b)de\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (!match) return undefined;
  const month = SPANISH_MONTHS[match[2]];
  const year = Number(match[3] ?? fallbackYear);
  if (!month || !Number.isFinite(year) || year < 1900) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function parseTitleDate(title?: string, fallbackYear?: number | string | null) {
  return parseSpanishLongDate(title, fallbackYear);
}

function stripHtml(value?: unknown) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  return load(`<body>${text}</body>`).text().replace(/\u00a0/g, " ").replace(/\s+\n/g, "\n").trim();
}

function textField(entry: Record<string, unknown>, key: string) {
  return stripHtml(entry[key]);
}

function sectionEntries(payload: SpainHjJson, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function numberedText(entry: Record<string, unknown>) {
  const text = textField(entry, "TEXTO");
  if (!text) return "";
  const number = entry.NUMERO;
  return number === undefined || number === null || number === "" ? text : `${number}. ${text}`;
}

function assembleSection(payload: SpainHjJson, key: string, label: string, substantive: boolean) {
  const entries = sectionEntries(payload, key);
  const pieces = entries
    .map((entry) => {
      if (key === "RESOLUCIONES_CABECERA") {
        return [textField(entry, "COMPONENTES"), textField(entry, "TEXTO")].filter(Boolean).join("\n\n");
      }
      if (key === "RESOLUCIONES_DICTAMEN") {
        return [textField(entry, "TITULO"), textField(entry, "TEXTO")].filter(Boolean).join("\n\n");
      }
      if (key === "RESOLUCIONES_PIE") {
        return textField(entry, "TEXTO");
      }
      return numberedText(entry);
    })
    .filter(Boolean);
  const text = pieces.join("\n\n");
  return {
    key,
    label,
    text,
    snapshot: {
      key,
      label,
      textLength: text.length,
      substantive,
    } satisfies SectionSnapshot,
  };
}

export function assembleSpainSourceText(payload: SpainHjJson) {
  const sections = [
    assembleSection(payload, "RESOLUCIONES_CABECERA", "Cabecera", false),
    assembleSection(payload, "RESOLUCIONES_ANTECEDENTES", "Antecedentes", true),
    assembleSection(payload, "RESOLUCIONES_FUNDAMENTOS", "Fundamentos jurídicos", true),
    assembleSection(payload, "RESOLUCIONES_DICTAMEN", "Fallo/Dictamen", true),
    assembleSection(payload, "RESOLUCIONES_VOTOS_PARTICULARES", "Votos particulares", true),
    assembleSection(payload, "RESOLUCIONES_PIE", "Pie", false),
  ].filter((section) => section.text.trim().length > 0);

  const text = sections.map((section) => `${section.label}\n\n${section.text}`).join("\n\n---\n\n");
  return {
    text,
    sections: sections.map((section) => section.snapshot),
    hasSubstantiveSection: sections.some((section) => section.snapshot.substantive && section.snapshot.textLength > 0),
  };
}

export function contentTypeForResolutionType(value?: string | null) {
  const normalized = value?.toUpperCase();
  if (normalized === "AUTO") return "order" as const;
  if (normalized === "DECLARACION") return "decision" as const;
  return "decision" as const;
}

function resolutionNumber(payload: SpainHjJson) {
  const number = payload.NUMERO_RESOLUCION;
  const year = payload.ANNO_RESOLUCION;
  if (number === undefined || number === null || year === undefined || year === null) return undefined;
  const bis = typeof payload.BIS_RESOLUCION === "string" && payload.BIS_RESOLUCION.trim() ? payload.BIS_RESOLUCION.trim() : "";
  return `${number}${bis}/${year}`;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function ecliFor(payload: SpainHjJson) {
  const explicit = stringValue(payload.ECLI ?? payload.ecli);
  if (explicit) return { ecli: explicit, derived: false };
  const number = numberValue(payload.NUMERO_RESOLUCION);
  const year = numberValue(payload.ANNO_RESOLUCION);
  if (!number || !year) return { ecli: undefined, derived: false };
  return { ecli: `ECLI:ES:TC:${year}:${number}`, derived: true };
}

function titleFor(payload: SpainHjJson, decisionDate?: string) {
  const resolutionType = stringValue(payload.TIPO_RESOLUCION) ?? "Resolución";
  const number = resolutionNumber(payload);
  const firma = stringValue(payload.FECHA_FIRMA);
  const suffix = firma || decisionDate;
  return [`${resolutionType}${number ? ` ${number}` : ""}`, suffix].filter(Boolean).join(", ");
}

function boeUrl(referenceBoe?: string) {
  return referenceBoe ? `https://www.boe.es/buscar/doc.php?id=${encodeURIComponent(referenceBoe)}` : undefined;
}

function validateDecisionDate(payload: SpainHjJson, decisionDate?: string, htmlTitleDate?: string): DateValidation {
  const checks: DateValidation["checks"] = [{ source: "FECHA_REGISTRO", value: decisionDate, matches: Boolean(decisionDate) }];
  const warnings: string[] = [];
  if (!decisionDate) {
    return { ok: false, checks, warnings, reason: "FECHA_REGISTRO is missing or not date-only parseable." };
  }

  const firmaDate = parseSpanishLongDate(payload.FECHA_FIRMA, payload.ANNO_RESOLUCION);
  if (firmaDate) {
    const matches = firmaDate === decisionDate;
    checks.push({ source: "FECHA_FIRMA", value: firmaDate, matches });
    if (!matches) return { ok: false, checks, warnings, reason: "FECHA_FIRMA does not match FECHA_REGISTRO." };
  }

  if (htmlTitleDate) {
    const matches = htmlTitleDate === decisionDate;
    checks.push({ source: "html_title_date", value: htmlTitleDate, matches });
    if (!firmaDate && !matches) return { ok: false, checks, warnings, reason: "HTML title decision date does not match FECHA_REGISTRO." };
    if (firmaDate && !matches) warnings.push("HTML title date does not match FECHA_REGISTRO.");
  }

  const resolutionYear = numberValue(payload.ANNO_RESOLUCION);
  if (resolutionYear && resolutionYear !== Number(decisionDate.slice(0, 4))) {
    warnings.push("ANNO_RESOLUCION year does not match FECHA_REGISTRO year.");
  }
  const { ecli } = ecliFor(payload);
  const ecliYear = ecli?.match(/(?:ECLI:)?ES:TC:(\d{4}):/i)?.[1];
  if (ecliYear && ecliYear !== decisionDate.slice(0, 4)) {
    warnings.push("ECLI year does not match FECHA_REGISTRO year.");
  }

  return { ok: true, checks, warnings };
}

function sourceTextQuality(text: string, hasSubstantiveSection: boolean, canonicalUrl?: string) {
  const cleaned = cleanText(text);
  return {
    cleanedTextLength: cleaned.length,
    sourceTextAvailable:
      Boolean(canonicalUrl?.startsWith(SPAIN_TC_BASE_URL)) &&
      hasSubstantiveSection &&
      cleaned.length >= envNumber("SPAIN_MIN_SOURCE_TEXT_LENGTH", SPAIN_TC_MIN_SOURCE_TEXT_LENGTH),
  };
}

export function isSpainMetadataOnlyNotice(value?: string | null) {
  const normalized = (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return /no incorpora doctrina constitucional|no contiene doctrina constitucional|sin doctrina constitucional/.test(normalized);
}

function reviewFor(reason?: string) {
  if (!reason) return undefined;
  return {
    required: true,
    reason,
  };
}

function collectionReason(params: {
  publishable: boolean;
  sourceTextAvailable: boolean;
  expectedMetadataOnly?: boolean;
  reviewReason?: string;
  fetchMethod: string;
}) {
  if (params.publishable) return undefined;
  if (params.expectedMetadataOnly) return "HJ explicitly reports that this resolution contains no constitutional doctrine; official source text is intentionally unavailable.";
  if (params.reviewReason === "contenido_irrelevante_para_internet") return "HJ marks this resolution as irrelevant for internet publication; automatic summarization is blocked.";
  if (params.reviewReason === "date_validation_failed") return "HJ decision date validation failed; official metadata requires human review.";
  if (params.reviewReason === "fallback_parse") return "HJ JSON API was unavailable and fallback parsing requires human review.";
  if (!params.sourceTextAvailable) return "Spanish HJ source text did not pass the strict substantive-section and minimum-length gate.";
  return `Spanish HJ collection is not publishable after ${params.fetchMethod}.`;
}

function hashesFor(rawText: string, cleanedText: string, metadataSeed: Record<string, unknown>) {
  return {
    rawTextSha256: createHash(rawText, 64),
    cleanedTextSha256: createHash(cleanedText, 64),
    metadataSha256: createHash(JSON.stringify(metadataSeed), 64),
  };
}

export function buildSpainTcRawArticleFromJson(payload: SpainHjJson, options: BuildRawOptions = {}): RawArticle {
  const hjId = stringValue(payload.ID);
  if (!hjId) throw new Error("Spain HJ JSON is missing ID.");
  const canonicalUrl = canonicalSpainTcUrl(hjId);
  const decisionDate = normalizeSpainDecisionDate(payload.FECHA_REGISTRO);
  const boePublishedAt = normalizeSpainDecisionDate(payload.FECHA_BOE);
  const htmlTitleDate = options.htmlTitleDate ?? parseTitleDate(options.htmlTitle, payload.ANNO_RESOLUCION);
  const dateValidation = validateDecisionDate(payload, decisionDate, htmlTitleDate);
  const { text, sections, hasSubstantiveSection } = assembleSpainSourceText(payload);
  const cleanedText = cleanText(text);
  const quality = sourceTextQuality(text, hasSubstantiveSection, canonicalUrl);
  const resolutionType = stringValue(payload.TIPO_RESOLUCION) ?? "RESOLUCION";
  const contentType = contentTypeForResolutionType(resolutionType);
  const referenceBoe = stringValue(payload.REFERENCIA_BOE);
  const fetchMethod = options.fetchMethod ?? "json_api";
  const parseConfidence = options.parseConfidence ?? "high";
  const { ecli, derived } = ecliFor(payload);
  const contentIrrelevant = payload.CONTENIDO_IRRELEVANTE_PARA_INTERNET === true;
  const notice = stringValue(payload.AVISO);
  const expectedMetadataOnly = !quality.sourceTextAvailable && isSpainMetadataOnlyNotice(notice);
  const fallbackReview = fetchMethod !== "json_api";
  const reviewReason =
    options.fallbackReason ??
    (contentIrrelevant ? "contenido_irrelevante_para_internet" : undefined) ??
    (!dateValidation.ok ? "date_validation_failed" : undefined) ??
    (fallbackReview ? "fallback_parse" : undefined);
  const publishable = quality.sourceTextAvailable && !reviewReason;

  const metadataSeed = {
    hjId,
    externalId: `es-tc-hj-${hjId}`,
    ecli,
    ecliDerived: derived || undefined,
    resolutionType,
    resolutionNumber: resolutionNumber(payload),
    resolutionYear: numberValue(payload.ANNO_RESOLUCION),
    dateBasis: "FECHA_REGISTRO",
    dateBasisLabel: "HJ FECHA_REGISTRO (decision date)",
    datePrecision: "date",
    decisionDate,
    publishedAtSource: "FECHA_REGISTRO",
    boeUsedForFiltering: false,
    boePublishedAt,
    boeNumber: stringValue(payload.NUMERO_BOE),
    referenceBoe,
    boeUrl: boeUrl(referenceBoe),
    latestUpdatedAt: normalizeSpainDecisionDate(payload.ULTIMA_ACTUALIZACION) ?? stringValue(payload.ULTIMA_ACTUALIZACION),
    contentTypeMapped: resolutionType.toUpperCase() === "DECLARACION" ? "DECLARACION -> decision" : undefined,
    sourceTextAvailable: quality.sourceTextAvailable,
    sourceTextQuality: {
      minLength: envNumber("SPAIN_MIN_SOURCE_TEXT_LENGTH", SPAIN_TC_MIN_SOURCE_TEXT_LENGTH),
      cleanedTextLength: quality.cleanedTextLength,
      hasSubstantiveSection,
      substantiveSections: sections.filter((section) => section.substantive && section.textLength > 0).map((section) => section.key),
    },
    dateValidation,
    collectionSafety: {
      contenidoIrrelevanteParaInternet: contentIrrelevant,
      publishable,
    },
    sourceTextStatus: quality.sourceTextAvailable ? "available" : expectedMetadataOnly ? "not_available" : "awaiting_hj_full_text",
    notice,
    sections,
    auxiliaryMetadata: {
      resumenLength: stripHtml(payload.RESUMEN).length || undefined,
      sintesisDescriptiva: stripHtml(payload.SINTESIS_DESCRIPTIVA) || undefined,
      sintesisAnalitica: stripHtml(payload.SINTESIS_ANALITICA) || undefined,
    },
    fetchMethod,
    parseConfidence,
    jsonApiUrl: options.jsonApiUrl,
    jsonApiError: options.jsonApiError,
    canonicalSourceUrl: canonicalUrl,
  };
  const hashes = hashesFor(text, cleanedText, metadataSeed);

  return {
    sourceKey: SPAIN_TC_SOURCE_KEY,
    url: canonicalUrl,
    canonicalUrl: canonicalizeUrl(canonicalUrl),
    title: titleFor(payload, decisionDate),
    publishedAt: dateOnlyToUtcIso(decisionDate),
    contentType,
    text,
    metadata: {
      ...metadataSeed,
      ...hashes,
      review: reviewFor(reviewReason),
      collection: {
        strategy: "api",
        confidence: parseConfidence,
        sourceUrlVerified: true,
        publishable,
        sourceTextAvailable: quality.sourceTextAvailable,
        strictSourceTextAvailable: true,
        reason: collectionReason({
          publishable,
          sourceTextAvailable: quality.sourceTextAvailable,
          expectedMetadataOnly,
          reviewReason,
          fetchMethod,
        }),
        source: SPAIN_TC_BASE_URL,
      },
    },
  };
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function textFromDocx(buffer: Buffer, hooks?: CrawlerExecutionHooks) {
  assertCrawlerExecution(hooks);
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    assertCrawlerExecution(hooks);
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return "";

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end && buffer.readUInt32LE(offset) === 0x02014b50) {
    assertCrawlerExecution(hooks);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (fileName === "word/document.xml") {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      const xml = (method === 8 ? zlib.inflateRawSync(compressed) : compressed).toString("utf8");
      return decodeXmlEntities(
        xml
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<[^>]+>/g, ""),
      ).replace(/\n{3,}/g, "\n\n").trim();
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return "";
}

export function buildSpainTcFallbackRawArticle(params: {
  hjId: string;
  title?: string;
  text: string;
  html?: string;
  decisionDate?: string;
  fetchMethod: "html_fallback" | "document_fallback";
  jsonApiError?: string;
}): RawArticle {
  const canonicalUrl = canonicalSpainTcUrl(params.hjId);
  const cleaned = cleanText(params.text);
  const sourceTextAvailable = false;
  const parseConfidence: "medium" | "low" = params.fetchMethod === "html_fallback" ? "medium" : "low";
  const metadataSeed = {
    hjId: params.hjId,
    externalId: `es-tc-hj-${params.hjId}`,
    dateBasis: "FECHA_REGISTRO",
    dateBasisLabel: "HJ FECHA_REGISTRO (decision date)",
    datePrecision: "date",
    decisionDate: params.decisionDate,
    boeUsedForFiltering: false,
    sourceTextAvailable,
    fetchMethod: params.fetchMethod,
    parseConfidence,
    jsonApiError: params.jsonApiError,
    canonicalSourceUrl: canonicalUrl,
  };

  return {
    sourceKey: SPAIN_TC_SOURCE_KEY,
    url: canonicalUrl,
    canonicalUrl: canonicalizeUrl(canonicalUrl),
    title: params.title ?? `Resolución HJ ${params.hjId}`,
    publishedAt: dateOnlyToUtcIso(params.decisionDate),
    contentType: "decision",
    html: params.html,
    text: params.text,
    metadata: {
      ...metadataSeed,
      ...hashesFor(params.text, cleaned, metadataSeed),
      review: reviewFor("fallback_parse"),
      collection: {
        strategy: "api",
        confidence: parseConfidence,
        sourceUrlVerified: true,
        publishable: false,
        sourceTextAvailable,
        strictSourceTextAvailable: true,
        reason: "HJ JSON API was unavailable and fallback parsing requires human review.",
        source: SPAIN_TC_BASE_URL,
      },
    },
  };
}

async function fetchJsonForHjId(hjId: string, diagnostics?: CrawlerDiagnosticsCollector, hooks?: CrawlerExecutionHooks) {
  let lastError: string | undefined;
  for (const url of jsonApiUrls(hjId)) {
    await checkpointCrawlerExecution(hooks);
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
          "Accept-Language": "es,en;q=0.8,ko;q=0.5",
        },
      }, hooks);
      const text = await response.text();
      await checkpointCrawlerExecution(hooks);
      const emptyBody = response.ok && text.trim().length === 0;
      addAttempt(diagnostics, {
        url,
        finalUrl: response.url,
        strategy: "api",
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        textLength: text.length,
        optional: emptyBody,
        result: emptyBody ? "empty" : response.ok ? "success" : "failed",
        errorCode: emptyBody ? "SPAIN_HJ_EMPTY_BODY" : undefined,
        errorMessage: emptyBody ? `Spain HJ API returned an empty HTTP ${response.status} body for ${hjId}.` : undefined,
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${url}`;
        continue;
      }
      if (emptyBody) {
        lastError = `SPAIN_HJ_EMPTY_BODY from ${url}`;
        continue;
      }
      return { payload: JSON.parse(text) as SpainHjJson, url };
    } catch (error) {
      if (hooks?.signal?.aborted) throw hooks.signal.reason;
      lastError = errorMessage(error);
      addAttempt(diagnostics, {
        url,
        strategy: "api",
        result: "failed",
        errorCode: error instanceof Error ? error.name : "Error",
        errorMessage: lastError,
      });
    }
  }
  throw new Error(lastError ?? `Spain HJ JSON API failed for ${hjId}`);
}

async function fetchHtmlFallback(hjId: string, jsonApiError: string, diagnostics?: CrawlerDiagnosticsCollector, hooks?: CrawlerExecutionHooks) {
  const url = canonicalSpainTcUrl(hjId);
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es,en;q=0.8,ko;q=0.5",
    },
  }, hooks);
  const html = await response.text();
  await checkpointCrawlerExecution(hooks);
  const $ = load(html);
  assertCrawlerExecution(hooks);
  const title = $("title").text().replace(/\s+/g, " ").trim() || undefined;
  const pageText = $("main").text() || $("body").text();
  const cleanedPageText = pageText.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  addAttempt(diagnostics, {
    url,
    finalUrl: response.url,
    strategy: "api",
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    textLength: cleanedPageText.length,
    fallback: true,
    result: response.ok ? "success" : "failed",
  });

  if (!response.ok) throw new Error(`Spain HJ HTML fallback failed HTTP ${response.status}`);
  const decisionDate = parseTitleDate(title);
      return buildSpainTcFallbackRawArticle({
    hjId,
    title,
    text: cleanedPageText,
    html,
    decisionDate,
    fetchMethod: "html_fallback",
    jsonApiError,
  });
}

async function fetchDocumentFallback(hjId: string, jsonApiError: string, diagnostics?: CrawlerDiagnosticsCollector, hooks?: CrawlerExecutionHooks) {
  const url = spainTcDocumentUrl(hjId);
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream,*/*",
      "Accept-Language": "es,en;q=0.8,ko;q=0.5",
    },
  }, hooks);
  const buffer = Buffer.from(await response.arrayBuffer());
  await checkpointCrawlerExecution(hooks);
  const text = response.ok ? textFromDocx(buffer, hooks) : "";
  addAttempt(diagnostics, {
    url,
    finalUrl: response.url,
    strategy: "api",
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    textLength: text.length,
    fallback: true,
    result: response.ok ? "success" : "failed",
  });

  if (!response.ok) throw new Error(`Spain HJ document fallback failed HTTP ${response.status}`);
  return buildSpainTcFallbackRawArticle({
    hjId,
    title: `Resolución HJ ${hjId}`,
    text,
    fetchMethod: "document_fallback",
    jsonApiError,
  });
}

async function fetchRawByHjId(
  hjId: string,
  options: CrawlerExecutionHooks & {
    diagnostics?: CrawlerDiagnosticsCollector;
    listTitle?: string;
    htmlTitleDate?: string;
  } = {},
) {
  await checkpointCrawlerExecution(options);
  try {
    const { payload, url } = await fetchJsonForHjId(hjId, options.diagnostics, options);
    return buildSpainTcRawArticleFromJson({
      ...payload,
      ID: payload.ID ?? hjId,
    }, {
      jsonApiUrl: url,
      htmlTitle: options.listTitle,
      htmlTitleDate: options.htmlTitleDate,
      fetchMethod: "json_api",
      parseConfidence: "high",
    });
  } catch (jsonError) {
    if (options.signal?.aborted) throw options.signal.reason;
    const jsonApiError = errorMessage(jsonError);
    try {
      return await fetchHtmlFallback(hjId, jsonApiError, options.diagnostics, options);
    } catch (htmlError) {
      if (options.signal?.aborted) throw options.signal.reason;
      addAttempt(options.diagnostics, {
        url: canonicalSpainTcUrl(hjId),
        strategy: "api",
        fallback: true,
        result: "failed",
        errorCode: htmlError instanceof Error ? htmlError.name : "Error",
        errorMessage: errorMessage(htmlError),
      });
      return fetchDocumentFallback(hjId, jsonApiError, options.diagnostics, options);
    }
  }
}

async function createSearchSession(diagnostics?: CrawlerDiagnosticsCollector, hooks?: CrawlerExecutionHooks): Promise<SearchSession> {
  let lastError: string | undefined;
  for (const indexPath of SEARCH_INDEX_PATHS) {
    await checkpointCrawlerExecution(hooks);
    const indexUrl = pathUrl(indexPath);
    try {
      const cookies = new Map<string, string>();
      const response = await fetchWithTimeout(indexUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es,en;q=0.8,ko;q=0.5",
        },
      }, hooks);
      mergeSetCookies(cookies, getSetCookies(response.headers));
      const html = await response.text();
      await checkpointCrawlerExecution(hooks);
      const token = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)?.[1];
      addAttempt(diagnostics, {
        url: indexUrl,
        finalUrl: response.url,
        strategy: "api",
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        selectorMatched: Boolean(token),
        htmlLength: html.length,
        result: response.ok && token ? "success" : "failed",
      });
      if (!response.ok || !token) {
        lastError = `Spain HJ search index did not return a token at ${indexUrl}`;
        continue;
      }

      const prefix = indexPath.startsWith("/HJ/") ? "/HJ" : "";
      return {
        indexUrl,
        ajaxUrl: pathUrl(`${prefix}/es/Busqueda/BuscarAjax`),
        listUrl: pathUrl(`${prefix}/es/Resolucion/List`),
        token,
        cookies,
      };
    } catch (error) {
      if (hooks?.signal?.aborted) throw hooks.signal.reason;
      lastError = errorMessage(error);
      addAttempt(diagnostics, {
        url: indexUrl,
        strategy: "api",
        result: "failed",
        errorCode: error instanceof Error ? error.name : "Error",
        errorMessage: lastError,
      });
    }
  }
  throw new Error(lastError ?? "Spain HJ search index failed.");
}

async function submitSearch(
  session: SearchSession,
  params: { type: SpainResolutionType; year: number; from: string; to: string },
  diagnostics?: CrawlerDiagnosticsCollector,
  hooks?: CrawlerExecutionHooks,
) {
  const body = new URLSearchParams({
    __RequestVerificationToken: session.token,
    TIPO_RESOLUCION: params.type,
    NUMERO_RESOLUCION: "",
    ANNO_RESOLUCION: String(params.year),
    BIS_RESOLUCION: "",
    FECHA_DESDE: ddMmYyyy(params.from),
    FECHA_HASTA: ddMmYyyy(params.to),
    BUSQUEDA_LIBRE: "",
  });

  let lastError: string | undefined;
  for (const ajaxUrl of [session.ajaxUrl, ...SEARCH_AJAX_PATHS.map(pathUrl)].filter((url, index, values) => values.indexOf(url) === index)) {
    await checkpointCrawlerExecution(hooks);
    try {
      const response = await fetchWithTimeout(ajaxUrl, {
        method: "POST",
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "es,en;q=0.8,ko;q=0.5",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookieHeader(session.cookies),
          Origin: SPAIN_TC_BASE_URL,
          Referer: session.indexUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      }, hooks);
      mergeSetCookies(session.cookies, getSetCookies(response.headers));
      const text = await response.text();
      await checkpointCrawlerExecution(hooks);
      const success = response.ok && /"success"\s*:\s*"1"/.test(text);
      const noResults = response.ok && /"success"\s*:\s*"0"/.test(text) && /No se han encontrado resultados/i.test(text);
      addAttempt(diagnostics, {
        url: ajaxUrl,
        strategy: "api",
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        textLength: text.length,
        discoveredCount: noResults ? 0 : undefined,
        result: success || noResults ? "success" : "failed",
        errorMessage: success || noResults ? undefined : text.slice(0, 200),
      });
      if (success) return true;
      if (noResults) return false;
      lastError = `BuscarAjax failed for ${params.type} ${params.year}: ${text.slice(0, 200)}`;
    } catch (error) {
      if (hooks?.signal?.aborted) throw hooks.signal.reason;
      lastError = errorMessage(error);
      addAttempt(diagnostics, {
        url: ajaxUrl,
        strategy: "api",
        result: "failed",
        errorCode: error instanceof Error ? error.name : "Error",
        errorMessage: lastError,
      });
    }
  }
  throw new Error(lastError ?? `BuscarAjax failed for ${params.type} ${params.year}`);
}

async function fetchListPage(
  session: SearchSession,
  page: number,
  diagnostics?: CrawlerDiagnosticsCollector,
  hooks?: CrawlerExecutionHooks,
) {
  const candidates = [session.listUrl, ...LIST_PATHS.map(pathUrl)]
    .filter((url, index, values) => values.indexOf(url) === index)
    .map((url) => `${url}?page=${page}`);
  let lastError: string | undefined;

  for (const url of candidates) {
    await checkpointCrawlerExecution(hooks);
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es,en;q=0.8,ko;q=0.5",
          Cookie: cookieHeader(session.cookies),
          Referer: session.indexUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
      }, hooks);
      mergeSetCookies(session.cookies, getSetCookies(response.headers));
      const html = await response.text();
      await checkpointCrawlerExecution(hooks);
      const items = parseSpainTcListPage(html, hooks);
      addAttempt(diagnostics, {
        url,
        finalUrl: response.url,
        strategy: "api",
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        discoveredCount: items.length,
        htmlLength: html.length,
        result: response.ok ? "success" : "failed",
      });
      if (response.ok && items.length > 0) return items;
      if (response.ok && page > 1) return [];
      lastError = `Spain HJ List page ${page} returned ${items.length} items from ${url}`;
    } catch (error) {
      if (hooks?.signal?.aborted) throw hooks.signal.reason;
      lastError = errorMessage(error);
      addAttempt(diagnostics, {
        url,
        strategy: "api",
        result: "failed",
        errorCode: error instanceof Error ? error.name : "Error",
        errorMessage: lastError,
      });
    }
  }

  if (page > 1) return [];
  throw new Error(lastError ?? `Spain HJ List page ${page} failed.`);
}

export function parseSpainTcListPage(html: string, hooks?: CrawlerExecutionHooks) {
  const $ = load(html);
  const items = new Map<string, string | undefined>();
  $("a[href*='/Resolucion/Show/']").each((_, anchor) => {
    assertCrawlerExecution(hooks);
    const href = $(anchor).attr("href") ?? "";
    const id = href.match(/\/Resolucion\/Show\/(\d+)/i)?.[1];
    if (!id || id === "0" || items.has(id)) return;
    const title = $(anchor).text().replace(/\s+/g, " ").trim() || undefined;
    items.set(id, title);
  });
  return [...items.entries()].map(([id, title]) => ({ id, title }));
}

export async function discoverSpainTcInventory(input: {
  year: number;
  documentType?: SpainResolutionType;
  maxPages?: number;
  diagnostics?: CrawlerDiagnosticsCollector;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  requestGovernor?: CrawlerExecutionHooks["requestGovernor"];
}): Promise<SpainTcInventoryResult> {
  if (!Number.isInteger(input.year) || input.year < 1980 || input.year > 2100) {
    throw new Error("Spain HJ inventory year is invalid.");
  }
  const documentType = input.documentType ?? "SENTENCIA";
  const maxPages = input.maxPages ?? envNumber("SPAIN_BACKFILL_MAX_PAGES", SPAIN_TC_DEFAULT_BACKFILL_MAX_PAGES);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2000) {
    throw new Error("Spain HJ inventory maxPages is invalid.");
  }
  const diagnostics = input.diagnostics ?? createDiagnosticsCollector(SPAIN_TC_SOURCE_KEY);
  const hooks: CrawlerExecutionHooks = {
    signal: input.signal,
    checkpoint: input.checkpoint,
    requestGovernor: input.requestGovernor,
  };
  const from = `${input.year}-01-01`;
  const to = `${input.year}-12-31`;
  const session = await createSearchSession(diagnostics, hooks);
  const hasResults = await submitSearch(session, { type: documentType, year: input.year, from, to }, diagnostics, hooks);
  if (!hasResults) {
    return {
      sourceKey: SPAIN_TC_SOURCE_KEY,
      year: input.year,
      documentType,
      items: [],
      pageCount: 0,
      coverageEvidence: {
        method: "official_hj_search_pagination",
        searchUrl: session.indexUrl,
        scopeFrom: from,
        scopeTo: to,
        documentType,
        exhausted: true,
        pageCount: 0,
      },
    };
  }

  const items = new Map<string, SpainTcInventoryItem>();
  let pageCount = 0;
  let exhausted = false;
  for (let page = 1; page <= maxPages; page += 1) {
    await checkpointCrawlerExecution(hooks);
    const pageItems = await fetchListPage(session, page, diagnostics, hooks);
    if (pageItems.length === 0) {
      exhausted = true;
      break;
    }
    pageCount = page;
    for (const item of pageItems) {
      if (items.has(item.id)) continue;
      const decisionDateHint = parseTitleDate(item.title, input.year) ?? null;
      items.set(item.id, {
        stableItemKey: `hj:${item.id}`,
        sourceRecordId: item.id,
        discoveredUrl: canonicalSpainTcUrl(item.id),
        documentType,
        decisionDateHint,
        title: item.title ?? null,
      });
    }
  }
  if (!exhausted) throw new Error("Spain HJ inventory pagination did not exhaust within maxPages.");

  return {
    sourceKey: SPAIN_TC_SOURCE_KEY,
    year: input.year,
    documentType,
    items: [...items.values()].sort((left, right) => Number(left.sourceRecordId) - Number(right.sourceRecordId)),
    pageCount,
    coverageEvidence: {
      method: "official_hj_search_pagination",
      searchUrl: session.indexUrl,
      scopeFrom: from,
      scopeTo: to,
      documentType,
      exhausted,
      pageCount,
      discoveredCount: items.size,
    },
  };
}

function boundedLimit(options: CrawleeSpiderOptions) {
  const value = Number(options.limit ?? process.env.CRAWLEE_DISCOVER_LIMIT_PER_SOURCE ?? process.env.INGEST_LIMIT_PER_SOURCE ?? 20);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

function dateRangeForOptions(options: CrawleeSpiderOptions) {
  const to = todayDateOnly();
  const configuredRange = Number(options.rangeDays);
  const from = Number.isFinite(configuredRange) && configuredRange > 0
    ? daysAgoDateOnly(Math.min(Math.floor(configuredRange), SPAIN_TC_INGEST_RANGE_CAP_DAYS))
    : SPAIN_TC_BACKFILL_START_DECISION_DATE;
  return { from, to };
}

function maxPagesForRange(from: string) {
  const backfillMode = process.env.SPAIN_BACKFILL_MODE === "true" || compareDateOnly(from, daysAgoDateOnly(SPAIN_TC_DEFAULT_INGEST_RANGE_DAYS)) < 0;
  return backfillMode
    ? envNumber("SPAIN_BACKFILL_MAX_PAGES", SPAIN_TC_DEFAULT_BACKFILL_MAX_PAGES)
    : envNumber("SPAIN_DISCOVERY_MAX_PAGES", SPAIN_TC_DEFAULT_DISCOVERY_MAX_PAGES);
}

function yearsDescending(from: string, to: string) {
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const years: number[] = [];
  for (let year = toYear; year >= fromYear; year -= 1) years.push(year);
  return years;
}

function isRawInRange(raw: RawArticle, from: string, to: string) {
  const metadataDate = typeof raw.metadata?.decisionDate === "string" ? raw.metadata.decisionDate : normalizeSpainDecisionDate(raw.publishedAt);
  return Boolean(metadataDate && compareDateOnly(metadataDate, from) >= 0 && compareDateOnly(metadataDate, to) <= 0);
}

function sortItems(items: CrawleeSpiderItem[]) {
  return [...items].sort((left, right) => {
    const leftDate = typeof left.raw?.metadata?.decisionDate === "string" ? left.raw.metadata.decisionDate : left.raw?.publishedAt ?? left.item.publishedAt ?? "";
    const rightDate = typeof right.raw?.metadata?.decisionDate === "string" ? right.raw.metadata.decisionDate : right.raw?.publishedAt ?? right.item.publishedAt ?? "";
    return rightDate.localeCompare(leftDate);
  });
}

function itemFromRaw(raw: RawArticle): DiscoveredItem {
  return {
    sourceKey: raw.sourceKey,
    url: raw.url,
    canonicalUrl: raw.canonicalUrl,
    title: raw.title,
    publishedAt: raw.publishedAt,
    contentType: raw.contentType,
    metadata: raw.metadata,
  };
}

async function discoverBySearch(options: CrawleeSpiderOptions, diagnostics: CrawlerDiagnosticsCollector) {
  await checkpointCrawlerExecution(options);
  const limit = boundedLimit(options);
  const perTypeLimit = Math.max(1, envNumber("SPAIN_DISCOVERY_LIMIT_PER_TYPE", limit));
  const { from, to } = dateRangeForOptions(options);
  const maxPages = maxPagesForRange(from);
  const stopAfterOldPages = envNumber("SPAIN_DISCOVERY_STOP_AFTER_OLD_PAGES", SPAIN_TC_DEFAULT_STOP_AFTER_OLD_PAGES);
  const session = await createSearchSession(diagnostics, options);
  const results: CrawleeSpiderItem[] = [];
  const seen = new Set<string>();
  let discoveredIds = 0;
  let fallbackParsed = 0;
  let needsReview = 0;
  let sourceTextUnavailable = 0;
  let tailProbed = 0;
  let tailDiscovered = 0;

  for (const type of RESOLUTION_TYPES) {
    await checkpointCrawlerExecution(options);
    let typeCollected = 0;
    for (const year of yearsDescending(from, to)) {
      await checkpointCrawlerExecution(options);
      if (typeCollected >= perTypeLimit) break;
      const hasResults = await submitSearch(session, { type, year, from, to }, diagnostics, options);
      if (!hasResults) continue;
      let oldPageStreak = 0;

      for (let page = 1; page <= maxPages; page += 1) {
        await checkpointCrawlerExecution(options);
        if (typeCollected >= perTypeLimit) break;
        const listItems = await fetchListPage(session, page, diagnostics, options);
        if (listItems.length === 0) break;
        let inRangeOnPage = false;
        let allKnownDatesWereOld = true;

        for (const listItem of listItems) {
          await checkpointCrawlerExecution(options);
          if (typeCollected >= perTypeLimit) break;
          if (seen.has(listItem.id)) continue;
          seen.add(listItem.id);
          discoveredIds += 1;
          const raw = await fetchRawByHjId(listItem.id, {
            diagnostics,
            listTitle: listItem.title,
            htmlTitleDate: parseTitleDate(listItem.title, year),
            signal: options.signal,
            checkpoint: options.checkpoint,
            requestGovernor: options.requestGovernor,
          });
          const decisionDate = typeof raw.metadata?.decisionDate === "string" ? raw.metadata.decisionDate : normalizeSpainDecisionDate(raw.publishedAt);
          if (decisionDate && compareDateOnly(decisionDate, from) >= 0) allKnownDatesWereOld = false;
          if (!isRawInRange(raw, from, to)) continue;
          inRangeOnPage = true;
          if (raw.metadata?.fetchMethod !== "json_api") fallbackParsed += 1;
          if (raw.metadata?.review && typeof raw.metadata.review === "object") needsReview += 1;
          if (raw.metadata?.collection && typeof raw.metadata.collection === "object" && (raw.metadata.collection as { sourceTextAvailable?: unknown }).sourceTextAvailable !== true) {
            sourceTextUnavailable += 1;
          }
          results.push({ item: itemFromRaw(raw), raw });
          typeCollected += 1;
        }

        if (inRangeOnPage) oldPageStreak = 0;
        else if (allKnownDatesWereOld) oldPageStreak += 1;
        if (oldPageStreak >= stopAfterOldPages) break;
      }
    }
  }

  const highestSearchId = Math.max(0, ...[...seen].map((id) => Number(id)).filter(Number.isFinite));
  if (highestSearchId > 0) {
    const tailProbeLimit = envNumber("SPAIN_HJ_TAIL_PROBE_LIMIT", SPAIN_TC_DEFAULT_TAIL_PROBE_LIMIT);
    const emptyStop = Math.max(1, envNumber("SPAIN_HJ_TAIL_PROBE_EMPTY_STOP", SPAIN_TC_DEFAULT_TAIL_PROBE_EMPTY_STOP));
    let emptyStreak = 0;

    for (let offset = 1; offset <= tailProbeLimit && emptyStreak < emptyStop; offset += 1) {
      await checkpointCrawlerExecution(options);
      const hjId = String(highestSearchId + offset);
      tailProbed += 1;
      try {
        const { payload, url } = await fetchJsonForHjId(hjId, diagnostics, options);
        const decisionDate = normalizeSpainDecisionDate(payload.FECHA_REGISTRO);
        const resolutionType = stringValue(payload.TIPO_RESOLUCION);
        if (!decisionDate || !resolutionType) {
          emptyStreak += 1;
          continue;
        }

        emptyStreak = 0;
        if (seen.has(hjId)) continue;
        seen.add(hjId);
        discoveredIds += 1;
        const raw = buildSpainTcRawArticleFromJson({
          ...payload,
          ID: payload.ID ?? hjId,
        }, {
          jsonApiUrl: url,
          fetchMethod: "json_api",
          parseConfidence: "high",
        });
        if (!isRawInRange(raw, from, to)) continue;
        if (raw.metadata?.review && typeof raw.metadata.review === "object") needsReview += 1;
        if (raw.metadata?.collection && typeof raw.metadata.collection === "object" && (raw.metadata.collection as { sourceTextAvailable?: unknown }).sourceTextAvailable !== true) {
          sourceTextUnavailable += 1;
        }
        results.push({ item: itemFromRaw(raw), raw });
        tailDiscovered += 1;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        emptyStreak += 1;
        addAttempt(diagnostics, {
          url: jsonApiUrls(hjId)[0],
          strategy: "api",
          fallback: true,
          optional: true,
          result: "empty",
          errorCode: "SPAIN_HJ_TAIL_PROBE_EMPTY",
          errorMessage: errorMessage(error),
        });
      }
    }
  }

  addAttempt(diagnostics, {
    url: session.listUrl,
    strategy: "api",
    discoveredCount: discoveredIds,
    result: "success",
    errorMessage:
      `Spain HJ diagnostics: dateBasis=FECHA_REGISTRO; datePrecision=date; boeFiltering=false; ` +
      `backfillStart=${SPAIN_TC_BACKFILL_START_DECISION_DATE}; inRange=${results.length}; fallbackParsed=${fallbackParsed}; ` +
      `needsReview=${needsReview}; publishable=${results.filter((entry) => entry.raw?.metadata?.collection && (entry.raw.metadata.collection as { publishable?: unknown }).publishable === true).length}; ` +
      `sourceTextUnavailable=${sourceTextUnavailable}; tailProbed=${tailProbed}; tailDiscovered=${tailDiscovered}.`,
  });

  await checkpointCrawlerExecution(options);
  return sortItems(results).slice(0, limit);
}

async function discoverDetailUrls(options: CrawleeSpiderOptions, diagnostics: CrawlerDiagnosticsCollector) {
  const limit = boundedLimit(options);
  const urls = options.detailUrls ?? [];
  const items: CrawleeSpiderItem[] = [];
  for (const url of urls) {
    await checkpointCrawlerExecution(options);
    if (items.length >= limit) break;
    const hjId = hjIdFromUrl(url);
    if (!hjId) continue;
    const raw = await fetchRawByHjId(hjId, {
      diagnostics,
      signal: options.signal,
      checkpoint: options.checkpoint,
      requestGovernor: options.requestGovernor,
    });
    items.push({ item: itemFromRaw(raw), raw });
  }
  return sortItems(items);
}

export async function runSpainTcSpider(options: CrawleeSpiderOptions = {}): Promise<CrawleeSpiderResult> {
  await checkpointCrawlerExecution(options);
  const diagnostics = options.diagnostics ?? createDiagnosticsCollector(SPAIN_TC_SOURCE_KEY);
  const items = options.detailOnly || options.detailUrls?.length
    ? await discoverDetailUrls(options, diagnostics)
    : await discoverBySearch(options, diagnostics);
  await checkpointCrawlerExecution(options);
  return {
    sourceKey: SPAIN_TC_SOURCE_KEY,
    items,
    diagnostics,
    strategySequence: ["api"],
    usedSeedFallback: false,
  };
}
