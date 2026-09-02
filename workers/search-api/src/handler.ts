import { hasExactCaseReference } from "../../../lib/search/case-number";
import { normalizeEmbeddingVector } from "../../../lib/ai/embedding-vector";

export type SearchWorkerEnv = {
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_SEARCH_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_EMBEDDING_MODEL?: string;
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
const DETAIL_PARAMETERS = new Set(["textLimit"]);
const SOURCE_TEXT_PARAMETERS = new Set(["offset", "limit"]);
const SEARCH_MODES = new Set(["fulltext", "semantic", "hybrid"]);
const COUNT_MODES = new Set(["exact", "planned", "estimated", "none"]);
const RANGE_VALUES = new Set(["latest", "today", "week", "month"]);
const SOURCE_KEY_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_FILTER_PATTERN = /^[\p{L}\p{M}\p{N} _./:·°§#-]+$/u;
const SEARCH_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const DETAIL_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=900";
const CONTRACT_VERSION = "2.0";
const UPSTREAM_TIMEOUT_MS = 8_000;
const EMBEDDING_TIMEOUT_MS = 5_000;
const GEMINI_EMBEDDING_API = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_EMBEDDING_DIMENSIONS = 1536;
const MAX_EMBEDDING_RESPONSE_BYTES = 256_000;
const MAX_UPSTREAM_RPC_BYTES = 4_000_000;
const MAX_SEARCH_RESPONSE_BYTES = 1_500_000;
const MAX_SOURCES_RESPONSE_BYTES = 200_000;
const MAX_DETAIL_RESPONSE_BYTES = 1_900_000;
const MAX_SOURCE_TEXT_RESPONSE_BYTES = 1_800_000;
const MAX_DETAIL_TEXT_CHARS = 350_000;
const MAX_DETAIL_TEXT_BYTES = 1_200_000;
const MAX_BODY_EXCERPT_CHARS = 4_000;
const MAX_DETAIL_EXCERPT_CHARS = 16_000;
const MAX_SUMMARY_JSON_CHARS = 12_000;
const MAX_SOURCE_METADATA_CHARS = 4_000;
const MAX_TAGS = 30;
const SOURCE_TYPE = "foreign_constitutional";
const AUTHORITY_LEVEL = "persuasive";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_CONTEXT: Record<string, {
  jurisdictionCode: string;
  jurisdictionName: string;
  officialHostSuffixes: string[];
}> = {
  "de-bverfg": {
    jurisdictionCode: "DE",
    jurisdictionName: "독일",
    officialHostSuffixes: ["bundesverfassungsgericht.de"],
  },
  "es-tribunal-constitucional": {
    jurisdictionCode: "ES",
    jurisdictionName: "스페인",
    officialHostSuffixes: ["tribunalconstitucional.es"],
  },
  "fr-conseil-constitutionnel": {
    jurisdictionCode: "FR",
    jurisdictionName: "프랑스",
    officialHostSuffixes: ["conseil-constitutionnel.fr"],
  },
  "us-scotus": {
    jurisdictionCode: "US",
    jurisdictionName: "미국",
    officialHostSuffixes: ["supremecourt.gov"],
  },
};

export async function handleWorldconsSearchRequest(
  request: Request,
  env: SearchWorkerEnv,
  dependencies: WorkerDependencies = {},
): Promise<Response> {
  const requestId = requestIdFor(request);
  if (request.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Only GET is supported.", {
      Allow: "GET",
    }, requestId);
  }

  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "WorldCons data access is not configured.", {
      "Retry-After": "30",
    }, requestId);
  }

  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  const fetcher = dependencies.fetcher ?? fetch;

  try {
    if (pathname === "/api/search") {
      return await searchResponse(url, env, fetcher, requestId);
    }
    if (pathname === "/api/sources") {
      assertNoParameters(url.searchParams);
      return await sourcesResponse(env, fetcher, requestId);
    }

    const articleMatch = pathname.match(/^\/api\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/source-text)?$/u);
    if (articleMatch) {
      return await articleResponse(url, articleMatch[1], Boolean(articleMatch[2]), env, fetcher, requestId);
    }

    return errorResponse(404, "NOT_FOUND", "The requested WorldCons endpoint does not exist.", {}, requestId);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return errorResponse(400, "INVALID_REQUEST", error.message, {}, requestId);
    }
    if (error instanceof UpstreamRateLimitError) {
      return errorResponse(429, "RATE_LIMITED", "WorldCons search is temporarily rate limited.", {
        "Retry-After": error.retryAfter,
      }, requestId);
    }
    console.error(JSON.stringify({
      event: "worldcons_search_api_error",
      path: pathname,
      requestId,
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    return errorResponse(503, "SERVICE_UNAVAILABLE", "WorldCons search is temporarily unavailable.", {
      "Retry-After": "30",
    }, requestId);
  }
}

async function searchResponse(url: URL, env: SearchWorkerEnv, fetcher: Fetcher, requestId: string) {
  const input = parseSearchInput(url.searchParams);
  const retrieval = await resolveRetrievalPlan(input.query, input.mode, env, fetcher, requestId);
  const rpcPayload = await callRpc(env, "worldcons_provider_search_v4", {
    p_query: input.query,
    p_mode: retrieval.effectiveMode,
    p_query_embedding: retrieval.embedding,
    p_limit: input.pageSize,
    p_offset: (input.page - 1) * input.pageSize,
    p_source: input.source,
    p_jurisdiction: input.jurisdiction,
    p_range: input.range,
    p_count: input.count,
  }, fetcher, requestId);
  const payload = requiredRecord(rpcPayload, "search response");
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems.slice(0, input.pageSize).map((item) => mapSearchItem(item, env.PUBLIC_BASE_URL));
  const offset = (input.page - 1) * input.pageSize;
  const hasMore = typeof payload.hasMore === "boolean" ? payload.hasMore : rawItems.length > input.pageSize;
  const lowerBoundTotal = offset + items.length + (hasMore ? 1 : 0);
  const upstreamTotal = nonNegativeInteger(payload.total);
  const totalIsExact = payload.totalIsExact === true;
  const total = Math.max(upstreamTotal ?? 0, lowerBoundTotal);
  const databaseRetrievalMode = optionalString(payload.retrievalMode);

  return jsonResponse({
    contractVersion: CONTRACT_VERSION,
    schemaVersion: 1,
    requestId,
    query: input.query,
    service: "worldcons",
    transport: "cloudflare-worker",
    mode: retrieval.effectiveMode,
    requestedMode: retrieval.requestedMode,
    effectiveMode: retrieval.effectiveMode,
    degraded: retrieval.degraded,
    ...(retrieval.degradationReason ? { degradationReason: retrieval.degradationReason } : {}),
    ...(databaseRetrievalMode ? { databaseRetrievalMode } : {}),
    items,
    meta: {
      limit: input.pageSize,
      offset,
      total,
      hasMore,
      totalIsExact,
    },
    pageInfo: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      hasMore,
      totalIsExact,
    },
  }, 200, SEARCH_CACHE_CONTROL, requestId, MAX_SEARCH_RESPONSE_BYTES);
}

type SearchMode = "fulltext" | "semantic" | "hybrid";

type RetrievalPlan = {
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
  embedding: number[] | null;
  degraded: boolean;
  degradationReason?: "empty_query" | "embedding_not_configured" | "embedding_unavailable";
};

async function resolveRetrievalPlan(
  query: string,
  requestedMode: string,
  env: SearchWorkerEnv,
  fetcher: Fetcher,
  requestId: string,
): Promise<RetrievalPlan> {
  const normalizedMode = requestedMode as SearchMode;
  if (normalizedMode === "fulltext") {
    return { requestedMode: normalizedMode, effectiveMode: "fulltext", embedding: null, degraded: false };
  }
  if (!query) {
    return {
      requestedMode: normalizedMode,
      effectiveMode: "fulltext",
      embedding: null,
      degraded: true,
      degradationReason: "empty_query",
    };
  }
  if (isExactCasePreflightQuery(query)) {
    return {
      requestedMode: normalizedMode,
      effectiveMode: normalizedMode,
      embedding: null,
      degraded: false,
    };
  }
  if (
    env.SEMANTIC_SEARCH_ENABLED?.trim().toLowerCase() !== "true" ||
    (env.EMBEDDING_PROVIDER?.trim().toLowerCase() || "gemini") !== "gemini" ||
    !env.GEMINI_API_KEY?.trim()
  ) {
    return {
      requestedMode: normalizedMode,
      effectiveMode: "fulltext",
      embedding: null,
      degraded: true,
      degradationReason: "embedding_not_configured",
    };
  }

  const embedding = await createQueryEmbedding(query, env, fetcher, requestId);
  if (!embedding) {
    return {
      requestedMode: normalizedMode,
      effectiveMode: "fulltext",
      embedding: null,
      degraded: true,
      degradationReason: "embedding_unavailable",
    };
  }

  return {
    requestedMode: normalizedMode,
    effectiveMode: normalizedMode,
    embedding,
    degraded: false,
  };
}

function isExactCasePreflightQuery(query: string) {
  return hasExactCaseReference(query);
}

async function createQueryEmbedding(
  query: string,
  env: SearchWorkerEnv,
  fetcher: Fetcher,
  requestId: string,
): Promise<number[] | null> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

  try {
    const response = await fetcher(`${GEMINI_EMBEDDING_API}/${encodeURIComponent(model)}:embedContent`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: query }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EXPECTED_EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      console.warn(JSON.stringify({
        event: "worldcons_embedding_unavailable",
        status: response.status,
        requestId,
      }));
      return null;
    }

    const payload = requiredRecord(await readBoundedJson(response, MAX_EMBEDDING_RESPONSE_BYTES), "embedding response");
    const embeddingPayload = optionalRecord(payload.embedding);
    const rawEmbedding = Array.isArray(embeddingPayload?.values) ? embeddingPayload.values : [];
    if (rawEmbedding.length !== EXPECTED_EMBEDDING_DIMENSIONS) return null;
    const embedding = rawEmbedding.map((value) => finiteNumber(value));
    if (!embedding.every((value): value is number => value !== null)) return null;
    return normalizeEmbeddingVector(embedding, EXPECTED_EMBEDDING_DIMENSIONS);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "worldcons_embedding_unavailable",
      error: error instanceof Error ? error.name : "UnknownError",
      requestId,
    }));
    return null;
  }
}

async function sourcesResponse(env: SearchWorkerEnv, fetcher: Fetcher, requestId: string) {
  const rpcPayload = await callRpc(env, "worldcons_provider_sources_v1", {}, fetcher, requestId);
  const sources = Array.isArray(rpcPayload) ? rpcPayload : [];
  return jsonResponse({
    contractVersion: CONTRACT_VERSION,
    schemaVersion: 1,
    requestId,
    service: "worldcons",
    transport: "cloudflare-worker",
    items: sources.map((source) => {
      const row = requiredRecord(source, "source");
      const sourceKey = requiredString(row.sourceKey ?? row.source_key, "sourceKey");
      const context = sourceContextFor(sourceKey);
      const baseUrl = requiredOfficialUri(sourceKey, row.baseUrl ?? row.base_url);
      return {
        providerId: "worldcons",
        sourceKey,
        name: requiredString(row.name, "name"),
        institutionName: requiredString(row.name, "name"),
        courtName: requiredString(row.name, "name"),
        jurisdiction: requiredString(row.jurisdiction, "jurisdiction"),
        jurisdictionCode: context.jurisdictionCode,
        jurisdictionName: context.jurisdictionName,
        country: requiredString(row.jurisdiction, "jurisdiction"),
        countryCode: context.jurisdictionCode,
        countryName: context.jurisdictionName,
        baseUrl,
        officialUri: baseUrl,
        language: requiredString(row.language, "language"),
        isActive: row.isActive ?? row.is_active ?? true,
        sourceType: SOURCE_TYPE,
      };
    }),
  }, 200, DETAIL_CACHE_CONTROL, requestId, MAX_SOURCES_RESPONSE_BYTES);
}

async function articleResponse(
  url: URL,
  slug: string,
  sourceTextOnly: boolean,
  env: SearchWorkerEnv,
  fetcher: Fetcher,
  requestId: string,
) {
  if (!SLUG_PATTERN.test(slug)) {
    return errorResponse(400, "INVALID_REQUEST", "slug contains unsupported characters.", {}, requestId);
  }

  if (sourceTextOnly) {
    const textInput = parseSourceTextInput(url.searchParams);
    const rpcPayload = await callRpc(env, "worldcons_provider_source_text_v2", {
      p_slug: slug,
      p_offset: textInput.offset,
      p_limit: textInput.limit,
    }, fetcher, requestId);
    if (rpcPayload === null) {
      return errorResponse(404, "NOT_FOUND", "Article not found.", {}, requestId);
    }
    const row = requiredRecord(rpcPayload, "source text");
    const cleanedText = optionalString(row.cleaned_text);
    if (!cleanedText) {
      return errorResponse(404, "NOT_FOUND", "Source snapshot not found.", {}, requestId);
    }
    const boundedText = truncateUtf8(cleanedText, MAX_DETAIL_TEXT_BYTES);
    const offset = nonNegativeInteger(row.cleaned_text_offset) ?? textInput.offset;
    const totalChars = nonNegativeInteger(row.cleaned_text_total_chars) ?? unicodeCharacterLength(cleanedText);
    const returnedChars = unicodeCharacterLength(boundedText.text);
    const nextOffset = offset + returnedChars;
    const hasMore = Boolean(row.cleaned_text_has_more) || boundedText.truncated || nextOffset < totalChars;
    const bodyChecksum = normalizedSha256(row.content_hash);

    return jsonResponse({
      contractVersion: CONTRACT_VERSION,
      schemaVersion: 1,
      requestId,
      service: "worldcons",
      id: requiredString(row.id, "id"),
      slug: requiredString(row.slug, "slug"),
      cleanedText: boundedText.text,
      bodyExcerpt: truncatePlainText(boundedText.text, MAX_DETAIL_EXCERPT_CHARS),
      excerptKind: "document_section",
      ...(bodyChecksum ? { bodyChecksum, checksumAlgorithm: "sha256" } : {}),
      textPage: {
        offset,
        limit: textInput.limit,
        returnedChars,
        totalChars,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
      },
    }, 200, DETAIL_CACHE_CONTROL, requestId, MAX_SOURCE_TEXT_RESPONSE_BYTES);
  }

  const detailInput = parseDetailInput(url.searchParams);
  const rpcPayload = await callRpc(env, "worldcons_provider_article_v2", {
    p_slug: slug,
    p_text_limit: detailInput.textLimit,
  }, fetcher, requestId);
  if (rpcPayload === null) {
    return errorResponse(404, "NOT_FOUND", "Article not found.", {}, requestId);
  }

  const item = mapArticleDetail(rpcPayload, env.PUBLIC_BASE_URL);
  return jsonResponse({
    contractVersion: CONTRACT_VERSION,
    schemaVersion: 1,
    requestId,
    service: "worldcons",
    ...item,
  }, 200, DETAIL_CACHE_CONTROL, requestId, MAX_DETAIL_RESPONSE_BYTES);
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

function parseSourceTextInput(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    if (!SOURCE_TEXT_PARAMETERS.has(key)) {
      throw new RequestValidationError(`Unsupported parameter: ${key}`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw new RequestValidationError(`Parameter must appear once: ${key}`);
    }
  }
  return {
    offset: boundedInteger(searchParams.get("offset"), "offset", 0, 0, 10_000_000),
    limit: boundedInteger(searchParams.get("limit"), "limit", MAX_DETAIL_TEXT_CHARS, 1, MAX_DETAIL_TEXT_CHARS),
  };
}

function parseDetailInput(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    if (!DETAIL_PARAMETERS.has(key)) {
      throw new RequestValidationError(`Unsupported parameter: ${key}`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw new RequestValidationError(`Parameter must appear once: ${key}`);
    }
  }
  return {
    textLimit: boundedInteger(
      searchParams.get("textLimit"),
      "textLimit",
      MAX_DETAIL_TEXT_CHARS,
      1,
      MAX_DETAIL_TEXT_CHARS,
    ),
  };
}

function assertNoParameters(searchParams: URLSearchParams) {
  const first = searchParams.keys().next();
  if (!first.done) {
    throw new RequestValidationError(`Unsupported parameter: ${first.value}`);
  }
}

function mapSearchItem(value: unknown, publicBaseUrl: string) {
  const row = requiredRecord(value, "search item");
  const id = requiredString(row.id, "id");
  const slug = requiredString(row.slug, "slug");
  const sourceKey = requiredString(row.source_key, "source_key");
  const context = sourceContextFor(sourceKey);
  const officialUri = requiredOfficialUri(sourceKey, row.canonical_url, row.original_url);
  const rawSummaryJson = optionalRecord(row.summary_json);
  const rawSourceMetadata = optionalRecord(row.source_metadata);
  const summaryJson = boundedRecord(rawSummaryJson, MAX_SUMMARY_JSON_CHARS);
  const sourceMetadata = boundedRecord(rawSourceMetadata, MAX_SOURCE_METADATA_CHARS);
  const summaryRecord = optionalRecord(summaryJson?.summary);
  const coreSummary = stringArray(summaryRecord?.coreSummary);
  const supportingSummary = stringArray([
    summaryRecord?.background,
    summaryRecord?.implications,
    summaryRecord?.caseStructure,
    summaryRecord?.practicalNotes,
  ]);
  const oneLineSummary = truncatePlainText(
    coreSummary[0] ?? "요약이 아직 생성되지 않았습니다.",
    800,
  );
  const detailApiUrl = `${normalizedBaseUrl(publicBaseUrl)}/api/articles/${encodeURIComponent(slug)}`;
  const caseNumber = optionalString(row.case_number)
    ?? firstString(rawSourceMetadata, ["caseNumber", "case_number", "docketNumber", "docket_number"]);
  const institutionName = requiredString(row.institution_name, "institution_name");
  const jurisdiction = requiredString(row.jurisdiction, "jurisdiction");
  const decisionDate = dateOnly(row.original_published_at);
  const originalPublishedAt = optionalString(row.original_published_at);
  const bodyExcerpt = truncatePlainText(optionalString(row.body_excerpt) ?? "", MAX_BODY_EXCERPT_CHARS);
  const bodyChecksum = normalizedSha256(row.content_hash);
  const summaryText = truncatePlainText(coreSummary.join(" "), 4_000);
  const evidenceSummaryText = truncatePlainText(
    [...coreSummary, ...supportingSummary].join(" "),
    4_000,
  );
  const substantiveSnippet = truncatePlainText(
    [evidenceSummaryText, bodyExcerpt].filter(Boolean).join(" ") || oneLineSummary,
    800,
  );
  const sectionAnchors = bodyExcerpt
    ? [{
        kind: "passage",
        label: "보존 원문 발췌",
        locator: `cleanedText:0-${bodyExcerpt.length}`,
        startOffset: 0,
        endOffset: bodyExcerpt.length,
      }]
    : [];

  return {
    id,
    slug,
    providerId: "worldcons",
    authorityLevel: AUTHORITY_LEVEL,
    title: optionalString(row.korean_title) ?? optionalString(row.original_title) ?? "제목 미상",
    koreanTitle: optionalString(row.korean_title),
    originalTitle: optionalString(row.original_title),
    summary: summaryText || null,
    snippet: substantiveSnippet,
    oneLineSummary,
    summaryJson,
    bodyExcerpt: bodyExcerpt || null,
    excerptKind: "passage",
    ...(bodyChecksum ? { bodyChecksum, checksumAlgorithm: "sha256" } : {}),
    sectionAnchors,
    sourceType: SOURCE_TYPE,
    sourceKey,
    jurisdiction,
    jurisdictionCode: context.jurisdictionCode,
    jurisdictionName: context.jurisdictionName,
    country: jurisdiction,
    countryCode: context.jurisdictionCode,
    countryName: context.jurisdictionName,
    institutionName,
    courtName: institutionName,
    caseNumber,
    legalIdentity: {
      documentId: id,
      ...(caseNumber ? { caseNumber } : {}),
      court: institutionName,
      jurisdiction: context.jurisdictionCode,
    },
    contentType: requiredString(row.content_type, "content_type"),
    originalLanguage: requiredString(row.original_language, "original_language"),
    language: requiredString(row.original_language, "original_language"),
    originalPublishedAt,
    decisionDate,
    publishedAt: originalPublishedAt,
    ...(decisionDate ? {
      temporalValidity: {
        decisionDate,
        publishedAt: decisionDate,
      },
    } : {}),
    originalUrl: officialUri,
    canonicalUrl: officialUri,
    officialUrl: officialUri,
    officialUri,
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
      courtName: institutionName,
      jurisdictionCode: context.jurisdictionCode,
      originalTitle: optionalString(row.original_title),
      officialUrl: officialUri,
      officialUri,
      excerptKind: "passage",
      ...(bodyChecksum ? { bodyChecksum } : {}),
      detailApiUrl,
      sourceTextUrl: `${detailApiUrl}/source-text`,
    },
  };
}

function mapArticleDetail(value: unknown, publicBaseUrl: string) {
  const row = requiredRecord(value, "article detail");
  const item = mapSearchItem(row, publicBaseUrl);
  const rawText = optionalString(row.cleaned_text);
  const boundedText = truncateUtf8(rawText ?? "", MAX_DETAIL_TEXT_BYTES);
  const offset = nonNegativeInteger(row.cleaned_text_offset) ?? 0;
  const returnedChars = unicodeCharacterLength(boundedText.text);
  const totalChars = nonNegativeInteger(row.cleaned_text_total_chars) ?? returnedChars;
  const nextOffset = offset + returnedChars;
  const hasMore = Boolean(row.cleaned_text_has_more) || boundedText.truncated || nextOffset < totalChars;
  const bodyExcerpt = truncatePlainText(
    optionalString(row.body_excerpt) ?? boundedText.text,
    MAX_DETAIL_EXCERPT_CHARS,
  );
  const bodyChecksum = normalizedSha256(row.content_hash);
  return {
    ...item,
    cleanedText: boundedText.text || null,
    bodyExcerpt: bodyExcerpt || null,
    excerptKind: "document_section",
    ...(bodyChecksum ? { bodyChecksum, checksumAlgorithm: "sha256" } : {}),
    sectionAnchors: bodyExcerpt
      ? [{
          kind: "passage",
          label: "보존 원문 발췌",
          locator: `cleanedText:${offset}-${offset + bodyExcerpt.length}`,
          startOffset: offset,
          endOffset: offset + bodyExcerpt.length,
        }]
      : [],
    ...(bodyChecksum ? { contentHash: bodyChecksum } : {}),
    textPage: {
      offset,
      limit: nonNegativeInteger(row.cleaned_text_limit) ?? MAX_DETAIL_TEXT_CHARS,
      returnedChars,
      totalChars,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    },
  };
}

async function callRpc(
  env: SearchWorkerEnv,
  functionName: string,
  payload: JsonRecord,
  fetcher: Fetcher,
  requestId: string,
): Promise<unknown> {
  const endpoint = new URL(`/rest/v1/rpc/${functionName}`, normalizedSupabaseUrl(env.SUPABASE_URL));
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
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
      requestId,
    }));
    throw new Error("SupabaseRpcError");
  }
  return readBoundedJson(response, MAX_UPSTREAM_RPC_BYTES);
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

function requestIdFor(request: Request) {
  const provided = request.headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID_PATTERN.test(provided) ? provided : crypto.randomUUID();
}

function sourceContextFor(sourceKey: string) {
  const context = SOURCE_CONTEXT[sourceKey];
  if (!context) throw new Error(`Unsupported source contract: ${sourceKey}.`);
  return context;
}

function requiredOfficialUri(sourceKey: string, ...values: unknown[]) {
  const context = sourceContextFor(sourceKey);
  for (const value of values) {
    const candidate = optionalString(value);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase();
      const isOfficialHost = context.officialHostSuffixes.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
      );
      if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || (url.port && url.port !== "443")
        || !isOfficialHost
      ) {
        continue;
      }
      return url.toString();
    } catch {
      // Try the next source-owned URL candidate.
    }
  }
  throw new Error(`Malformed response: ${sourceKey} official HTTPS URI is required.`);
}

function dateOnly(value: unknown) {
  const raw = optionalString(value);
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizedSha256(value: unknown) {
  const hash = optionalString(value)?.toLowerCase() ?? "";
  return SHA256_PATTERN.test(hash) ? hash : null;
}

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
  return [...names]
    .slice(0, MAX_TAGS)
    .map((name) => truncatePlainText(name, 120))
    .filter(Boolean);
}

function boundedRecord(value: unknown, maxChars: number): JsonRecord | null {
  const record = optionalRecord(value);
  if (!record) return null;
  if (JSON.stringify(record).length <= maxChars) return record;

  const attempts = [
    { maxStringLength: 1_000, maxEntries: 24, maxDepth: 5 },
    { maxStringLength: 500, maxEntries: 16, maxDepth: 4 },
    { maxStringLength: 240, maxEntries: 12, maxDepth: 4 },
    { maxStringLength: 100, maxEntries: 8, maxDepth: 3 },
  ];
  for (const attempt of attempts) {
    const compacted = compactJsonValue(record, attempt, 0);
    const compactedRecord = optionalRecord(compacted);
    if (compactedRecord && JSON.stringify(compactedRecord).length <= maxChars) {
      return compactedRecord;
    }
  }
  return { truncated: true };
}

function compactJsonValue(
  value: unknown,
  limits: { maxStringLength: number; maxEntries: number; maxDepth: number },
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncatePlainText(value, limits.maxStringLength);
  if (depth >= limits.maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxEntries)
      .map((item) => compactJsonValue(item, limits, depth + 1));
  }
  const record = optionalRecord(value);
  if (!record) return String(value);
  return Object.fromEntries(
    prioritizedEntries(record)
      .slice(0, limits.maxEntries)
      .map(([key, item]) => [key, compactJsonValue(item, limits, depth + 1)]),
  );
}

function prioritizedEntries(record: JsonRecord) {
  const priority = new Map([
    ["summary", 0],
    ["coreSummary", 1],
    ["background", 2],
    ["issues", 3],
    ["holding", 4],
    ["reasoning", 5],
    ["order", 6],
    ["caseNumber", 7],
    ["tags", 8],
  ]);
  return Object.entries(record).sort(
    ([left], [right]) => (priority.get(left) ?? 100) - (priority.get(right) ?? 100),
  );
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

function truncateUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

function unicodeCharacterLength(value: string) {
  return Array.from(value).length;
}

async function readBoundedJson(response: Response, maxBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error("SupabaseRpcResponseTooLarge");
  }
  if (!response.body) throw new Error("SupabaseRpcEmptyResponse");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("SupabaseRpcResponseTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function jsonResponse(
  body: unknown,
  status: number,
  cacheControl: string,
  requestId: string,
  maxBytes: number,
) {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    return errorResponse(
      503,
      "RESPONSE_TOO_LARGE",
      "The bounded WorldCons response could not be produced.",
      { "Retry-After": "30" },
      requestId,
    );
  }
  return new Response(serialized, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(byteLength),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "X-Provider-Contract-Version": CONTRACT_VERSION,
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
  requestId: string = crypto.randomUUID(),
) {
  return new Response(JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    schemaVersion: 1,
    requestId,
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
      "X-Provider-Contract-Version": CONTRACT_VERSION,
      "X-Request-Id": requestId,
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
