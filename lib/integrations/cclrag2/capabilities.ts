/** Provider-owned contract discovery. These are supported contracts, not live health claims. */
export const WORLDCONS_PROVIDER_CONTRACT_VERSION = "2.0";
export const WORLDCONS_CAPABILITIES_SCHEMA_VERSION = 1;
export const WORLDCONS_SEARCH_MODES = Object.freeze(["fulltext", "semantic", "hybrid"] as const);
export const WORLDCONS_COUNT_MODES = Object.freeze(["exact", "planned", "estimated", "none"] as const);
export const WORLDCONS_RANGE_VALUES = Object.freeze(["latest", "today", "week", "month"] as const);
export const WORLDCONS_SEARCH_PARAMETERS = Object.freeze([
  "q", "mode", "page", "pageSize", "count", "jurisdiction", "source", "range",
] as const);
export const WORLDCONS_PROVIDER_LIMITS = Object.freeze({
  queryChars: 200,
  filterChars: 80,
  page: 500,
  defaultPageSize: 10,
  pageSize: 20,
  searchOffset: 10_000,
  textChars: 350_000,
  textOffset: 10_000_000,
  textBytes: 1_200_000,
  bodyExcerptChars: 4_000,
  detailExcerptChars: 16_000,
  capabilitiesResponseBytes: 32_000,
  searchResponseBytes: 1_500_000,
  sourcesResponseBytes: 200_000,
  detailResponseBytes: 1_900_000,
  sourceTextResponseBytes: 1_800_000,
});

/** Shared with response identity and official URI validation. */
export const WORLDCONS_PROVIDER_SOURCES = Object.freeze({
  "de-bverfg": Object.freeze({
    jurisdictionCode: "DE", jurisdictionName: "독일", language: "de",
    officialHostSuffixes: Object.freeze(["bundesverfassungsgericht.de"]),
  }),
  "es-tribunal-constitucional": Object.freeze({
    jurisdictionCode: "ES", jurisdictionName: "스페인", language: "es",
    officialHostSuffixes: Object.freeze(["tribunalconstitucional.es"]),
  }),
  "fr-conseil-constitutionnel": Object.freeze({
    jurisdictionCode: "FR", jurisdictionName: "프랑스", language: "fr",
    officialHostSuffixes: Object.freeze(["conseil-constitutionnel.fr"]),
  }),
  "us-scotus": Object.freeze({
    jurisdictionCode: "US", jurisdictionName: "미국", language: "en",
    officialHostSuffixes: Object.freeze(["supremecourt.gov"]),
  }),
});

/** Fresh JSON-safe values prevent a caller from mutating the provider's source of truth. */
export function getWorldconsProviderCapabilities() {
  const limits = WORLDCONS_PROVIDER_LIMITS;
  return {
    schemaVersion: WORLDCONS_CAPABILITIES_SCHEMA_VERSION,
    contractVersion: WORLDCONS_PROVIDER_CONTRACT_VERSION,
    service: "worldcons" as const,
    providerId: "worldcons" as const,
    sourceType: "foreign_constitutional" as const,
    authorityLevel: "persuasive" as const,
    discoveryKind: "contract" as const,
    authentication: "none" as const,
    publicationScope: "published_only" as const,
    apiBasePath: "/api/cclrag2" as const,
    endpoints: {
      capabilities: { method: "GET", path: "/capabilities", maxResponseBytes: limits.capabilitiesResponseBytes },
      search: { method: "GET", path: "/search", maxResponseBytes: limits.searchResponseBytes },
      sources: { method: "GET", path: "/sources", maxResponseBytes: limits.sourcesResponseBytes },
      detail: { method: "GET", path: "/articles/{slug}", maxResponseBytes: limits.detailResponseBytes },
      sourceText: { method: "GET", path: "/articles/{slug}/source-text", maxResponseBytes: limits.sourceTextResponseBytes },
    },
    search: {
      parameters: [...WORLDCONS_SEARCH_PARAMETERS],
      modes: [...WORLDCONS_SEARCH_MODES],
      defaultMode: "hybrid" as const,
      countModes: [...WORLDCONS_COUNT_MODES],
      defaultCount: "none" as const,
      ranges: [...WORLDCONS_RANGE_VALUES],
      defaultRange: "latest" as const,
      pagination: "page" as const,
      limits: {
        maxQueryChars: limits.queryChars, maxFilterChars: limits.filterChars,
        minPage: 1, maxPage: limits.page, defaultPage: 1,
        minPageSize: 1, maxPageSize: limits.pageSize, defaultPageSize: limits.defaultPageSize,
        maxOffset: limits.searchOffset,
      },
      exactCaseReference: true,
      semanticRequiresConfiguration: true,
      fallbackMode: "fulltext" as const,
      degradationReasons: ["empty_query", "embedding_not_configured", "embedding_unavailable"],
      modeEvidence: ["requestedMode", "effectiveMode", "degraded", "degradationReason", "databaseRetrievalMode"],
      totalIsExactField: "totalIsExact" as const,
    },
    detail: { parameters: ["textLimit"], defaultTextLimit: limits.textChars, maxTextLimit: limits.textChars },
    sourceText: {
      parameters: ["offset", "limit"], pagination: "offset" as const, offsetUnit: "unicode_code_point" as const,
      minOffset: 0, maxOffset: limits.textOffset, defaultOffset: 0,
      minLimit: 1, maxLimit: limits.textChars, defaultLimit: limits.textChars,
      maxTextBytes: limits.textBytes, continuationField: "textPage.nextOffset" as const,
      checksumAlgorithm: "sha256" as const, checksumScope: "complete_source_snapshot" as const,
    },
    evidence: {
      fields: ["legalIdentity", "officialUri", "temporalValidity", "bodyExcerpt", "bodyChecksum", "sectionAnchors", "summaryJson"],
      optionalFields: ["caseNumber", "decisionDate", "bodyChecksum", "summaryJson"],
      maxSearchExcerptChars: limits.bodyExcerptChars, maxDetailExcerptChars: limits.detailExcerptChars,
    },
    sources: Object.entries(WORLDCONS_PROVIDER_SOURCES).map(([sourceKey, source]) => ({
      sourceKey, jurisdictionCode: source.jurisdictionCode, jurisdictionName: source.jurisdictionName,
      originalLanguage: source.language, officialHostSuffixes: [...source.officialHostSuffixes],
    })),
  };
}

export type WorldconsProviderCapabilities = ReturnType<typeof getWorldconsProviderCapabilities>;
