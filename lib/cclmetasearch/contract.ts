export const CCL_METASEARCH_TOKEN_HEADER = "x-ccl-metasearch-token";
export const CCL_METASEARCH_MAX_LIMIT = 20;
export const CCL_METASEARCH_MAX_OFFSET = 10_000;
export const CCL_METASEARCH_MAX_QUERY_LENGTH = 200;

export type CclMetasearchSort = "relevance" | "latest";

export type CclMetasearchSearchInput = {
  query: string;
  limit: number;
  offset: number;
  sort: CclMetasearchSort;
};

export type CclMetasearchItem = {
  id: string;
  canonicalId: string;
  title: string;
  originalTitle: string | null;
  countryCode: string;
  countryName: string;
  courtName: string;
  sourceKey: string;
  caseNumber: string | null;
  decisionDate: string | null;
  decisionYear: number | null;
  originalLanguage: string;
  summary: string | null;
  snippet: string | null;
  keywords: string[];
  topics: string[];
  originalUrl: string | null;
  worldconsUrl: string;
  detailUrl: string;
  updatedAt: string | null;
  relevanceScore: number | null;
};

export type CclMetasearchSearchPage = {
  items: CclMetasearchItem[];
  total: number;
};

export class CclMetasearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CclMetasearchRequestError";
  }
}

const ALLOWED_PARAMETERS = new Set(["q", "keyword", "limit", "offset", "sort"]);
const SEARCHABLE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function parseCclMetasearchSearchParams(searchParams: URLSearchParams): CclMetasearchSearchInput {
  for (const name of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(name)) {
      throw new CclMetasearchRequestError(`Unsupported parameter: ${name}`);
    }

    if (searchParams.getAll(name).length > 1) {
      throw new CclMetasearchRequestError(`Parameter must appear once: ${name}`);
    }
  }

  const q = normalizedQuery(searchParams.get("q"));
  const keyword = normalizedQuery(searchParams.get("keyword"));
  if (q && keyword && q !== keyword) {
    throw new CclMetasearchRequestError("q and keyword must have the same value when both are provided.");
  }

  const query = q || keyword;
  if (!query) {
    throw new CclMetasearchRequestError("A non-empty q or keyword parameter is required.");
  }
  if (query.length > CCL_METASEARCH_MAX_QUERY_LENGTH) {
    throw new CclMetasearchRequestError(`q must be at most ${CCL_METASEARCH_MAX_QUERY_LENGTH} characters.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(query) || !SEARCHABLE_CHARACTER_PATTERN.test(query)) {
    throw new CclMetasearchRequestError("q must contain a searchable letter or number and no control characters.");
  }

  const limit = parseInteger(searchParams.get("limit"), "limit", 10, 1, CCL_METASEARCH_MAX_LIMIT);
  const offset = parseInteger(searchParams.get("offset"), "offset", 0, 0, CCL_METASEARCH_MAX_OFFSET);
  const sortValue = searchParams.get("sort")?.trim() || "relevance";
  if (sortValue !== "relevance" && sortValue !== "latest") {
    throw new CclMetasearchRequestError("sort must be relevance or latest.");
  }

  return { query, limit, offset, sort: sortValue };
}

function normalizedQuery(value: string | null) {
  return value?.trim().normalize("NFKC") ?? "";
}

function parseInteger(value: string | null, name: string, fallback: number, min: number, max: number) {
  if (value === null || value === "") return fallback;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new CclMetasearchRequestError(`${name} must be an integer between ${min} and ${max}.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CclMetasearchRequestError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}
