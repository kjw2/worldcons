import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { governedBoundedFetch } from "@/lib/crawler/request-governor";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import type { CrawlerDiagnosticsCollector, CrawlerExecutionHooks } from "@/lib/crawler/types";
import { crawlerUserAgent } from "@/lib/crawler/user-agents";
import { franceConseilScope, type FranceConseilDocumentType } from "@/lib/backfill/france-scope";
import type { CaseBackfillEnumerationArtifact } from "@/lib/backfill/types";
import {
  discoverFranceConseilInventory,
  type FranceConseilInventoryResult,
} from "@/lib/crawlee/france-conseil-inventory";

export const DILA_CONSTIT_DIRECTORY_URL = "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/";
export const DILA_CONSTIT_MAX_DIRECTORY_BYTES = 1_048_576;
export const DILA_CONSTIT_MAX_COMPRESSED_BYTES = 33_554_432;
export const DILA_CONSTIT_MAX_EXPANDED_BYTES = 268_435_456;
export const DILA_CONSTIT_MAX_XML_MEMBERS = 20_000;
export const DILA_CONSTIT_MAX_MEMBER_BYTES = 8_388_608;
export const DILA_CONSTIT_MAX_INCREMENTS = 512;

const STOCK_PATTERN = /^Freemium_constit_global_(\d{8})-(\d{6})\.tar\.gz$/;
const INCREMENT_PATTERN = /^CONSTIT_(\d{8})-(\d{6})\.tar\.gz$/;
const LOOKS_LIKE_STOCK_PATTERN = /^Freemium_constit_.*\.tar\.gz$/;
const LOOKS_LIKE_INCREMENT_PATTERN = /^CONSTIT_.*\.tar\.gz$/;
const STOCK_MEMBER_ROOT = "constit/global/CONS/TEXT/";
const DILA_ID_PATTERN = /^CONSTEXT\d{12}$/;
const TARGET_NATURES = new Set(["QPC", "DC"]);
const robotsByOrigin = new Map<string, RobotsResult>();

export interface DilaConstitStock {
  filename: string;
  url: string;
  extractedAt: string;
}

export interface DilaConstitIncrement {
  filename: string;
  url: string;
  extractedAt: string;
}

export interface DilaConstitArchiveListing {
  stock: DilaConstitStock;
  increments: DilaConstitIncrement[];
}

export interface DilaConstitRecord {
  dilaId: string;
  nature: string;
  qualifiedNature: string | null;
  title: string;
  decisionDate: string;
  decisionNumber: string;
  ecli: string | null;
  canonicalUrl: string;
  conseilRecordId: string;
  archiveMemberPath: string;
}

export interface DilaConstitArchiveProvenance {
  kind: "stock" | "increment";
  filename: string;
  url: string;
  extractedAt: string;
  lastModified: string | null;
  etag: string | null;
  contentLength: number;
  sha256: string;
  order: number;
}

export interface DilaConstitScopedRecord {
  record: DilaConstitRecord;
  provenance: DilaConstitArchiveProvenance;
}

export interface FranceDilaInventoryItem {
  stableItemKey: string;
  sourceRecordId: string;
  discoveredUrl: string;
  documentType: FranceConseilDocumentType;
  decisionDateHint: string;
  title: string;
  dilaId: string;
  ecli: string | null;
  decisionNumber: string;
  archiveMemberPath: string;
  inventoryMetadata: Record<string, unknown>;
}

export interface FranceDilaInventoryResult {
  sourceKey: "fr-conseil-constitutionnel";
  year: number;
  documentType: FranceConseilDocumentType;
  items: FranceDilaInventoryItem[];
  pageCount: number;
  expectedCount: number;
  expectedCountBasis: string;
  coverageEvidence: Record<string, unknown>;
  enumerationArtifacts: CaseBackfillEnumerationArtifact[];
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function cleanText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function validDateOnly(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validExtractionTimestamp(date: string, time: string) {
  const value = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error("case_backfill.france_dila_stock_timestamp_invalid");
  }
  return parsed.toISOString();
}

function resolveConstitArchiveHref(href: string, directory: URL) {
  let url: URL;
  try {
    url = new URL(href, directory);
  } catch {
    return null;
  }
  const filename = url.pathname.split("/").pop() ?? "";
  const isStock = STOCK_PATTERN.test(filename);
  const isIncrement = INCREMENT_PATTERN.test(filename);
  const looksLikeStock = LOOKS_LIKE_STOCK_PATTERN.test(filename);
  const looksLikeIncrement = LOOKS_LIKE_INCREMENT_PATTERN.test(filename);
  if (!isStock && !isIncrement && !looksLikeStock && !looksLikeIncrement) return null;
  if (
    url.protocol !== "https:"
    || url.origin !== directory.origin
    || url.pathname !== `${directory.pathname}${filename}`
    || url.search
    || url.hash
  ) {
    throw new Error(
      isIncrement || looksLikeIncrement
        ? "case_backfill.france_dila_increment_url_invalid"
        : "case_backfill.france_dila_stock_url_invalid",
    );
  }
  if (looksLikeStock && !isStock) throw new Error("case_backfill.france_dila_stock_name_invalid");
  if (looksLikeIncrement && !isIncrement) throw new Error("case_backfill.france_dila_increment_name_invalid");
  return { filename, url };
}

/**
 * Parses the DILA CONSTIT directory into exactly one latest global stock plus
 * every same-origin increment archive that was produced after that stock. The
 * approved immutable policy requires the ordered increment overlay, so the
 * increments are sorted ascending by their official extraction timestamp and
 * bounded. Non-HTTPS, cross-origin, redirecting, duplicate, or malformed
 * candidates fail closed instead of being dropped silently.
 */
export function parseDilaConstitArchiveListing(
  html: string,
  directoryUrl = DILA_CONSTIT_DIRECTORY_URL,
): DilaConstitArchiveListing {
  const directory = new URL(directoryUrl);
  const $ = load(html);
  const stocks = new Map<string, DilaConstitStock>();
  const increments = new Map<string, DilaConstitIncrement>();
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href")?.trim();
    if (!href) return;
    const resolved = resolveConstitArchiveHref(href, directory);
    if (!resolved) return;
    const { filename, url } = resolved;
    const stockMatch = filename.match(STOCK_PATTERN);
    const incrementMatch = filename.match(INCREMENT_PATTERN);
    if (stockMatch) {
      const candidate = {
        filename,
        url: url.toString(),
        extractedAt: validExtractionTimestamp(stockMatch[1], stockMatch[2]),
      };
      const existing = stocks.get(filename);
      if (existing && existing.url !== candidate.url) {
        throw new Error("case_backfill.france_dila_stock_ambiguous");
      }
      stocks.set(filename, candidate);
      return;
    }
    if (incrementMatch) {
      const candidate = {
        filename,
        url: url.toString(),
        extractedAt: validExtractionTimestamp(incrementMatch[1], incrementMatch[2]),
      };
      const existing = increments.get(filename);
      if (existing && existing.url !== candidate.url) {
        throw new Error("case_backfill.france_dila_increment_ambiguous");
      }
      increments.set(filename, candidate);
    }
  });
  if (stocks.size === 0) throw new Error("case_backfill.france_dila_stock_missing");
  const stock = [...stocks.values()].sort((left, right) => right.filename.localeCompare(left.filename))[0];
  const orderedIncrements = [...increments.values()]
    .filter((increment) => increment.extractedAt > stock.extractedAt)
    .sort((left, right) =>
      left.extractedAt.localeCompare(right.extractedAt) || left.filename.localeCompare(right.filename));
  if (orderedIncrements.length > DILA_CONSTIT_MAX_INCREMENTS) {
    throw new Error("case_backfill.france_dila_increment_limit");
  }
  return { stock, increments: orderedIncrements };
}

export function parseDilaConstitDirectory(html: string, directoryUrl = DILA_CONSTIT_DIRECTORY_URL) {
  return parseDilaConstitArchiveListing(html, directoryUrl).stock;
}

function tarText(block: Buffer, start: number, length: number) {
  const zero = block.indexOf(0, start);
  return block.subarray(start, zero >= start && zero < start + length ? zero : start + length).toString("utf8").trim();
}

function tarOctal(block: Buffer, start: number, length: number) {
  const value = tarText(block, start, length).replace(/\0/g, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("case_backfill.france_dila_tar_number_invalid");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("case_backfill.france_dila_tar_number_invalid");
  return parsed;
}

function tarChecksum(header: Buffer) {
  const expected = tarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error("case_backfill.france_dila_tar_checksum_invalid");
}

function safeMemberPath(header: Buffer) {
  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (
    !path
    || path.length > 300
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("case_backfill.france_dila_tar_path_invalid");
  }
  return path;
}

function requiredXmlText($: ReturnType<typeof load>, selector: string, errorCode: string) {
  const value = cleanText($(selector).first().text());
  if (!value) throw new Error(errorCode);
  return value;
}

function parseDilaConstitOverlayIdentity(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("case_backfill.france_dila_xml_entity_forbidden");
  const $ = load(xml, { xmlMode: true });
  if ($("TEXTE_JURI_CONSTIT").length !== 1) throw new Error("case_backfill.france_dila_xml_root_invalid");
  const dilaId = requiredXmlText($, "META_COMMUN > ID", "case_backfill.france_dila_id_missing");
  const origin = requiredXmlText($, "META_COMMUN > ORIGINE", "case_backfill.france_dila_origin_missing");
  if (!DILA_ID_PATTERN.test(dilaId) || origin !== "CONSTIT") {
    throw new Error("case_backfill.france_dila_identity_invalid");
  }
  return dilaId;
}

function canonicalConseilUrl(value: string, decisionDate: string, documentType: FranceConseilDocumentType) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("case_backfill.france_dila_authority_url_invalid");
  }
  url.protocol = "https:";
  url.port = "";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const match = url.pathname.match(/^\/decision\/(\d{4})\/([^/]+)\.(?:html?|htm)$/i);
  if (
    url.hostname !== "www.conseil-constitutionnel.fr"
    || !match
    || match[1] !== decisionDate.slice(0, 4)
    || !match[2].toUpperCase().endsWith(documentType)
  ) {
    throw new Error("case_backfill.france_dila_authority_url_invalid");
  }
  return { canonicalUrl: url.toString(), conseilRecordId: match[2] };
}

export function parseDilaConstitXml(
  xml: string,
  archiveMemberPath: string,
  scope?: { year: number; documentType: FranceConseilDocumentType },
): DilaConstitRecord | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("case_backfill.france_dila_xml_entity_forbidden");
  const $ = load(xml, { xmlMode: true });
  if ($("TEXTE_JURI_CONSTIT").length !== 1) throw new Error("case_backfill.france_dila_xml_root_invalid");
  const dilaId = requiredXmlText($, "META_COMMUN > ID", "case_backfill.france_dila_id_missing");
  const origin = requiredXmlText($, "META_COMMUN > ORIGINE", "case_backfill.france_dila_origin_missing");
  const nature = requiredXmlText($, "META_COMMUN > NATURE", "case_backfill.france_dila_nature_missing").toUpperCase();
  const decisionDate = cleanText($("META_JURI > DATE_DEC").first().text());
  if (!DILA_ID_PATTERN.test(dilaId) || origin !== "CONSTIT") {
    throw new Error("case_backfill.france_dila_identity_invalid");
  }
  if (scope) {
    if (nature !== scope.documentType || !decisionDate.startsWith(`${scope.year}-`)) return null;
  } else if (!TARGET_NATURES.has(nature)) {
    return null;
  }
  if (!validDateOnly(decisionDate)) throw new Error("case_backfill.france_dila_decision_date_invalid");
  if (requiredXmlText($, "META_JURI > JURIDICTION", "case_backfill.france_dila_jurisdiction_missing") !== "Conseil constitutionnel") {
    throw new Error("case_backfill.france_dila_jurisdiction_invalid");
  }
  const title = requiredXmlText($, "META_JURI > TITRE", "case_backfill.france_dila_title_missing");
  const decisionNumber = requiredXmlText($, "META_JURI > NUMERO", "case_backfill.france_dila_number_missing");
  const authority = canonicalConseilUrl(
    requiredXmlText($, "META_JURI_CONSTIT > URL_CC", "case_backfill.france_dila_authority_url_missing"),
    decisionDate,
    nature as FranceConseilDocumentType,
  );
  const ecli = cleanText($("META_JURI_CONSTIT > ECLI").first().text()) || null;
  if (ecli && !/^ECLI:FR:CC:/i.test(ecli)) throw new Error("case_backfill.france_dila_ecli_invalid");
  return {
    dilaId,
    nature,
    qualifiedNature: cleanText($("META_JURI_CONSTIT > NATURE_QUALIFIEE").first().text()) || null,
    title,
    decisionDate,
    decisionNumber,
    ecli,
    ...authority,
    archiveMemberPath,
  };
}

interface DilaConstitArchiveRoot {
  kind: "stock" | "increment";
  prefix?: string;
}

function canonicalMemberPath(path: string, root: DilaConstitArchiveRoot) {
  if (root.kind === "stock") return path.startsWith(STOCK_MEMBER_ROOT) ? path : null;
  const prefix = `${root.prefix}/`;
  if (!path.startsWith(prefix)) return null;
  const canonical = path.slice(prefix.length);
  return canonical.startsWith(STOCK_MEMBER_ROOT) ? canonical : null;
}

function parseDilaConstitTar(
  compressed: Uint8Array,
  root: DilaConstitArchiveRoot,
  scope?: { year: number; documentType: FranceConseilDocumentType },
) {
  if (compressed.byteLength < 1 || compressed.byteLength > DILA_CONSTIT_MAX_COMPRESSED_BYTES) {
    throw new Error("case_backfill.france_dila_archive_size_invalid");
  }
  let expanded: Buffer;
  try {
    expanded = zlib.gunzipSync(compressed, { maxOutputLength: DILA_CONSTIT_MAX_EXPANDED_BYTES });
  } catch {
    throw new Error("case_backfill.france_dila_archive_decompress_failed");
  }
  const records = new Map<string, DilaConstitRecord>();
  const seenDilaIds = new Set<string>();
  const memberPaths = new Set<string>();
  let xmlMemberCount = 0;
  let offset = 0;
  let terminated = false;

  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 <= expanded.length
        && expanded.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)
        && expanded.subarray(offset).every((byte) => byte === 0)
      ) terminated = true;
      break;
    }
    tarChecksum(header);
    const path = safeMemberPath(header);
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > expanded.length) throw new Error("case_backfill.france_dila_tar_truncated");
    if (memberPaths.has(path)) throw new Error("case_backfill.france_dila_tar_duplicate_path");
    memberPaths.add(path);

    if (type === "5") {
      if (!path.endsWith("/")) throw new Error("case_backfill.france_dila_tar_directory_invalid");
    } else if (type === "0") {
      const canonicalPath = canonicalMemberPath(path, root);
      if (!canonicalPath || !path.endsWith(".xml")) {
        throw new Error("case_backfill.france_dila_tar_member_invalid");
      }
      if (size < 1 || size > DILA_CONSTIT_MAX_MEMBER_BYTES) {
        throw new Error("case_backfill.france_dila_tar_member_size_invalid");
      }
      xmlMemberCount += 1;
      if (xmlMemberCount > DILA_CONSTIT_MAX_XML_MEMBERS) {
        throw new Error("case_backfill.france_dila_tar_member_limit");
      }
      let xml: string;
      try {
        xml = new TextDecoder("utf-8", { fatal: true }).decode(expanded.subarray(dataStart, dataEnd));
      } catch {
        throw new Error("case_backfill.france_dila_xml_encoding_invalid");
      }
      if (root.kind === "increment" && !scope) {
        const overlayKey = parseDilaConstitOverlayIdentity(xml).toLowerCase();
        if (seenDilaIds.has(overlayKey)) throw new Error("case_backfill.france_dila_record_duplicate");
        seenDilaIds.add(overlayKey);
      }
      const record = parseDilaConstitXml(xml, canonicalPath, scope);
      if (record) {
        const key = record.dilaId.toLowerCase();
        if (records.has(key)) throw new Error("case_backfill.france_dila_record_duplicate");
        records.set(key, record);
      }
    } else {
      throw new Error("case_backfill.france_dila_tar_entry_type_forbidden");
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated || xmlMemberCount === 0) throw new Error("case_backfill.france_dila_tar_terminator_missing");
  return {
    expandedBytes: expanded.byteLength,
    xmlMemberCount,
    records: [...records.values()].sort((left, right) => left.dilaId.localeCompare(right.dilaId)),
    seenDilaIds: [...seenDilaIds].sort(),
  };
}

export function parseDilaConstitArchive(
  compressed: Uint8Array,
  scope: { year: number; documentType: FranceConseilDocumentType },
) {
  const parsed = parseDilaConstitTar(compressed, { kind: "stock" }, scope);
  return {
    expandedBytes: parsed.expandedBytes,
    xmlMemberCount: parsed.xmlMemberCount,
    records: parsed.records,
  };
}

/**
 * Applies the global stock followed by every ordered increment archive with
 * deterministic last-write-by-DILA-ID semantics, then filters to the requested
 * year/nature scope. The approved policy defines the DILA ID itself as the
 * stable inventory identity. Therefore two effective DILA IDs pointing at the
 * same Conseil decision are ambiguous and fail closed; this layer must not
 * invent a winner or silently collapse one official DILA identity into another.
 */
export function overlayDilaConstitRecords(input: {
  stock: { provenance: DilaConstitArchiveProvenance; records: DilaConstitRecord[] };
  increments: Array<{
    provenance: DilaConstitArchiveProvenance;
    records: DilaConstitRecord[];
    seenDilaIds?: string[];
  }>;
  scope: { year: number; documentType: FranceConseilDocumentType };
}): {
  records: DilaConstitScopedRecord[];
  totalRecords: number;
} {
  const effective = new Map<string, { record: DilaConstitRecord; provenance: DilaConstitArchiveProvenance }>();
  for (const record of input.stock.records) {
    effective.set(record.dilaId.toLowerCase(), { record, provenance: input.stock.provenance });
  }
  for (const increment of input.increments) {
    for (const dilaId of increment.seenDilaIds ?? []) effective.delete(dilaId.toLowerCase());
    for (const record of increment.records) {
      effective.set(record.dilaId.toLowerCase(), { record, provenance: increment.provenance });
    }
  }

  const scoped = [...effective.values()].filter(({ record }) =>
    record.nature === input.scope.documentType && record.decisionDate.startsWith(`${input.scope.year}-`));

  const groups = new Map<string, Array<{ record: DilaConstitRecord; provenance: DilaConstitArchiveProvenance }>>();
  for (const entry of scoped) {
    const key = entry.record.conseilRecordId.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  const records: DilaConstitScopedRecord[] = [];
  for (const [conseilKey, entries] of groups) {
    if (entries.length === 1) {
      records.push(entries[0]);
      continue;
    }
    const dilaIds = entries.map((entry) => entry.record.dilaId).sort();
    throw new Error(
      `case_backfill.france_dila_conseil_identity_duplicate:${conseilKey}:dila=${dilaIds.join(",")}`,
    );
  }

  records.sort((left, right) => left.record.dilaId.localeCompare(right.record.dilaId));
  return { records, totalRecords: effective.size };
}

async function fetchDila(
  url: string,
  maxBytes: number,
  diagnostics: CrawlerDiagnosticsCollector,
  hooks: CrawlerExecutionHooks,
) {
  await checkpointCrawlerExecution(hooks);
  const origin = new URL(url).origin;
  let robots = robotsByOrigin.get(origin);
  if (!robots) {
    robots = await checkRobotsAllowed(url, hooks);
    robotsByOrigin.set(origin, robots);
  }
  if (!robots.allowed) throw new Error("case_backfill.france_dila_robots_disallowed");
  await respectRateLimit(url, robotsDelayMs(robots, envNumber("FRANCE_REQUEST_DELAY_MS", 3000)), hooks.signal);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), envNumber("FRANCE_TIMEOUT_MS", 90_000));
  const signals = [hooks.signal, timeoutController.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  let response: Response;
  try {
    response = await governedBoundedFetch(url, {
      headers: { Accept: "text/html,application/x-gzip,application/gzip;q=0.9,*/*;q=0.5", "User-Agent": crawlerUserAgent() },
      redirect: "error",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    }, maxBytes, hooks);
  } finally {
    clearTimeout(timeout);
  }
  addDiagnosticAttempt(diagnostics, {
    sourceKey: "fr-conseil-constitutionnel",
    url,
    finalUrl: response.url,
    strategy: "api",
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    result: response.ok ? "success" : "failed",
  });
  if (!response.ok || response.url !== url) throw new Error("case_backfill.france_dila_fetch_invalid");
  return response;
}

function archiveProvenance(
  archive: { filename: string; url: string; extractedAt: string },
  response: Response,
  compressed: Uint8Array,
  order: number,
  kind: "stock" | "increment",
): DilaConstitArchiveProvenance {
  const contentLength = Number(response.headers.get("content-length"));
  return {
    kind,
    filename: archive.filename,
    url: archive.url,
    extractedAt: archive.extractedAt,
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
    contentLength: Number.isFinite(contentLength) ? contentLength : compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    order,
  };
}

function provenanceJson(provenance: DilaConstitArchiveProvenance) {
  return {
    kind: provenance.kind,
    filename: provenance.filename,
    url: provenance.url,
    extractedAt: provenance.extractedAt,
    lastModified: provenance.lastModified,
    etag: provenance.etag,
    contentLength: provenance.contentLength,
    sha256: provenance.sha256,
    appliedOrder: provenance.order,
  };
}

function archiveRecordManifestHash(records: DilaConstitRecord[]) {
  const manifest = [...records]
    .sort((left, right) => left.dilaId.localeCompare(right.dilaId))
    .map((record) => JSON.stringify([
      record.dilaId,
      record.nature,
      record.decisionDate,
      record.decisionNumber,
      record.conseilRecordId,
    ]))
    .join("\n");
  return createHash("sha256").update(manifest).digest("hex");
}

function archiveDecisionDateBounds(records: DilaConstitRecord[]) {
  const dates = records.map((record) => record.decisionDate).filter(Boolean).sort();
  return {
    newestDecisionDate: dates.at(-1) ?? null,
    oldestDecisionDate: dates[0] ?? null,
  };
}

function archiveEnumerationArtifact(input: {
  provenance: DilaConstitArchiveProvenance;
  records: DilaConstitRecord[];
  expandedBytes: number;
  xmlMemberCount: number;
}): CaseBackfillEnumerationArtifact {
  const bounds = archiveDecisionDateBounds(input.records);
  return {
    providerKey: "echanges.dila.gouv.fr",
    artifactKind: "crosscheck",
    sequenceNumber: input.provenance.order + 1,
    requestUrl: input.provenance.url,
    responseHash: input.provenance.sha256,
    recordManifestHash: archiveRecordManifestHash(input.records),
    recordCount: input.records.length,
    newestDecisionDate: bounds.newestDecisionDate,
    oldestDecisionDate: bounds.oldestDecisionDate,
    observedLastPage: null,
    safeDetails: {
      archiveKind: input.provenance.kind,
      filename: input.provenance.filename,
      extractedAt: input.provenance.extractedAt,
      lastModified: input.provenance.lastModified,
      etag: input.provenance.etag,
      contentLength: input.provenance.contentLength,
      expandedBytes: input.expandedBytes,
      xmlMemberCount: input.xmlMemberCount,
      appliedOrder: input.provenance.order,
    },
  };
}

function incrementMemberPrefix(filename: string) {
  const match = filename.match(INCREMENT_PATTERN);
  if (!match) throw new Error("case_backfill.france_dila_increment_name_invalid");
  return `${match[1]}-${match[2]}`;
}

/**
 * Fail-closed reconciliation of the DILA decision identity set against the
 * official Conseil annual/type facet. A mismatch names the exact missing or
 * surplus Conseil identities instead of degrading to a single source, and the
 * count is re-checked as defense in depth.
 */
export function reconcileFranceDilaConseilIdentity(
  dilaItems: FranceDilaInventoryItem[],
  conseil: Pick<FranceConseilInventoryResult, "items" | "expectedCount">,
) {
  const dila = new Set(dilaItems.map((item) => item.sourceRecordId.toLowerCase()));
  const web = new Set(conseil.items.map((item) => item.sourceRecordId.toLowerCase()));
  const dilaOnly = [...dila].filter((id) => !web.has(id)).sort();
  const webOnly = [...web].filter((id) => !dila.has(id)).sort();
  if (dilaOnly.length || webOnly.length) {
    throw new Error(`case_backfill.france_inventory_identity_mismatch:dila=${dilaOnly.slice(0, 5).join(",")};web=${webOnly.slice(0, 5).join(",")}`);
  }
  if (conseil.expectedCount !== dilaItems.length) {
    throw new Error("case_backfill.france_inventory_count_mismatch");
  }
}

export async function discoverFranceDilaConstitInventory(input: {
  year: number;
  documentType: FranceConseilDocumentType;
  currentYear?: number;
  diagnostics?: CrawlerDiagnosticsCollector;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  requestGovernor?: CrawlerExecutionHooks["requestGovernor"];
  discoverConseilInventory?: typeof discoverFranceConseilInventory;
}): Promise<FranceDilaInventoryResult> {
  const scope = franceConseilScope(input.year, input.documentType, input.currentYear);
  const diagnostics = input.diagnostics ?? createDiagnosticsCollector("fr-conseil-constitutionnel");
  const hooks: CrawlerExecutionHooks = {
    signal: input.signal,
    checkpoint: input.checkpoint,
    requestGovernor: input.requestGovernor,
  };
  assertCrawlerExecution(hooks);

  const directoryResponse = await fetchDila(DILA_CONSTIT_DIRECTORY_URL, DILA_CONSTIT_MAX_DIRECTORY_BYTES, diagnostics, hooks);
  const listing = parseDilaConstitArchiveListing(await directoryResponse.text());

  const stockResponse = await fetchDila(listing.stock.url, DILA_CONSTIT_MAX_COMPRESSED_BYTES, diagnostics, hooks);
  const stockCompressed = new Uint8Array(await stockResponse.arrayBuffer());
  const stockProvenance = archiveProvenance(listing.stock, stockResponse, stockCompressed, 0, "stock");
  const parsedStock = parseDilaConstitTar(stockCompressed, { kind: "stock" });
  let cumulativeXmlMembers = parsedStock.xmlMemberCount;

  const appliedIncrements: Array<{
    provenance: DilaConstitArchiveProvenance;
    records: DilaConstitRecord[];
    seenDilaIds: string[];
    expandedBytes: number;
    xmlMemberCount: number;
  }> = [];
  for (const increment of listing.increments) {
    const response = await fetchDila(increment.url, DILA_CONSTIT_MAX_COMPRESSED_BYTES, diagnostics, hooks);
    const compressed = new Uint8Array(await response.arrayBuffer());
    const provenance = archiveProvenance(increment, response, compressed, appliedIncrements.length + 1, "increment");
    const parsed = parseDilaConstitTar(
      compressed,
      { kind: "increment", prefix: incrementMemberPrefix(increment.filename) },
    );
    cumulativeXmlMembers += parsed.xmlMemberCount;
    if (cumulativeXmlMembers > DILA_CONSTIT_MAX_XML_MEMBERS) {
      throw new Error("case_backfill.france_dila_tar_member_limit");
    }
    appliedIncrements.push({
      provenance,
      records: parsed.records,
      seenDilaIds: parsed.seenDilaIds,
      expandedBytes: parsed.expandedBytes,
      xmlMemberCount: parsed.xmlMemberCount,
    });
  }

  const overlay = overlayDilaConstitRecords({
    stock: { provenance: stockProvenance, records: parsedStock.records },
    increments: appliedIncrements.map((increment) => ({
      provenance: increment.provenance,
      records: increment.records,
      seenDilaIds: increment.seenDilaIds,
    })),
    scope: { year: scope.year, documentType: scope.documentType },
  });
  const enumerationArtifacts: CaseBackfillEnumerationArtifact[] = [
    archiveEnumerationArtifact({
      provenance: stockProvenance,
      records: parsedStock.records,
      expandedBytes: parsedStock.expandedBytes,
      xmlMemberCount: parsedStock.xmlMemberCount,
    }),
    ...appliedIncrements.map((increment) => archiveEnumerationArtifact({
      provenance: increment.provenance,
      records: increment.records,
      expandedBytes: increment.expandedBytes,
      xmlMemberCount: increment.xmlMemberCount,
    })),
  ];
  const incrementChainHash = createHash("sha256").update(JSON.stringify(
    appliedIncrements.map((increment) => provenanceJson(increment.provenance)),
  )).digest("hex");

  const license = {
    id: "licence-ouverte-2.0",
    url: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
    attribution: "DILA",
  };
  const items: FranceDilaInventoryItem[] = overlay.records.map(({ record, provenance }) => {
    const incremented = provenance.kind === "increment";
    return {
      stableItemKey: `constit:${record.dilaId.toLowerCase()}`,
      sourceRecordId: record.conseilRecordId,
      discoveredUrl: record.canonicalUrl,
      documentType: scope.documentType,
      decisionDateHint: record.decisionDate,
      title: record.title,
      dilaId: record.dilaId,
      ecli: record.ecli,
      decisionNumber: record.decisionNumber,
      archiveMemberPath: record.archiveMemberPath,
      inventoryMetadata: {
        dila: {
          id: record.dilaId,
          nature: record.nature,
          ecli: record.ecli,
          decisionNumber: record.decisionNumber,
          qualifiedNature: record.qualifiedNature,
          archiveMemberPath: record.archiveMemberPath,
        },
        stock: {
          filename: stockProvenance.filename,
          url: stockProvenance.url,
          extractedAt: stockProvenance.extractedAt,
          lastModified: stockProvenance.lastModified,
          etag: stockProvenance.etag,
          contentLength: stockProvenance.contentLength,
          sha256: stockProvenance.sha256,
        },
        ...(incremented ? { increment: provenanceJson(provenance) } : {}),
        license,
      },
    };
  });

  const conseil = await (input.discoverConseilInventory ?? discoverFranceConseilInventory)({
    year: scope.year,
    documentType: scope.documentType,
    currentYear: input.currentYear,
    diagnostics,
    signal: input.signal,
    checkpoint: input.checkpoint,
    requestGovernor: input.requestGovernor,
  });
  reconcileFranceDilaConseilIdentity(items, conseil);

  const coverageEvidence = {
    method: "official_dila_constit_stock_with_conseil_identity_crosscheck",
    scopeFrom: scope.scopeFrom,
    scopeTo: scope.scopeTo,
    documentType: scope.documentType,
    expectedCount: items.length,
    expectedCountBasis: "official_dila_stock_and_conseil_facet_exact_identity_set",
    dila: {
      directoryUrl: DILA_CONSTIT_DIRECTORY_URL,
      stockFilename: stockProvenance.filename,
      stockUrl: stockProvenance.url,
      stockExtractedAt: stockProvenance.extractedAt,
      lastModified: stockProvenance.lastModified,
      etag: stockProvenance.etag,
      contentLength: stockProvenance.contentLength,
      compressedBytes: stockCompressed.byteLength,
      expandedBytes: parsedStock.expandedBytes,
      archiveSha256: stockProvenance.sha256,
      xmlMemberCount: parsedStock.xmlMemberCount,
      scopeCount: items.length,
      overlay: {
        appliedIncrementCount: appliedIncrements.length,
        cumulativeXmlMembers,
        targetRecordCount: overlay.totalRecords,
        enumerationArtifactCount: enumerationArtifacts.length,
        incrementChainHash,
        firstIncrementFilename: appliedIncrements[0]?.provenance.filename ?? null,
        lastIncrementFilename: appliedIncrements.at(-1)?.provenance.filename ?? null,
      },
    },
    conseil: {
      expectedCount: conseil.expectedCount,
      pageCount: conseil.pageCount,
      exactIdentitySetMatch: true,
      evidence: conseil.coverageEvidence,
    },
    qpc360Crosscheck: "not_in_primary_manifest",
  };
  if (Buffer.byteLength(JSON.stringify(coverageEvidence), "utf8") > 16384) {
    throw new Error("case_backfill.france_dila_coverage_evidence_too_large");
  }

  return {
    sourceKey: "fr-conseil-constitutionnel",
    year: scope.year,
    documentType: scope.documentType,
    items,
    pageCount: conseil.pageCount,
    expectedCount: items.length,
    expectedCountBasis: "official_dila_stock_and_conseil_facet_exact_identity_set",
    coverageEvidence,
    enumerationArtifacts,
  };
}
