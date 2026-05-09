import { format, parse, parseISO, subDays } from "date-fns";

export type TimeRange = "latest" | "today" | "week" | "month";

export function normalizeRange(value?: string | null): TimeRange {
  if (value === "today" || value === "week" || value === "month") {
    return value;
  }

  return "latest";
}

export function getRangeStart(range: TimeRange, now = new Date()) {
  if (range === "today") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  if (range === "week") {
    return subDays(now, 7);
  }

  if (range === "month") {
    return subDays(now, 30);
  }

  return null;
}

export function isWithinRange(dateValue: string | null | undefined, range: TimeRange, now = new Date()) {
  const start = getRangeStart(range, now);
  if (!start || !dateValue) {
    return true;
  }

  const date = parseDate(dateValue);
  return date ? date >= start : false;
}

export function parseDate(input?: string | null) {
  if (!input) {
    return null;
  }

  const normalizedInput = input.trim().replace(/\s+/g, " ");
  const iso = parseISO(input);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  const dottedDate = normalizedInput.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dottedDate) {
    return new Date(Date.UTC(Number(dottedDate[3]), Number(dottedDate[2]) - 1, Number(dottedDate[1])));
  }

  const localizedDate = parseLocalizedLongDate(normalizedInput);
  if (localizedDate) {
    return localizedDate;
  }

  const scotusDate = parse(input, "M/d/yy", new Date());
  if (!Number.isNaN(scotusDate.getTime())) {
    return scotusDate;
  }

  const longDate = parse(input, "MMMM d, yyyy", new Date());
  if (!Number.isNaN(longDate.getTime())) {
    return longDate;
  }

  return null;
}

const LOCALIZED_MONTHS: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  février: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  août: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
  décembre: 11,
  januar: 0,
  februar: 1,
  marz: 2,
  märz: 2,
  april: 3,
  juni: 5,
  juli: 6,
  august: 7,
  september: 8,
  oktober: 9,
  dezember: 11,
};

function parseLocalizedLongDate(input: string) {
  const match = input.toLowerCase().match(/^(\d{1,2})(?:er|\.)?\s+([a-zäöüéûôîïçàèù]+)\s+(\d{4})$/i);
  if (!match) return null;

  const month = LOCALIZED_MONTHS[match[2]];
  if (month === undefined) return null;

  return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
}

export function toIsoDate(input?: string | null) {
  const date = parseDate(input);
  return date ? date.toISOString() : undefined;
}

export function formatDisplayDate(input?: string | null) {
  const date = parseDate(input);
  if (!date) {
    return "날짜 미상";
  }

  return format(date, "yyyy-MM-dd");
}

export function formatSlugDate(input?: string | null) {
  const date = parseDate(input);
  if (!date) {
    return "undated";
  }

  return format(date, "yyyy-MM-dd");
}
