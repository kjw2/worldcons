import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  WorldconsCaseService,
  type WorldconsCaseRepository,
} from "../lib/chatgpt-plugin/case-service";
import { handleWorldconsMcpRequest } from "../lib/chatgpt-plugin/http-handler";

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
};

function fixtureRepository(calls: string[]): WorldconsCaseRepository {
  return {
    async search(filters) {
      calls.push(`search:${filters.q ?? ""}:${filters.pageSize ?? ""}`);
      return {
        items: [fixtureArticle],
        pageInfo: { page: 1, pageSize: filters.pageSize ?? 10, total: 1 },
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
  assert.equal(article.koreanSummary.coreSummary.length, 1);
  assert.equal(article.sourceExcerpt?.length, 24);
  assert.equal(sourceText.text.length, 12);
  assert.equal(sourceText.url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.deepEqual(calls, [
    "search:기후 자유:3",
    "article:germany-neubauer",
    "source-text:germany-neubauer",
  ]);
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
    result: { isError?: boolean; structuredContent: { results: Array<{ id: string; url: string }> } };
  };
  assert.equal(call.status, 200);
  assert.notEqual(called.result.isError, true);
  assert.equal(called.result.structuredContent.results[0].id, "germany-neubauer");
  assert.equal(called.result.structuredContent.results[0].url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.equal(call.headers.get("access-control-allow-origin"), "*");
});

test("plugin MCP is a Vercel route with five public read-only tools and no Cloudflare runtime", () => {
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
  assert.doesNotMatch(serverSource + routeSource, /Cloudflare|Fetcher|ExecutionContext|ADMIN_PASSWORD|SERVICE_ROLE_KEY|Authorization/u);
  assert.equal(fs.existsSync(path.join(root, "workers/chatgpt-plugin-mcp/wrangler.jsonc")), false);
  assert.equal(fs.existsSync(path.join(root, "workers/chatgpt-plugin-mcp/package.json")), false);
});
