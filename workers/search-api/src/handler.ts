export type SearchWorkerEnv = {
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

type JsonRecord = Record<string, unknown>;
type Fetcher = typeof fetch;

export type WorkerDependencies = {
  fetcher?: Fetcher;
};

const SEARCH_PARAMETERS = new Set([
  "q",
  "mode",
  "page",
  "pageSize",
  "count",
  "jurisdiction",
  "source",
  "range",
]);
const SEARCH_MODES = new Set(["fulltext", "semantic", "hybrid"]);
const COUNT_MODES = new Set(["exact", "planned", "estimated", "none"]);
const RANGE_VALUES = new Set(["latest", "today", "week", "month"]);
const SOURCE_KEY_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_FILTER_PATTERN = /^[\p{L}\p{M}\p{N} _./:·°§#-]+$/u;
const SEARCH_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const DETAIL_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=900";
const UPSTREAM_TIMEOUT_MS = 8_000;
const SOURCE_TYPE = "foreign_constitutional";

export async function handleWorldconsSearchRequest(
  request: Request,
  env: SearchWorkerEnv,
  dependencies: WorkerDependencies = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Only GET is supported.", {
      Allow: "GET",
    });
  }

  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "WorldCons data access is not configured.", {
      "Retry-After": "30",
    });
  }

  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  const fetcher = dependencies.fetcher ?? fetch;

  try {
    if (pathname === "/api/search") {
      return await searchResponse(url, env, fetcher);
    }
    if (pathname === "/api/sources") {
      return await sourcesResponse(env, fetcher);
    }

    const articleMatch = pathname.match(/^\/api\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/source-text)?$/u);
    if (articleMatch) {
      return await articleResponse(articleMatch[1], Boolean(articleMatch[2]), env, fetcher);
    }

    return errorResponse(404, "NOT_FOUND", "The requested WorldCons endpoint does not exist.");
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return errorResponse(400, "INVALID_REQUEST", error.message);
    }
    if (error instanceof UpstreamRateLimitError) {
      return errorResponse(429, "RATE_LIMITED", "WorldCons search is temporarily rate limited.", {
        "Retry-After": error.retryAfter,
      });
    }
    console.error(JSON.stringify({
      event: "worldcons_search_api_error",
      path: pathname,
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    return errorResponse(503, "SERVICE_UNAVAILABLE", "WorldCons search is temporarily unavailable.", {
      "Retry-After": "30",
    });
  }
}

async function searchResponse(url: URL, env: SearchWorkerEnv, fetcher: Fetcher) {
  const input = parseSearchInput(url.searchParams);
  const rpcPayload = await callRpc(env, "worldcons_provider_search_v1", {
    p_query: input.query,
    p_limit: input.pageSize,
    p_offset: (input.page - 1) * input.pageSize,
    p_source: input.source,
    p_jurisdiction: input.jurisdiction,
    p_range: input.range,
  }, fetcher);
  const payload = requiredRecord(rpcPayload, "search response");
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const hasMore = rawItems.length > input.pageSize;
  const items = rawItems.slice(0, input.pageSize).map((item) => mapSearchItem(item, env.PUBLIC_BASE_URL));
  const offset = (input.page - 1) * input.pageSize;
  const lowerBoundTotal = offset + items.length + (hasMore ? 1 : 0);

  return jsonResponse({
    schemaVersion: 1,
    service: "worldcons",
    transport: "cloudflare-worker",
    mode: input.mode,
    items,
    meta: {
      limit: input.pageSize,
      offset,
      total: lowerBoundTotal,
      hasMore,
      totalIsExact: false,
    },
    pageInfo: {
      page: input.page,
      pageSize: input.pageSize,
      total: lowerBoundTotal,
      hasMore,
      totalIsExact: false,
    },
  }, 200, SEARCH_CACHE_CONTROL);
}

async function sourcesResponse(env: SearchWorkerEnv, fetcher: Fetcher) {
  const rpcPayload = await callRpc(env, "worldcons_provider_sources_v1", {}, fetcher);
  const sources = Array.isArray(rpcPayload) ? rpcPayload : [];
  return jsonResponse({
    schemaVersion: 1,
    service: "worldcons",
    transport: "cloudflare-worker",
    items: sources.map((source) => {
      const row = requiredRecord(source, "source");
      return {
        sourceKey: requiredString(row.sourceKey ?? row.source_key, "sourceKey"),
        name: requiredString(row.name, "name"),
        jurisdiction: requiredString(row.jurisdiction, "jurisdiction"),
        baseUrl: requiredString(row.baseUrl ?? row.base_url, "baseUrl"),
        language: requiredString(row.language, "language"),
        isActive: row.isActive ?? row.is_active ?? true,
        sourceType: SOURCE_TYPE,
      };
    }),
  }, 200, DETAIL_CACHE_CONTROL);
}

async function articleResponse(slug: string, sourceTextOnly: boolean, env: SearchWorkerEnv, fetcher: Fetcher) {
  if (!SLUG_PATTERN.test(slug)) {
    return errorResponse(400, "INVALID_REQUEST", "slug contains unsupported characters.");
  }

  const rpcPayload = await callRpc(env, "worldcons_provider_article_v1", { p_slug: slug }, fetcher);
  if (rpcPayload === null) {
    return errorResponse(404, "NOT_FOUND", "Article not found.");
  }

  const item = mapArticleDetail(rpcPayload, env.PUBLIC_BASE_URL);
  if (sourceTextOnly) {
    if (!item.cleanedText) {
      return errorResponse(404, "NOT_FOUND", "Source snapshot not found.");
    }
    return jsonResponse({
      slug: item.slug,
      cleanedText: item.cleanedText,
    }, 200, DETAIL_CACHE_CONTROL);
  }

  return jsonResponse(item, 200, DETAIL_CACHE_CONTROL);
}

function parseSearchInput(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    if (!SEARCH_PARAMETERS.has(key)) {
      throw new RequestValidationError(`Unsupported parameter: ${key}`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw new RequestValidationError(`Parameter must appear once: ${key}`);
    }
  }

  const query = searchParams.get("q")?.trim().normalize("NFKC") ?? "";
  if (query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new RequestValidationError("q must be at most 200 characters and contain no control characters.");
  }
  const mode = searchParams.get("mode")?.trim() || "hybrid";
  if (!SEARCH_MODES.has(mode)) {
    throw new RequestValidationError("mode must be fulltext, semantic, or hybrid.");
  }
  const count = searchParams.get("count")?.trim() || "none";
  if (!COUNT_MODES.has(count)) {
    throw new RequestValidationError("count is invalid.");
  }
  const page = boundedInteger(searchParams.get("page"), "page", 1, 1, 500);
  const pageSize = boundedInteger(searchParams.get("pageSize"), "pageSize", 10, 1, 20);
  if ((page - 1) * pageSize > 10_000) {
    throw new RequestValidationError("The requested page offset is too large.");
  }

  const source = optionalFilter(searchParams.get("source"), "source", 80, SOURCE_KEY_PATTERN);
  const jurisdiction = optionalFilter(searchParams.get("jurisdiction"), "jurisdiction", 80, SAFE_FILTER_PATTERN);
  const range = searchParams.get("range")?.trim() || "latest";
  if (!RANGE_VALUES.has(range)) {
    throw new RequestValidationError("range must be latest, today, week, or month.");
  }

  return {
    query,
    mode,
    count,
    page,
    pageSize,
    source,
    jurisdiction,
    range,
  };
}

function mapSearchItem(value: unknown, publicBaseUrl: string) {
  const row = requiredRecord(value, "search item");
  const slug = requiredString(row.slug, "slug");
  const sourceKey = requiredString(row.source_key, "source_key");
  const originalUrl = requiredString(row.original_url ?? row.canonical_url, "original_url");
  const summaryJson = optionalRecord(row.summary_json);
  const sourceMetadata = optionalRecord(row.source_metadata);
  const coreSummary = stringArray(optionalRecord(summaryJson?.summary)?.coreSummary);
  const oneLineSummary = coreSummary[0] ?? "요약이 아직 생성되지 않았습니다.";
  const detailApiUrl = `${normalizedBaseUrl(publicBaseUrl)}/api/articles/${encodeURIComponent(slug)}`;
  const caseNumber = optionalString(row.case_number)
    ?? firstString(sourceMetadata, ["caseNumber", "case_number", "docketNumber", "docket_number"]);

  return {
    id: requiredString(row.id, "id"),
    slug,
    title: optionalString(row.korean_title) ?? optionalString(row.original_title) ?? "제목 미상",
    koreanTitle: optionalString(row.korean_title),
    originalTitle: optionalString(row.original_title),
    summary: truncatePlainText(coreSummary.join(" "), 4_000) || null,
    snippet: truncatePlainText(oneLineSummary, 800),
    oneLineSummary,
    summaryJson,
    sourceType: SOURCE_TYPE,
    sourceKey,
    jurisdiction: requiredString(row.jurisdiction, "jurisdiction"),
    country: requiredString(row.jurisdiction, "jurisdiction"),
    institutionName: requiredString(row.institution_name, "institution_name"),
    courtName: requiredString(row.institution_name, "institution_name"),
    caseNumber,
    contentType: requiredString(row.content_type, "content_type"),
    originalLanguage: requiredString(row.original_language, "original_language"),
    language: requiredString(row.original_language, "original_language"),
    originalPublishedAt: optionalString(row.original_published_at),
    decisionDate: optionalString(row.original_published_at),
    publishedAt: optionalString(row.original_published_at),
    originalUrl,
    canonicalUrl: optionalString(row.canonical_url) ?? originalUrl,
    officialUrl: originalUrl,
    url: detailApiUrl,
    worldconsUrl: detailApiUrl,
    detailUrl: detailApiUrl,
    detailApiUrl,
    sourceTextUrl: `${detailApiUrl}/source-text`,
    updatedAt: firstString(row, ["summarized_at", "fetched_at", "discovered_at", "original_published_at"]),
    score: finiteNumber(row.relevance_score),
    tags: extractTagNames(row.article_tags, summaryJson),
    sourceMetadata,
    metadata: {
      slug,
      sourceKey,
      sourceType: SOURCE_TYPE,
      caseNumber,
      originalTitle: optionalString(row.original_title),
      officialUrl: originalUrl,
      detailApiUrl,
      sourceTextUrl: `${detailApiUrl}/source-text`,
      summaryJson,
    },
  };
}

function mapArticleDetail(value: unknown, publicBaseUrl: string) {
  const row = requiredRecord(value, "article detail");
  const item = mapSearchItem(row, publicBaseUrl);
  return {
    ...item,
    cleanedText: optionalString(row.cleaned_text),
    contentHash: optionalString(row.content_hash),
  };
}

async function callRpc(
  env: SearchWorkerEnv,
  functionName: string,
  payload: JsonRecord,
  fetcher: Fetcher,
): Promise<unknown> {
  const endpoint = new URL(`/rest/v1/rpc/${functionName}`, normalizedSupabaseUrl(env.SUPABASE_URL));
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (response.status === 429) {
    await response.body?.cancel();
    throw new UpstreamRateLimitError(normalizedRetryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok) {
    await response.body?.cancel();
    console.error(JSON.stringify({
      event: "worldcons_supabase_rpc_failed",
      rpc: functionName,
      status: response.status,
    }));
    throw new Error("SupabaseRpcError");
  }
  return response.json();
}

function normalizedSupabaseUrl(value: string) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function normalizedBaseUrl(value: string) {
  return value.replace(/\/+$/u, "");
}

function normalizedPathname(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/u, "");
}

function normalizedRetryAfter(value: string | null) {
  if (value && /^(?:[1-9]\d{0,3})$/u.test(value)) return value;
  return "30";
}

function boundedInteger(value: string | null, name: string, fallback: number, min: number, max: number) {
  if (value === null || value === "") return fallback;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new RequestValidationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RequestValidationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function optionalFilter(value: string | null, name: string, maxLength: number, pattern: RegExp) {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > maxLength || !pattern.test(normalized)) {
    throw new RequestValidationError(`${name} contains unsupported characters.`);
  }
  return normalized;
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  const record = optionalRecord(value);
  if (!record) throw new Error(`Malformed ${label}.`);
  return record;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function requiredString(value: unknown, label: string) {
  const string = optionalString(value);
  if (!string) throw new Error(`Malformed response: ${label} is required.`);
  return string;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(record: JsonRecord | null, keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value) return value;
  }
  return null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

function extractTagNames(value: unknown, summaryJson: JsonRecord | null) {
  const names = new Set(stringArray(summaryJson?.tags));
  if (Array.isArray(value)) {
    for (const articleTagValue of value) {
      const articleTag = optionalRecord(articleTagValue);
      const tagValues = articleTag && Array.isArray(articleTag.tags) ? articleTag.tags : [articleTag?.tags];
      for (const tagValue of tagValues) {
        const tag = optionalRecord(tagValue);
        const name = optionalString(tag?.name);
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

function truncatePlainText(value: string, maxLength: number) {
  const plain = value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function finiteNumber(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function jsonResponse(body: unknown, status: number, cacheControl: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    service: "worldcons",
    error: {
      code,
      message,
      retryable: status === 429 || status === 503,
    },
  }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

class UpstreamRateLimitError extends Error {
  retryAfter: string;

  constructor(retryAfter: string) {
    super("WorldCons upstream rate limit reached.");
    this.name = "UpstreamRateLimitError";
    this.retryAfter = retryAfter;
  }
}
