import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  WorldconsCaseService,
  type WorldconsCaseRepository,
} from "../lib/chatgpt-plugin/case-service";
import { publicSourceAttribution } from "../lib/case-catalog/source-attribution";
import { handleWorldconsMcpRequest } from "../lib/chatgpt-plugin/http-handler";
import { CatalogSearchCursorError } from "../lib/search/case-catalog";

const fixtureArticle = {
  id: "article-1",
  slug: "germany-neubauer",
  sourceKey: "de-bverfg",
  jurisdiction: "Germany",
  institutionName: "Bundesverfassungsgericht",
  contentType: "decision" as const,
  originalUrl: "https://www.bundesverfassungsgericht.de/example",
  canonicalUrl: "https://www.bundesverfassungsgericht.de/example",
  originalLanguage: "de",
  originalTitle: "Klimabeschluss",
  koreanTitle: "독일 연방헌법재판소 기후보호법 결정",
  originalPublishedAt: "2021-03-24",
  caseNumber: "1 BvR 2656/18",
  status: "summarized" as const,
  tags: [{
    slug: "climate-protection",
    name: "기후보호",
    normalizedName: "기후보호",
    type: "topic" as const,
  }],
  oneLineSummary: "미래세대의 자유와 기후보호 의무를 다룬 결정",
  summaryJson: {
    koreanTitle: "독일 연방헌법재판소 기후보호법 결정",
    summary: {
      coreSummary: ["기후보호 부담의 세대 간 배분을 헌법상 자유의 관점에서 심사했다."],
      background: "기후보호법의 감축 경로가 문제 되었다.",
      caseStructure: "헌법소원",
      implications: "미래 자유에 대한 선제적 보호를 확인했다.",
      practicalNotes: "공식 결정문을 확인해야 한다.",
      referencedProvisions: [{
        jurisdiction: "Germany",
        lawName: "기본법",
        article: "제20a조",
        description: "국가의 환경보호 의무",
        confidence: "high" as const,
      }],
    },
    entities: [],
    tags: ["기후보호"],
    categories: [],
    riskFlags: [],
  },
  cleanedText: "공식 독일어 결정문 발췌와 다음 공식 원문 구간",
  contentHash: "abc123",
  sourceMetadata: null,
};

const franceInventoryMetadata = {
  dila: {
    id: "CONSTEXT000050783534",
    nature: "QPC",
    ecli: "ECLI:FR:CC:2024:2024.1115.QPC",
    decisionNumber: "2024-1115",
    qualifiedNature: "QPC",
    archiveMemberPath: "constit/global/CONS/TEXT/00/00/50/78/35/CONSTEXT000050783534.xml",
  },
  stock: {
    filename: "Freemium_constit_global_20250713-140000.tar.gz",
    url: "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz",
    extractedAt: "2025-07-13T14:00:00.000Z",
    lastModified: "Sun, 13 Jul 2025 14:00:00 GMT",
    etag: null,
    contentLength: 12_511_366,
    sha256: "6".repeat(64),
  },
  license: {
    id: "licence-ouverte-2.0",
    url: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
    attribution: "DILA",
  },
};

function fixtureRepository(calls: string[]): WorldconsCaseRepository {
  return {
    async search(filters) {
      calls.push(`search:${filters.q ?? ""}:${filters.pageSize ?? ""}`);
      return {
        items: [fixtureArticle],
        pageInfo: {
          page: 1,pageSize: filters.pageSize ?? 10,total: 2,hasMore: true,nextCursor: "next-cursor",
        },
        retrievalMode: "rrf",
        rankingVersion: "gate4-multilingual-rrf-v1:fixture:123456789abc",
      };
    },
    async getArticle(slug) {
      calls.push(`article:${slug}`);
      return slug === fixtureArticle.slug ? fixtureArticle : null;
    },
    async getSourceText(slug) {
      calls.push(`source-text:${slug}`);
      return slug === fixtureArticle.slug ? {
        slug,
        sourceKey: fixtureArticle.sourceKey,
        sourceMetadata: fixtureArticle.sourceMetadata,
        officialUrl: fixtureArticle.originalUrl,
        cleanedText: fixtureArticle.cleanedText,
        contentHash: fixtureArticle.contentHash,
      } : null;
    },
    async getSources() {
      calls.push("sources");
      return [{
        id: "source-1",
        sourceKey: "de-bverfg",
        name: "Bundesverfassungsgericht",
        jurisdiction: "Germany",
        baseUrl: "https://www.bundesverfassungsgericht.de/",
        language: "de",
        isActive: true,
      }];
    },
  };
}

function service(calls: string[] = []) {
  return new WorldconsCaseService({
    repository: fixtureRepository(calls),
    siteBaseUrl: "https://worldcons.vercel.app",
    detailTextLimit: 24,
    sourceTextPageLimit: 12,
  });
}

test("Vercel-integrated case service exposes bounded public evidence and canonical citation URLs", async () => {
  const calls: string[] = [];
  const api = service(calls);
  const results = await api.search({ query: "기후 자유", jurisdiction: "Germany", limit: 3 });
  const article = await api.fetchArticle("germany-neubauer");
  const sourceText = await api.fetchSourceText("germany-neubauer", 12, 50_000);

  assert.equal(results[0].url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.equal(results[0].officialUrl, "https://www.bundesverfassungsgericht.de/example");
  assert.equal(article.koreanSummary?.coreSummary.length, 1);
  assert.equal(article.sourceExcerpt?.length, 24);
  assert.equal(sourceText.text.length, 12);
  assert.equal(sourceText.url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.deepEqual(calls, [
    "search:기후 자유:3",
    "article:germany-neubauer",
    "source-text:germany-neubauer",
  ]);
});

test("France search, fetch, and source-text responses expose one sealed Korean DILA attribution contract", async () => {
  const franceArticle = {
    ...fixtureArticle,
    slug: "fr-conseil-2024-1115-qpc",
    sourceKey: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    originalUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
    canonicalUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
    originalLanguage: "fr",
    originalTitle: "Décision n° 2024-1115 QPC du 13 décembre 2024",
    koreanTitle: null,
    caseNumber: "2024-1115 QPC",
    summaryJson: null,
    summaryAvailable: false,
    enrichmentStatus: "source_only" as const,
    summaryStatus: "pending" as const,
    sourceMetadata: { sourceInventory: franceInventoryMetadata },
  };
  const repository: WorldconsCaseRepository = {
    async search(filters) {
      return { items: [franceArticle],pageInfo: { page: 1,pageSize: filters.pageSize ?? 10,total: 1 } };
    },
    async getArticle(slug) {
      return slug === franceArticle.slug ? franceArticle : null;
    },
    async getSourceText(slug) {
      return slug === franceArticle.slug ? {
        slug,
        sourceKey: franceArticle.sourceKey,
        sourceMetadata: franceArticle.sourceMetadata,
        officialUrl: franceArticle.originalUrl,
        cleanedText: franceArticle.cleanedText,
        contentHash: franceArticle.contentHash,
      } : null;
    },
    async getSources() { return []; },
  };
  const api = new WorldconsCaseService({ repository,siteBaseUrl: "https://worldcons.vercel.app" });
  const searchResult = (await api.search({ query: "2024-1115 QPC" }))[0];
  const sourceText = await api.fetchSourceText(franceArticle.slug, 0, 10);
  assert.equal(searchResult.sourceAttribution?.provider, "DILA");
  assert.equal(sourceText.sourceAttribution?.stockTimestamp, "2025-07-13T14:00:00.000Z");
  assert.equal(sourceText.officialUrl, franceArticle.originalUrl);

  const response = await handleWorldconsMcpRequest(new Request("https://worldcons.vercel.app/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",id: 31,method: "tools/call",params: { name: "fetch",arguments: { id: franceArticle.slug } },
    }),
  }), api);
  const payload = await response.json() as {
    result: { structuredContent: {
      text: string;
      metadata: { sourceAttribution: { dilaId: string; licenseUrl: string; notice: string } };
    } };
  };
  assert.match(payload.result.structuredContent.text, /공식 데이터 출처와 이용조건/u);
  assert.match(payload.result.structuredContent.text, /프랑스 법률·행정정보국\(DILA\)/u);
  assert.match(payload.result.structuredContent.text, /Freemium_constit_global_20250713-140000[.]tar[.]gz/u);
  assert.match(payload.result.structuredContent.text, /공식 원문은 AI 생성물이 아닙니다/u);
  assert.match(payload.result.structuredContent.text, /보증을 의미하지 않습니다/u);
  assert.equal(payload.result.structuredContent.metadata.sourceAttribution.dilaId, "CONSTEXT000050783534");
  assert.equal(payload.result.structuredContent.metadata.sourceAttribution.licenseUrl, franceInventoryMetadata.license.url);

  const sourceResponse = await handleWorldconsMcpRequest(new Request("https://worldcons.vercel.app/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",id: 32,method: "tools/call",
      params: { name: "fetch_source_text",arguments: { id: franceArticle.slug,offset: 0,limit: 10 } },
    }),
  }), api);
  const sourcePayload = await sourceResponse.json() as {
    result: { structuredContent: { officialUrl: string; sourceAttribution: { stockFilename: string } } };
  };
  assert.equal(sourcePayload.result.structuredContent.officialUrl, franceArticle.originalUrl);
  assert.equal(sourcePayload.result.structuredContent.sourceAttribution.stockFilename, franceInventoryMetadata.stock.filename);

  assert.equal(publicSourceAttribution("fr-conseil-constitutionnel", {
    case: { sourceInventory: franceInventoryMetadata },
  })?.stockSha256, "6".repeat(64));
  assert.equal(publicSourceAttribution("fr-conseil-constitutionnel", {
    sourceInventory: { ...franceInventoryMetadata,license: { ...franceInventoryMetadata.license,attribution: "Conseil" } },
  }), null);
});

test("expired Gate 4 ranking cursors tell ChatGPT to restart without mutating the cursor", async () => {
  const repository: WorldconsCaseRepository = {
    async search() {
      throw new CatalogSearchCursorError("expired");
    },
    async getArticle() { return null; },
    async getSourceText() { return null; },
    async getSources() { return []; },
  };
  const api = new WorldconsCaseService({ repository,siteBaseUrl: "https://worldcons.vercel.app" });
  await assert.rejects(
    api.searchPage({ query: "게리맨더링",cursor: "opaque-cursor" }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "CURSOR_EXPIRED"
      && /첫 페이지/u.test(error.message),
  );
});

test("ChatGPT can initialize the Vercel MCP endpoint, scan tools, and call search", async () => {
  const api = service();
  const rpc = (body: object) => handleWorldconsMcpRequest(new Request("https://worldcons.vercel.app/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify(body),
  }), api);

  const initialize = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "worldcons-contract-test", version: "1.0.0" },
    },
  });
  const initialized = await initialize.json() as { result: { serverInfo: { name: string } } };
  assert.equal(initialize.status, 200);
  assert.equal(initialized.result.serverInfo.name, "worldcons-constitutional-cases");

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await list.json() as {
    result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> };
  };
  assert.equal(list.status, 200);
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ["fetch", "fetch_source_text", "list_sources", "search", "search_cases"],
  );
  assert.ok(listed.result.tools.every((tool) =>
    tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));

  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search", arguments: { query: "기후 자유" } },
  });
  const called = await call.json() as {
    result: { isError?: boolean; structuredContent: {
      results: Array<{ id: string; url: string; enrichmentStatus: string }>;
      nextCursor: string | null;
    } };
  };
  assert.equal(call.status, 200);
  assert.notEqual(called.result.isError, true);
  assert.equal(called.result.structuredContent.results[0].id, "germany-neubauer");
  assert.equal(called.result.structuredContent.results[0].url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.equal(called.result.structuredContent.results[0].enrichmentStatus, "full");
  assert.equal(called.result.structuredContent.nextCursor, "next-cursor");
  assert.equal(call.headers.get("access-control-allow-origin"), "*");
});

test("source-only and stale fetches disclose status without emitting an AI-summary heading or body", async () => {
  const sourceOnlyArticle = {
    ...fixtureArticle,
    slug: "spain-source-only",
    koreanTitle: null,
    summaryJson: null,
    enrichmentStatus: "source_only" as const,
    enrichmentFreshness: null,
    summaryStatus: "pending" as const,
    summaryAvailable: false,
  };
  const staleArticle = {
    ...fixtureArticle,
    slug: "spain-source-correction",
    koreanTitle: null,
    enrichmentStatus: "full" as const,
    enrichmentFreshness: "stale" as const,
    summaryStatus: "reprocessing" as const,
    summaryAvailable: false,
  };
  const repository: WorldconsCaseRepository = {
    async search(filters) {
      return { items: [staleArticle],pageInfo: { page: 1,pageSize: filters.pageSize ?? 10,total: 1 } };
    },
    async getArticle(slug) {
      if (slug === sourceOnlyArticle.slug) return sourceOnlyArticle;
      return slug === staleArticle.slug ? staleArticle : null;
    },
    async getSourceText(slug) {
      return slug === staleArticle.slug ? { slug,cleanedText: staleArticle.cleanedText,contentHash: staleArticle.contentHash } : null;
    },
    async getSources() {
      return [];
    },
  };
  const api = new WorldconsCaseService({ repository,siteBaseUrl: "https://worldcons.vercel.app" });
  const sourceOnly = await api.fetchArticle(sourceOnlyArticle.slug);
  const article = await api.fetchArticle(staleArticle.slug);
  assert.equal(sourceOnly.koreanSummary, null);
  assert.equal(sourceOnly.enrichmentStatus, "source_only");
  assert.equal(sourceOnly.summaryStatus, "pending");
  assert.equal(article.koreanSummary, null);
  assert.equal(article.summaryAvailable, false);

  const response = await handleWorldconsMcpRequest(new Request("https://worldcons.vercel.app/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",id: 4,method: "tools/call",params: { name: "fetch",arguments: { id: staleArticle.slug } },
    }),
  }), api);
  const payload = await response.json() as {
    result: { structuredContent: { text: string; metadata: { summaryStatus: string; summaryAvailable: boolean } } };
  };
  assert.doesNotMatch(payload.result.structuredContent.text, /## 한국어 AI 요약/u);
  assert.doesNotMatch(payload.result.structuredContent.text, /기후보호 부담의 세대 간 배분/u);
  assert.match(payload.result.structuredContent.text, /한국어 요약을 재처리/u);
  assert.equal(payload.result.structuredContent.metadata.summaryStatus, "reprocessing");
  assert.equal(payload.result.structuredContent.metadata.summaryAvailable, false);
});

test("light enrichment is labeled as metadata-based guidance rather than a full case summary", async () => {
  const lightArticle = {
    ...fixtureArticle,
    slug: "france-light-guidance",
    enrichmentStatus: "light" as const,
    enrichmentFreshness: "current" as const,
    summaryStatus: "available" as const,
    summaryAvailable: true,
  };
  const repository: WorldconsCaseRepository = {
    async search(filters) {
      return { items: [lightArticle],pageInfo: { page: 1,pageSize: filters.pageSize ?? 10,total: 1 } };
    },
    async getArticle(slug) {
      return slug === lightArticle.slug ? lightArticle : null;
    },
    async getSourceText() {
      return null;
    },
    async getSources() {
      return [];
    },
  };
  const api = new WorldconsCaseService({ repository,siteBaseUrl: "https://worldcons.vercel.app" });
  const response = await handleWorldconsMcpRequest(new Request("https://worldcons.vercel.app/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",id: 5,method: "tools/call",params: { name: "fetch",arguments: { id: lightArticle.slug } },
    }),
  }), api);
  const payload = await response.json() as {
    result: { structuredContent: { text: string; metadata: { summaryNotice: string } } };
  };
  assert.match(payload.result.structuredContent.text, /한국어 안내\(공식 메타데이터 기반·AI 생성\)/u);
  assert.doesNotMatch(payload.result.structuredContent.text, /## 한국어 AI 요약/u);
  assert.match(payload.result.structuredContent.metadata.summaryNotice, /판결문 전체 요약이 아닙니다/u);
});

test("plugin MCP is a Vercel route with five public read-only tools and no separate edge runtime", () => {
  const root = process.cwd();
  const serverSource = fs.readFileSync(path.join(root, "lib/chatgpt-plugin/server.ts"), "utf8");
  const routeSource = fs.readFileSync(path.join(root, "app/api/mcp/route.ts"), "utf8");

  for (const tool of ["search", "fetch", "search_cases", "list_sources", "fetch_source_text"]) {
    assert.match(serverSource, new RegExp(`registerTool\\(\\s*\\n\\s*"${tool}"`, "u"));
  }
  assert.match(serverSource, /readOnlyHint: true/u);
  assert.match(serverSource, /destructiveHint: false/u);
  assert.match(routeSource, /handleWorldconsMcpRequest/u);
  assert.match(routeSource, /consumeRateLimit\(request, "publicApi"\)/u);
  assert.doesNotMatch(serverSource + routeSource, /Fetcher|ExecutionContext|ADMIN_PASSWORD|SERVICE_ROLE_KEY|Authorization/u);
  assert.equal(fs.existsSync(path.join(root, "workers/chatgpt-plugin-mcp/package.json")), false);
});
