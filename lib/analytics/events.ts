import { getSupabaseAdmin } from "@/lib/db/client";
import { recordAdminAuditLog } from "@/lib/db/admin-audit";
import { redactAdminAuditEventInput } from "@/lib/security/audit-redaction";
import { getClientIp, hashRequestValue, type HeaderLike } from "@/lib/security/request-client";

export type SiteEventType =
  | "page_view"
  | "article_view"
  | "search"
  | "tag_click"
  | "tag_view"
  | "source_view"
  | "article_click"
  | "external_link_click"
  | "security_event"
  | "admin_action"
  | "admin_review_action";

export interface SiteEventInput {
  eventType: SiteEventType;
  path?: string | null;
  articleId?: string | null;
  articleSlug?: string | null;
  articleTitle?: string | null;
  tagSlug?: string | null;
  tagName?: string | null;
  sourceKey?: string | null;
  jurisdiction?: string | null;
  institutionName?: string | null;
  searchQuery?: string | null;
  searchMode?: string | null;
  resultCount?: number | null;
  metadata?: Record<string, unknown>;
}

const PUBLIC_CLIENT_EVENT_TYPES = new Set<SiteEventType>(["page_view", "article_view", "tag_click", "article_click", "external_link_click"]);
const BOT_MARKERS = [
  "bot",
  "crawler",
  "spider",
  "preview",
  "facebookexternalhit",
  "slurp",
  "bingpreview",
  "duckduckbot",
  "ahrefs",
  "semrush",
  "vercelbot",
];
const SEARCH_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SEARCH_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const SEARCH_PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?(?:0\d{1,2}|\(?\d{2,3}\)?)[\s.-]\d{3,4}[\s.-]\d{4}\b/g;
const SEARCH_IDENTIFIER_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;

function limitText(value?: string | null, max = 300) {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export function normalizeAnalyticsSearchQuery(value?: string | null) {
  const normalized = value
    ?.replace(/\s+/g, " ")
    .toLowerCase()
    .replace(SEARCH_EMAIL_PATTERN, "[email]")
    .replace(SEARCH_URL_PATTERN, "[url]")
    .replace(SEARCH_PHONE_PATTERN, "[number]")
    .replace(SEARCH_IDENTIFIER_PATTERN, "[identifier]");
  return limitText(normalized, 120);
}

function kstDateKey(now: Date) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function analyticsClientIdentifier(headers?: HeaderLike, now = new Date()) {
  const ip = getClientIp(headers);
  return hashRequestValue(ip ? `site-analytics:${kstDateKey(now)}:${ip}` : null);
}

export function primaryAcceptLanguage(headers?: HeaderLike) {
  const primary = headers?.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  if (!primary || !/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(primary)) return null;
  return primary.slice(0, 35);
}

function referrerHost(headers?: HeaderLike) {
  const referrer = headers?.get("referer") ?? headers?.get("referrer");
  if (!referrer) return null;
  try {
    return new URL(referrer).host.slice(0, 200);
  } catch {
    return null;
  }
}

function isPrefetch(headers?: HeaderLike) {
  if (!headers) return false;
  return (
    headers.get("next-router-prefetch") === "1" ||
    headers.get("purpose")?.toLowerCase() === "prefetch" ||
    headers.get("sec-purpose")?.toLowerCase() === "prefetch" ||
    headers.get("x-middleware-prefetch") === "1"
  );
}

function isBot(headers?: HeaderLike) {
  const userAgent = headers?.get("user-agent")?.toLowerCase() ?? "";
  if (!userAgent) return false;
  return BOT_MARKERS.some((marker) => userAgent.includes(marker));
}

function headerText(headers: HeaderLike | undefined, name: string, max = 500) {
  return limitText(headers?.get(name), max);
}

function userAgentFamily(headers?: HeaderLike) {
  const userAgent = headers?.get("user-agent") ?? "";
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome|crios/i.test(userAgent)) return "Chrome";
  if (/firefox|fxios/i.test(userAgent)) return "Firefox";
  if (/safari/i.test(userAgent) && !/chrome|crios|android/i.test(userAgent)) return "Safari";
  if (/node|undici/i.test(userAgent)) return "Server";
  return userAgent ? "Other" : null;
}

function deviceType(headers?: HeaderLike) {
  const userAgent = headers?.get("user-agent") ?? "";
  if (/ipad|tablet/i.test(userAgent)) return "tablet";
  if (/mobile|iphone|ipod|android/i.test(userAgent)) return "mobile";
  return userAgent ? "desktop" : null;
}

function sanitizedMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.slice(0, 80), typeof value === "string" ? limitText(value, 500) : value]),
  );
}

function legacyPayload(payload: Record<string, unknown>) {
  const legacy = { ...payload };
  delete legacy.client_ip;
  delete legacy.client_ip_hash;
  delete legacy.user_agent;
  delete legacy.accept_language;
  delete legacy.client_country;
  delete legacy.client_region;
  delete legacy.client_city;
  delete legacy.is_bot;
  return legacy;
}

export function isPublicClientEventType(value: string): value is SiteEventType {
  return PUBLIC_CLIENT_EVENT_TYPES.has(value as SiteEventType);
}

export async function recordSiteEvent(input: SiteEventInput, headers?: HeaderLike) {
  if (process.env.SITE_ANALYTICS_ENABLED === "false" || isPrefetch(headers)) return;

  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const safeInput = redactAdminAuditEventInput(input);
  const payload = {
    event_type: safeInput.eventType,
    path: limitText(safeInput.path, 500),
    article_id: limitText(safeInput.articleId, 80),
    article_slug: limitText(safeInput.articleSlug, 300),
    article_title: limitText(safeInput.articleTitle, 500),
    tag_slug: limitText(safeInput.tagSlug, 200),
    tag_name: limitText(safeInput.tagName, 200),
    source_key: limitText(safeInput.sourceKey, 120),
    jurisdiction: limitText(safeInput.jurisdiction, 120),
    institution_name: limitText(safeInput.institutionName, 300),
    search_query: normalizeAnalyticsSearchQuery(safeInput.searchQuery),
    search_mode: limitText(safeInput.searchMode, 40),
    result_count: typeof safeInput.resultCount === "number" && Number.isFinite(safeInput.resultCount) ? Math.max(0, Math.round(safeInput.resultCount)) : null,
    referrer_host: referrerHost(headers),
    user_agent_family: userAgentFamily(headers),
    device_type: deviceType(headers),
    client_ip_hash: analyticsClientIdentifier(headers),
    accept_language: primaryAcceptLanguage(headers),
    client_country: headerText(headers, "x-vercel-ip-country", 20) ?? headerText(headers, "cf-ipcountry", 20),
    is_bot: isBot(headers),
    metadata: sanitizedMetadata(safeInput.metadata),
  };

  const { error } = await supabase.from("site_events").insert(payload);
  if (error) {
    const retry = await supabase.from("site_events").insert(legacyPayload(payload));
    if (!retry.error) return;
  }

  if (input.eventType === "security_event" && error?.message?.includes("site_events_event_type_check")) {
    return;
  }

  if (error && process.env.NODE_ENV !== "production") {
    console.warn(`site analytics skipped: ${error.message}`);
  }
}

export async function recordAdminSiteEvent(
  input: SiteEventInput & { eventType: Extract<SiteEventType, "admin_action" | "admin_review_action"> },
  headers?: HeaderLike,
) {
  const safeInput = redactAdminAuditEventInput(input);
  await recordSiteEvent(safeInput, headers);
  await recordAdminAuditLog(safeInput, headers);
}

export async function recordSearchEvent({
  query,
  mode,
  resultCount,
  path = "/search",
  headers,
  metadata,
}: {
  query?: string | null;
  mode?: string | null;
  resultCount: number;
  path?: string;
  headers?: HeaderLike;
  metadata?: Record<string, unknown>;
}) {
  if (!query?.trim()) return;
  await recordSiteEvent(
    {
      eventType: "search",
      path,
      searchQuery: query,
      searchMode: mode,
      resultCount,
      metadata,
    },
    headers,
  );
}
