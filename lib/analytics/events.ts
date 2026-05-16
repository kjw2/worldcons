import { getSupabaseAdmin } from "@/lib/db/client";

export type SiteEventType =
  | "page_view"
  | "article_view"
  | "search"
  | "tag_click"
  | "tag_view"
  | "source_view"
  | "article_click"
  | "external_link_click"
  | "admin_action"
  | "admin_review_action";

type HeaderLike = {
  get(name: string): string | null;
};

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

const PUBLIC_CLIENT_EVENT_TYPES = new Set<SiteEventType>(["tag_click", "article_click", "external_link_click"]);
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

function limitText(value?: string | null, max = 300) {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeSearchQuery(value?: string | null) {
  return limitText(value?.replace(/\s+/g, " ").toLowerCase(), 200);
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

export function isPublicClientEventType(value: string): value is SiteEventType {
  return PUBLIC_CLIENT_EVENT_TYPES.has(value as SiteEventType);
}

export async function recordSiteEvent(input: SiteEventInput, headers?: HeaderLike) {
  if (process.env.SITE_ANALYTICS_ENABLED === "false" || isPrefetch(headers) || isBot(headers)) return;

  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const payload = {
    event_type: input.eventType,
    path: limitText(input.path, 500),
    article_id: limitText(input.articleId, 80),
    article_slug: limitText(input.articleSlug, 300),
    article_title: limitText(input.articleTitle, 500),
    tag_slug: limitText(input.tagSlug, 200),
    tag_name: limitText(input.tagName, 200),
    source_key: limitText(input.sourceKey, 120),
    jurisdiction: limitText(input.jurisdiction, 120),
    institution_name: limitText(input.institutionName, 300),
    search_query: normalizeSearchQuery(input.searchQuery),
    search_mode: limitText(input.searchMode, 40),
    result_count: typeof input.resultCount === "number" && Number.isFinite(input.resultCount) ? Math.max(0, Math.round(input.resultCount)) : null,
    referrer_host: referrerHost(headers),
    user_agent_family: userAgentFamily(headers),
    device_type: deviceType(headers),
    metadata: sanitizedMetadata(input.metadata),
  };

  const { error } = await supabase.from("site_events").insert(payload);
  if (error && process.env.NODE_ENV !== "production") {
    console.warn(`site analytics skipped: ${error.message}`);
  }
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
