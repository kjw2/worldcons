export type SpainDateCheckSource =
  | "FECHA_REGISTRO"
  | "FECHA_FIRMA"
  | "ANNO_RESOLUCION"
  | "detail_heading"
  | "resolution_identity"
  | "ECLI"
  | "BOE"
  | "html_title_date";

export interface SpainDateCheck {
  source: SpainDateCheckSource;
  value?: string;
  matches: boolean;
}

export interface SpainDecisionDateValidation {
  ok: boolean;
  decisionDate?: string;
  checks: SpainDateCheck[];
  warnings: string[];
  reason?: string;
}

export type SpainResolutionType = "SENTENCIA" | "AUTO" | "DECLARACION";

export interface SpainDetailHeading {
  /** Full heading text with the BOE publication suffix removed. */
  identifierText: string;
  resolutionType?: SpainResolutionType;
  resolutionNumber?: number;
  resolutionYear?: number;
  bis?: string;
  decisionDate?: string;
  ecli?: string;
  boeNumber?: string;
  boeDate?: string;
}

export interface SpainDetailHeadingParse {
  ok: boolean;
  heading?: SpainDetailHeading;
  reason?: string;
  warnings: string[];
}

export interface SpainOfficialDateExpectedIdentity {
  resolutionType?: unknown;
  resolutionNumber?: unknown;
  resolutionYear?: unknown;
  hjId?: unknown;
  ecli?: unknown;
}

export interface SpainOfficialDateValidationOptions {
  /** Raw HTML of the official HJ `/Resolucion/Show/{id}` detail page. */
  headingHtml?: string;
  /** Parsed HJ JSON detail payload, used only for cross-checking official fields. */
  payload?: Record<string, unknown> | null;
  /** Resolution identity that the detail heading must match exactly. */
  expected?: SpainOfficialDateExpectedIdentity;
}

export interface SpainOfficialDateValidation extends SpainDecisionDateValidation {
  heading?: SpainDetailHeading;
  boeDate?: string;
  ecli?: string;
  dateBasis?: "detail_heading" | "json_fecha_registro";
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

function validDateOnly(yearValue: string, monthValue: string, dayValue: string) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || year < 1900 || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const TIME_SUFFIX = String.raw`(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`;

export function normalizeSpainDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const iso = trimmed.match(new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})${TIME_SUFFIX}$`));
  if (iso) return validDateOnly(iso[1], iso[2], iso[3]);

  const slash = trimmed.match(new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME_SUFFIX}$`));
  if (slash) return validDateOnly(slash[3], slash[2], slash[1]);

  const dotted = trimmed.match(new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{4})${TIME_SUFFIX}$`));
  if (dotted) return validDateOnly(dotted[3], dotted[2], dotted[1]);

  return undefined;
}

export function parseSpanishLongDateValue(value: unknown, fallbackYear?: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/(?:^|\b)(?:de\s+)?(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (!match) return undefined;
  const month = SPANISH_MONTHS[match[2]];
  const year = Number(match[3] ?? fallbackYear);
  if (!month || !Number.isFinite(year) || year < 1900) return undefined;
  return validDateOnly(String(year), String(month), match[1]);
}

export function spainDecisionDateToIso(value: unknown) {
  const dateOnly = normalizeSpainDateOnly(value);
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : undefined;
}

export function normalizeSpainResolutionType(value: unknown): SpainResolutionType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
  if (normalized === "SENTENCIA" || normalized === "AUTO" || normalized === "DECLARACION") return normalized;
  return undefined;
}

function integerValue(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  ordm: "º",
  deg: "°",
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-zA-Z]+);/g, (entity, name: string) => HTML_ENTITIES[name] ?? entity);
}

function stripHtmlTags(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Extracts the visible content of the `#resolucion-identifier` list item. */
function identifierBlock(html: string) {
  const marker = /id\s*=\s*["']resolucion-identifier["']/i.exec(html);
  if (!marker) return undefined;
  const openStart = html.lastIndexOf("<", marker.index);
  const openEnd = html.indexOf(">", marker.index);
  if (openStart < 0 || openEnd < 0) return undefined;
  const close = html.indexOf("</li>", openEnd);
  const end = close > openEnd ? close : Math.min(html.length, openEnd + 4_000);
  return html.slice(openEnd + 1, end);
}

function ecliBlock(html: string, fromIndex: number) {
  const marker = /id\s*=\s*["']resolucionECLI-identifier["']/i.exec(html);
  if (marker) {
    const openEnd = html.indexOf(">", marker.index);
    const close = html.indexOf("</li>", openEnd);
    if (openEnd >= 0 && close > openEnd) return html.slice(openEnd + 1, close);
  }
  return html.slice(Math.max(0, fromIndex), Math.min(html.length, fromIndex + 3_000));
}

function parseBoeText(value: string): { boeNumber?: string; boeDate?: string } {
  const match = value.match(/BOE\s*(?:n[uú]m\.?|num\.?)?\s*(\d+)\s*,\s*de\s+(\d{1,2})\s+de\s+([a-záéíóúüñ]+)\s+de\s+(\d{4})/i);
  if (!match) return {};
  const normalizedMonth = match[3].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const month = SPANISH_MONTHS[normalizedMonth];
  const boeDate = month ? validDateOnly(match[4], String(month), match[2]) : undefined;
  return {
    boeNumber: match[1],
    ...(boeDate ? { boeDate } : {}),
  };
}

/**
 * Parses the authoritative official HJ detail heading, e.g.
 * `SENTENCIA 67/2026, de 6 de octubre` plus `ECLI:ES:TC:2026:67`.
 *
 * The heading may carry a nested BOE publication suffix
 * (`(BOE num. 269, de 29 de octubre de 2026)`); that date is recorded as the
 * BOE date and is never used as the decision date. Any second decision date in
 * the identifier is treated as ambiguous and rejected.
 */
export function parseSpainDetailHeading(html: string): SpainDetailHeadingParse {
  const warnings: string[] = [];
  const block = identifierBlock(html);
  if (!block) {
    return { ok: false, warnings, reason: "Official detail heading #resolucion-identifier is missing." };
  }

  const h2 = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? block;
  const spanTexts = [...h2.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripHtmlTags(match[1]));
  const withoutBoe = h2.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, " ");
  let identifierText = stripHtmlTags(withoutBoe);
  const boeParenthetical = identifierText.match(/\(\s*BOE[\s\S]*?\)/i)?.[0];
  if (boeParenthetical) identifierText = identifierText.replace(boeParenthetical, " ").replace(/\s+/g, " ").trim();
  const boeText = spanTexts.find((text) => /BOE/i.test(text)) ?? boeParenthetical;
  if (!identifierText) {
    return { ok: false, warnings, reason: "Official detail heading is empty." };
  }

  const identity = identifierText.match(/\b(SENTENCIA|AUTO|DECLARACION|DECLARACI[ÓO]N)\s+(\d{1,5})\s*\/\s*(\d{4})(?:\s*([A-Z]))?/i);
  if (!identity) {
    return { ok: false, warnings, reason: "Official detail heading does not expose a resolution type and case number/year." };
  }
  const resolutionType = normalizeSpainResolutionType(identity[1]);
  const resolutionNumber = integerValue(identity[2]);
  const resolutionYear = integerValue(identity[3]);
  if (!resolutionType || !resolutionNumber || !resolutionYear) {
    return { ok: false, warnings, reason: "Official detail heading resolution identity is invalid." };
  }

  const dateMatches = [...identifierText.matchAll(/(?:^|[^\d])(?:de\s+)?(\d{1,2})\s+de\s+([a-záéíóúüñ]+)(?:\s+de\s+(\d{4}))?/gi)];
  const parsedDates = new Set<string>();
  for (const match of dateMatches) {
    const normalizedMonth = match[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const month = SPANISH_MONTHS[normalizedMonth];
    if (!month) continue;
    const year = match[3] ? Number(match[3]) : resolutionYear;
    if (match[3] && Number(match[3]) !== resolutionYear) {
      return { ok: false, warnings, reason: "Official detail heading decision year conflicts with the resolution year." };
    }
    const dateOnly = validDateOnly(String(year), String(month), match[1]);
    if (dateOnly) parsedDates.add(dateOnly);
  }
  if (parsedDates.size === 0) {
    return { ok: false, warnings, reason: "Official detail heading does not expose a decision date." };
  }
  if (parsedDates.size > 1) {
    return { ok: false, warnings, reason: "Official detail heading exposes multiple ambiguous decision dates." };
  }
  const decisionDate = [...parsedDates][0];

  const ecliSource = ecliBlock(html, html.search(/id\s*=\s*["']resolucion-identifier["']/i));
  const ecli = ecliSource.match(/ECLI:ES:TC:\d{4}:\d+[A-Z]?/i)?.[0]?.toUpperCase();
  const boe = boeText ? parseBoeText(boeText) : {};
  if (boeText && !boe.boeDate) warnings.push("Official detail heading BOE suffix could not be parsed.");
  if (ecli) {
    const ecliYear = ecli.match(/ECLI:ES:TC:(\d{4}):/i)?.[1];
    if (ecliYear && ecliYear !== decisionDate.slice(0, 4)) {
      return { ok: false, warnings, reason: "Official detail heading ECLI year conflicts with the decision date year." };
    }
  }

  return {
    ok: true,
    warnings,
    heading: {
      identifierText,
      resolutionType,
      resolutionNumber,
      resolutionYear,
      ...(identity[4] ? { bis: identity[4].toUpperCase() } : {}),
      decisionDate,
      ...(ecli ? { ecli } : {}),
      ...boe,
    },
  };
}

function normalizeEcli(value: unknown) {
  return stringValue(value)?.toUpperCase();
}

function identityConflict(
  reason: string,
  heading: SpainDetailHeading,
  checks: SpainDateCheck[],
  warnings: string[],
  boeDate: string | undefined,
  ecli: string | undefined,
): SpainOfficialDateValidation {
  return {
    ok: false,
    decisionDate: heading.decisionDate,
    checks,
    warnings,
    reason,
    heading,
    ...(boeDate ? { boeDate } : {}),
    ...(ecli ? { ecli } : {}),
    dateBasis: "detail_heading",
  };
}

/**
 * Validates an official decision date from the exact resolution identity.
 *
 * - When `headingHtml` is supplied, the detail heading is authoritative and must
 *   be unambiguous. JSON `FECHA_REGISTRO`, `FECHA_FIRMA`, resolution identity,
 *   ECLI and BOE are cross-checked; any conflict fails closed.
 * - When no heading HTML is supplied, the legacy official JSON `FECHA_REGISTRO`
 *   validation is used (still authoritative, never inferred from body/list/fetch).
 */
export function validateSpainOfficialDecisionDate(
  options: SpainOfficialDateValidationOptions,
): SpainOfficialDateValidation {
  const payload = options.payload ?? {};
  if (options.headingHtml === undefined) {
    const legacy = validateSpainDecisionDate(payload);
    const boeDate = normalizeSpainDateOnly(payload.FECHA_BOE);
    const ecli = normalizeEcli(payload.ECLI ?? payload.ecli);
    return {
      ...legacy,
      ...(boeDate ? { boeDate } : {}),
      ...(ecli ? { ecli } : {}),
      dateBasis: "json_fecha_registro",
    };
  }

  const parsed = parseSpainDetailHeading(options.headingHtml);
  if (!parsed.ok || !parsed.heading?.decisionDate) {
    return {
      ok: false,
      checks: [],
      warnings: parsed.warnings,
      reason: `Official detail heading is not trustworthy: ${parsed.reason ?? "no unambiguous decision date"}.`,
      ...(parsed.heading ? { heading: parsed.heading } : {}),
      dateBasis: "detail_heading",
    };
  }

  const heading = parsed.heading;
  const checks: SpainDateCheck[] = [{ source: "detail_heading", value: heading.decisionDate, matches: true }];
  const warnings = [...parsed.warnings];
  const expected = options.expected ?? {};
  const expectedType = normalizeSpainResolutionType(expected.resolutionType ?? payload.TIPO_RESOLUCION);
  const expectedNumber = integerValue(expected.resolutionNumber ?? payload.NUMERO_RESOLUCION);
  const expectedYear = integerValue(expected.resolutionYear ?? payload.ANNO_RESOLUCION);
  const expectedEcli = normalizeEcli(expected.ecli ?? payload.ECLI ?? payload.ecli);
  const ecli = heading.ecli ?? expectedEcli;
  const payloadBoeDate = normalizeSpainDateOnly(payload.FECHA_BOE);
  const boeDate = payloadBoeDate ?? heading.boeDate;
  const expectedHjId = integerValue(expected.hjId);
  const payloadHjId = integerValue(payload.ID ?? payload.HJ_ID);

  if (expectedHjId && payloadHjId && expectedHjId !== payloadHjId) {
    return identityConflict(
      `HJ JSON id ${payloadHjId} conflicts with the expected official resolution id ${expectedHjId}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  if (expectedType && expectedType !== heading.resolutionType) {
    return identityConflict(
      `Official detail heading resolution type ${heading.resolutionType} conflicts with expected ${expectedType}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  if (expectedNumber && expectedNumber !== heading.resolutionNumber) {
    return identityConflict(
      `Official detail heading case number ${heading.resolutionNumber} conflicts with expected ${expectedNumber}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  if (expectedYear && expectedYear !== heading.resolutionYear) {
    return identityConflict(
      `Official detail heading year ${heading.resolutionYear} conflicts with expected ${expectedYear}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  checks.push({
    source: "resolution_identity",
    value: `${heading.resolutionType} ${heading.resolutionNumber}/${heading.resolutionYear}`,
    matches: true,
  });

  if (heading.ecli && expectedEcli && heading.ecli !== expectedEcli) {
    return identityConflict(
      `Official detail heading ECLI ${heading.ecli} conflicts with expected ${expectedEcli}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  if (ecli) {
    const ecliYear = ecli.match(/ECLI:ES:TC:(\d{4}):/i)?.[1];
    const matches = Boolean(ecliYear && ecliYear === heading.decisionDate!.slice(0, 4));
    checks.push({ source: "ECLI", value: ecli, matches });
    if (!matches) {
      return identityConflict(
        "Official detail heading ECLI year conflicts with the decision date year.",
        heading, checks, warnings, boeDate, ecli,
      );
    }
  }

  const rawFechaRegistro = payload.FECHA_REGISTRO;
  const jsonDate = normalizeSpainDateOnly(rawFechaRegistro);
  if (jsonDate) {
    const matches = jsonDate === heading.decisionDate;
    checks.push({ source: "FECHA_REGISTRO", value: jsonDate, matches });
    if (!matches) {
      return identityConflict(
        `Official detail heading decision date ${heading.decisionDate} conflicts with HJ FECHA_REGISTRO ${jsonDate}.`,
        heading, checks, warnings, boeDate, ecli,
      );
    }
  } else {
    const missing = rawFechaRegistro === undefined || rawFechaRegistro === null
      || (typeof rawFechaRegistro === "string" && !rawFechaRegistro.trim());
    checks.push({
      source: "FECHA_REGISTRO",
      ...(missing ? {} : { value: String(rawFechaRegistro) }),
      matches: false,
    });
    warnings.push(missing
      ? "HJ FECHA_REGISTRO is missing; the official detail heading is authoritative."
      : "HJ FECHA_REGISTRO is invalid; the official detail heading is authoritative.");
  }

  const firmaDate = parseSpanishLongDateValue(payload.FECHA_FIRMA, heading.resolutionYear ?? payload.ANNO_RESOLUCION);
  if (firmaDate) {
    const matches = firmaDate === heading.decisionDate;
    checks.push({ source: "FECHA_FIRMA", value: firmaDate, matches });
    if (!matches) {
      return identityConflict(
        `Official detail heading decision date ${heading.decisionDate} conflicts with HJ FECHA_FIRMA ${firmaDate}.`,
        heading, checks, warnings, boeDate, ecli,
      );
    }
  }

  if (payloadBoeDate && heading.boeDate && payloadBoeDate !== heading.boeDate) {
    return identityConflict(
      `HJ BOE date ${payloadBoeDate} conflicts with the detail heading BOE date ${heading.boeDate}.`,
      heading, checks, warnings, boeDate, ecli,
    );
  }
  if (boeDate) {
    const matches = boeDate >= heading.decisionDate!;
    checks.push({ source: "BOE", value: boeDate, matches });
    if (!matches) {
      return identityConflict(
        `HJ BOE date ${boeDate} precedes the official decision date ${heading.decisionDate}.`,
        heading, checks, warnings, boeDate, ecli,
      );
    }
  }

  return {
    ok: true,
    decisionDate: heading.decisionDate,
    checks,
    warnings,
    heading,
    ...(boeDate ? { boeDate } : {}),
    ...(ecli ? { ecli } : {}),
    dateBasis: "detail_heading",
  };
}

export function validateSpainDecisionDate(payload: Record<string, unknown>): SpainDecisionDateValidation {
  const raw = payload.FECHA_REGISTRO;
  const decisionDate = normalizeSpainDateOnly(raw);
  const checks: SpainDateCheck[] = [{ source: "FECHA_REGISTRO", value: decisionDate, matches: Boolean(decisionDate) }];
  const warnings: string[] = [];
  if (!decisionDate) {
    const missing = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());
    return {
      ok: false,
      checks,
      warnings,
      reason: missing ? "FECHA_REGISTRO is missing." : "FECHA_REGISTRO is not a valid official decision date.",
    };
  }

  const firmaDate = parseSpanishLongDateValue(payload.FECHA_FIRMA, payload.ANNO_RESOLUCION);
  if (firmaDate) {
    const matches = firmaDate === decisionDate;
    checks.push({ source: "FECHA_FIRMA", value: firmaDate, matches });
    if (!matches) return { ok: false, decisionDate, checks, warnings, reason: "FECHA_FIRMA does not match FECHA_REGISTRO." };
  }

  const resolutionYear = Number(payload.ANNO_RESOLUCION);
  if (Number.isInteger(resolutionYear) && resolutionYear !== Number(decisionDate.slice(0, 4))) {
    warnings.push("ANNO_RESOLUCION year does not match FECHA_REGISTRO year.");
  }

  return { ok: true, decisionDate, checks, warnings };
}
