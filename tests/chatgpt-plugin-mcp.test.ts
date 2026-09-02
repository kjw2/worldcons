// @ts-nocheck -- this runtime contract test supplies Worker platform bindings as fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { handleWorldconsPluginRequest } from "../workers/chatgpt-plugin-mcp/src/index";
import { WorldconsSearchClient } from "../workers/chatgpt-plugin-mcp/src/search-client";

function fixtureFetcher(requests: URL[]) {
  return {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/search") {
        return Response.json({ items: [caseRecord()] });
      }
      if (url.pathname === "/api/articles/germany-neubauer") {
        return Response.json({
          ...caseRecord(),
          summaryJson: {
            summary: {
              coreSummary: ["기후보호 부담의 세대 간 배분을 헌법상 자유의 관점에서 심사했다."],
              background: "기후보호법의 감축 경로가 문제 되었다.",
              referencedProvisions: ["기본법 제20a조"],
            },
          },
          cleanedText: "공식 독일어 결정문 발췌",
          originalLanguage: "de",
          contentType: "decision",
          bodyChecksum: "abc123",
          textPage: { offset: 0, returnedChars: 14, totalChars: 100, hasMore: true, nextOffset: 14 },
        });
      }
      if (url.pathname.endsWith("/source-text")) {
        return Response.json({
          slug: "germany-neubauer",
          cleanedText: "다음 공식 원문 구간",
          bodyChecksum: "abc123",
          textPage: { offset: 14, returnedChars: 11, totalChars: 100, hasMore: true, nextOffset: 25 },
        });
      }
      if (url.pathname === "/api/sources") {
        return Response.json({
          items: [{
            sourceKey: "de-bverfg",
            name: "Bundesverfassungsgericht",
            jurisdiction: "Germany",
            jurisdictionCode: "DE",
            countryName: "독일",
            language: "de",
            officialUri: "https://www.bundesverfassungsgericht.de/",
          }],
        });
      }
      return Response.json({}, { status: 404 });
    },
  };
}

function client(requests: URL[]) {
  return new WorldconsSearchClient({
    searchApi: fixtureFetcher(requests),
    siteBaseUrl: "https://worldcons.vercel.app",
    detailTextLimit: 16_000,
    sourceTextPageLimit: 12_000,
  });
}

test("plugin search client exposes bounded public evidence and canonical citation URLs", async () => {
  const requests: URL[] = [];
  const api = client(requests);
  const results = await api.search({ query: "기후 자유", jurisdiction: "Germany", limit: 3 }, "request-1");
  const article = await api.fetchArticle("germany-neubauer", "request-2");
  const sourceText = await api.fetchSourceText("germany-neubauer", 14, 50_000, "request-3");

  assert.equal(results[0].url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.equal(results[0].officialUrl, "https://www.bundesverfassungsgericht.de/example");
  assert.equal(article.koreanSummary.coreSummary.length, 1);
  assert.equal(article.sourceExcerpt, "공식 독일어 결정문 발췌");
  assert.equal(sourceText.url, "https://worldcons.vercel.app/articles/germany-neubauer");
  assert.equal(requests[0].searchParams.get("mode"), "hybrid");
  assert.equal(requests[0].searchParams.get("pageSize"), "3");
  assert.equal(requests[1].searchParams.get("textLimit"), "16000");
  assert.equal(requests[2].searchParams.get("limit"), "12000");
});

test("public Worker metadata and health disclose no credential requirement", async () => {
  const requests: URL[] = [];
  const env = {
    SEARCH_API: fixtureFetcher(requests),
    SITE_BASE_URL: "https://worldcons.vercel.app",
    SEARCH_DETAIL_TEXT_LIMIT: "16000",
    SOURCE_TEXT_PAGE_LIMIT: "12000",
    VERSION_METADATA: { id: "test-version", tag: "" },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const root = await handleWorldconsPluginRequest(new Request("https://plugin.example/"), env, ctx);
  const health = await handleWorldconsPluginRequest(new Request("https://plugin.example/health"), env, ctx);

  assert.deepEqual(await root.json(), {
    service: "worldcons-plugin-mcp",
    name: "헌법판례요약시스템",
    homepage: "https://worldcons.vercel.app/guide/chatgpt-plugin",
    mcp: "/mcp",
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ready",
    service: "worldcons-plugin-mcp",
    version: "test-version",
    checks: { searchApi: "ok" },
  });
});

test("ChatGPT can initialize the public MCP endpoint and scan its tools", async () => {
  const requests: URL[] = [];
  const env = {
    SEARCH_API: fixtureFetcher(requests),
    SITE_BASE_URL: "https://worldcons.vercel.app",
    SEARCH_DETAIL_TEXT_LIMIT: "16000",
    SOURCE_TEXT_PAGE_LIMIT: "12000",
    VERSION_METADATA: { id: "test-version", tag: "" },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const rpc = (body: object) => handleWorldconsPluginRequest(new Request("https://plugin.example/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify(body),
  }), env, ctx);

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
  const initialized = await rpcPayload(initialize);

  assert.equal(initialize.status, 200);
  assert.equal(initialized.result.serverInfo.name, "worldcons-constitutional-cases");

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await rpcPayload(list);
  assert.equal(list.status, 200);
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["fetch", "fetch_source_text", "list_sources", "search", "search_cases"],
  );
  assert.ok(listed.result.tools.every((tool: { annotations: { readOnlyHint: boolean; destructiveHint: boolean } }) =>
    tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));

  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search", arguments: { query: "기후 자유" } },
  });
  const called = await rpcPayload(call);
  assert.equal(call.status, 200);
  assert.notEqual(called.result.isError, true);
  assert.equal(called.result.structuredContent.results[0].id, "germany-neubauer");
  assert.equal(called.result.structuredContent.results[0].url, "https://worldcons.vercel.app/articles/germany-neubauer");
});

async function rpcPayload(response: Response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
    assert.ok(dataLine, "MCP SSE response must include a data event");
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

test("plugin Worker registers five public read-only tools", () => {
  const serverSource = require("node:fs").readFileSync(
    require("node:path").join(process.cwd(), "workers/chatgpt-plugin-mcp/src/server.ts"),
    "utf8",
  );
  for (const tool of ["search", "fetch", "search_cases", "list_sources", "fetch_source_text"]) {
    assert.match(serverSource, new RegExp(`registerTool\\(\\s*\\n\\s*"${tool}"`, "u"));
  }
  assert.match(serverSource, /readOnlyHint: true/u);
  assert.match(serverSource, /destructiveHint: false/u);
  assert.doesNotMatch(serverSource, /ADMIN_PASSWORD|SERVICE_ROLE_KEY|Authorization/u);
});

function caseRecord() {
  return {
    slug: "germany-neubauer",
    title: "독일 연방헌법재판소 기후보호법 결정",
    originalTitle: "Klimabeschluss",
    summary: "미래세대의 자유와 기후보호 의무를 다룬 결정",
    snippet: "기후보호 부담의 세대 간 배분",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    countryName: "독일",
    courtName: "Bundesverfassungsgericht",
    caseNumber: "1 BvR 2656/18",
    decisionDate: "2021-03-24",
    officialUri: "https://www.bundesverfassungsgericht.de/example",
    tags: ["기후보호", "미래세대"],
  };
}
