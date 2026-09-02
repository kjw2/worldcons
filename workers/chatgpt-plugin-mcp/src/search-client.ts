import { WorldconsToolError } from "./errors";

const MAX_SEARCH_RESPONSE_BYTES = 1_500_000;
const MAX_DETAIL_RESPONSE_BYTES = 1_900_000;
const MAX_SOURCES_RESPONSE_BYTES = 200_000;
const MAX_SOURCE_TEXT_RESPONSE_BYTES = 1_800_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type JsonRecord = Record<string, unknown>;

export type SearchFilters = {
  query?: string;
  jurisdiction?: string;
  source?: string;
  range?: "latest" | "today" | "week" | "month";
  limit?: number;
};

export type WorldconsSearchClientOptions = {
  searchApi: Fetcher;
  siteBaseUrl: string;
  detailTextLimit: number;
  sourceTextPageLimit: number;
};

export class WorldconsSearchClient {
  private readonly searchApi: Fetcher;
  private readonly siteBaseUrl: string;
  readonly detailTextLimit: number;
  readonly sourceTextPageLimit: number;

  constructor(options: WorldconsSearchClientOptions) {
    this.searchApi = options.searchApi;
    this.siteBaseUrl = normalizedHttpsBaseUrl(options.siteBaseUrl);
    this.detailTextLimit = options.detailTextLimit;
    this.sourceTextPageLimit = options.sourceTextPageLimit;
  }

  async search(filters: SearchFilters, requestId: string) {
    const params = new URLSearchParams({
      q: filters.query?.trim() ?? "",
      mode: "hybrid",
      pageSize: String(filters.limit ?? 10),
      count: "none",
      range: filters.range ?? "latest",
    });
    if (filters.jurisdiction) params.set("jurisdiction", filters.jurisdiction);
    if (filters.source) params.set("source", filters.source);

    const payload = await this.getJson(
      `/api/search?${params.toString()}`,
      requestId,
      MAX_SEARCH_RESPONSE_BYTES,
    );
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.slice(0, filters.limit ?? 10).map((value) => this.mapSearchItem(value));
  }

  async fetchArticle(slug: string, requestId: string) {
    assertSlug(slug);
    const payload = await this.getJson(
      `/api/articles/${encodeURIComponent(slug)}?textLimit=${this.detailTextLimit}`,
      requestId,
      MAX_DETAIL_RESPONSE_BYTES,
    );
    return this.mapArticle(payload);
  }

  async listSources(requestId: string) {
    const payload = await this.getJson("/api/sources", requestId, MAX_SOURCES_RESPONSE_BYTES);
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.map((value) => {
      const item = requiredRecord(value, "source");
      return {
        sourceKey: requiredString(item.sourceKey, "sourceKey"),
        name: requiredString(item.name, "name"),
        jurisdiction: requiredString(item.jurisdiction, "jurisdiction"),
        jurisdictionCode: optionalString(item.jurisdictionCode),
        countryName: optionalString(item.countryName),
        language: requiredString(item.language, "language"),
        officialUrl: requiredHttpsUrl(item.officialUri ?? item.baseUrl, "officialUrl"),
      };
    });
  }

  async fetchSourceText(slug: string, offset: number, limit: number, requestId: string) {
    assertSlug(slug);
    const effectiveLimit = Math.min(limit, this.sourceTextPageLimit);
    const params = new URLSearchParams({ offset: String(offset), limit: String(effectiveLimit) });
    const payload = await this.getJson(
      `/api/articles/${encodeURIComponent(slug)}/source-text?${params.toString()}`,
      requestId,
      MAX_SOURCE_TEXT_RESPONSE_BYTES,
    );
    const page = optionalRecord(payload.textPage) ?? {};
    return {
      id: requiredString(payload.slug, "slug"),
      text: optionalString(payload.cleanedText) ?? "",
      bodyChecksum: optionalString(payload.bodyChecksum),
      offset: nonNegativeInteger(page.offset) ?? offset,
      returnedChars: nonNegativeInteger(page.returnedChars) ?? 0,
      totalChars: nonNegativeInteger(page.totalChars),
      hasMore: page.hasMore === true,
      nextOffset: nonNegativeInteger(page.nextOffset),
      url: this.articleUrl(slug),
    };
  }

  async health(requestId: string) {
    await this.getJson("/api/sources", requestId, MAX_SOURCES_RESPONSE_BYTES);
  }

  private mapSearchItem(value: unknown) {
    const item = requiredRecord(value, "search item");
    const slug = requiredString(item.slug, "slug");
    assertSlug(slug);
    return {
      id: slug,
      title: requiredString(item.title, "title"),
      url: this.articleUrl(slug),
      originalTitle: optionalString(item.originalTitle),
      summary: optionalString(item.summary),
      snippet: optionalString(item.snippet),
      sourceKey: requiredString(item.sourceKey, "sourceKey"),
      jurisdiction: requiredString(item.jurisdiction, "jurisdiction"),
      countryName: optionalString(item.countryName),
      court: requiredString(item.courtName ?? item.institutionName, "courtName"),
      caseNumber: optionalString(item.caseNumber),
      decisionDate: optionalString(item.decisionDate),
      officialUrl: requiredHttpsUrl(item.officialUri ?? item.officialUrl, "officialUrl"),
      tags: stringArray(item.tags).slice(0, 20),
    };
  }

  private mapArticle(payload: JsonRecord) {
    const item = this.mapSearchItem(payload);
    const summaryJson = optionalRecord(payload.summaryJson);
    const summary = optionalRecord(summaryJson?.summary);
    const textPage = optionalRecord(payload.textPage) ?? {};
    return {
      ...item,
      koreanSummary: {
        coreSummary: stringArray(summary?.coreSummary),
        background: optionalString(summary?.background),
        caseStructure: optionalString(summary?.caseStructure),
        implications: optionalString(summary?.implications),
        practicalNotes: optionalString(summary?.practicalNotes),
        referencedProvisions: stringArray(summary?.referencedProvisions),
      },
      sourceExcerpt: optionalString(payload.cleanedText) ?? optionalString(payload.bodyExcerpt),
      originalLanguage: optionalString(payload.originalLanguage),
      contentType: optionalString(payload.contentType),
      bodyChecksum: optionalString(payload.bodyChecksum),
      textPage: {
        offset: nonNegativeInteger(textPage.offset) ?? 0,
        returnedChars: nonNegativeInteger(textPage.returnedChars) ?? 0,
        totalChars: nonNegativeInteger(textPage.totalChars),
        hasMore: textPage.hasMore === true,
        nextOffset: nonNegativeInteger(textPage.nextOffset),
      },
    };
  }

  private articleUrl(slug: string) {
    return `${this.siteBaseUrl}/articles/${encodeURIComponent(slug)}`;
  }

  private async getJson(path: string, requestId: string, maxBytes: number) {
    let response: Response;
    try {
      response = await this.searchApi.fetch(`https://worldcons-search-api.internal${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Request-Id": requestId,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new WorldconsToolError(
        "SERVICE_UNAVAILABLE",
        "헌법판례 검색 서비스에 연결할 수 없습니다.",
        { retryable: true },
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) {
        throw new WorldconsToolError("NOT_FOUND", "요청한 공개 판례를 찾을 수 없습니다.");
      }
      if (response.status === 400) {
        throw new WorldconsToolError("INVALID_REQUEST", "판례 조회 조건이 올바르지 않습니다.");
      }
      if (response.status === 429) {
        throw new WorldconsToolError(
          "RATE_LIMITED",
          "요청이 많아 판례 검색이 잠시 제한되었습니다.",
          { retryable: true, retryAfter: normalizedRetryAfter(response.headers.get("retry-after")) },
        );
      }
      throw new WorldconsToolError(
        "SERVICE_UNAVAILABLE",
        "헌법판례 검색 서비스가 일시적으로 응답하지 않습니다.",
        { retryable: true },
      );
    }

    const value = await readBoundedJson(response, maxBytes);
    return requiredRecord(value, "response");
  }
}

function normalizedHttpsBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("SITE_BASE_URL must be a public HTTPS URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function assertSlug(value: string) {
  if (!SLUG_PATTERN.test(value)) {
    throw new WorldconsToolError("INVALID_REQUEST", "판례 식별자가 올바르지 않습니다.");
  }
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
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`Malformed response: ${label} is required.`);
  return normalized;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredHttpsUrl(value: unknown, label: string) {
  const normalized = requiredString(value, label);
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Malformed response: ${label} must be HTTPS.`);
  }
  return url.toString();
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedRetryAfter(value: string | null) {
  return value && /^(?:[1-9]\d{0,3})$/u.test(value) ? value : "30";
}

async function readBoundedJson(response: Response, maxBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new WorldconsToolError("RESPONSE_TOO_LARGE", "검색 응답이 허용된 크기를 초과했습니다.");
  }
  if (!response.body) throw new Error("Empty response body.");

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
        throw new WorldconsToolError("RESPONSE_TOO_LARGE", "검색 응답이 허용된 크기를 초과했습니다.");
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
