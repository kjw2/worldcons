import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("homepage and footer introduce the canonical ChatGPT plugin guide", () => {
  const home = read("app/page.tsx");
  const layout = read("app/layout.tsx");
  const sitemap = read("app/sitemap.ts");

  assert.match(home, /ChatGPT에서 헌법판례를 바로 검색하세요/u);
  assert.match(home, /href="\/guide\/chatgpt-plugin"/u);
  assert.match(layout, /ChatGPT 플러그인/u);
  assert.match(sitemap, /\/guide\/chatgpt-plugin/u);
});

test("guide explains direct no-auth installation without claiming OpenAI listing", () => {
  const guide = read("app/guide/chatgpt-plugin/page.tsx");

  assert.match(guide, /헌법판례요약시스템/u);
  assert.match(guide, /OpenAI 플러그인 디렉터리에는 게시하지 않습니다/u);
  assert.match(guide, /worldcons\.vercel\.app\/api\/mcp/u);
  assert.match(guide, /회원가입, 비밀번호, API 키, OAuth 연결은 필요하지 않습니다/u);
  assert.match(guide, /한국어 번역·요약·태그는 AI가 만든 참고 자료/u);
  assert.match(guide, /법원 공식 원문/u);
  assert.doesNotMatch(guide, /WORLD CONS/iu);
});
