import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HOME_COUNTRY_ORDER } from "../lib/ui/home-country-order";
import { displayJurisdictionLabel } from "../lib/ui/source-labels";

const homePage = fs.readFileSync(path.join(process.cwd(), "app/page.tsx"), "utf8");
const searchBox = fs.readFileSync(path.join(process.cwd(), "components/search-box.tsx"), "utf8");

test("homepage keeps the primary heading and direct search entry point", () => {
  assert.match(homePage, /<h1[^>]*>세계 헌법판례 데이터베이스<\/h1>/);
  assert.match(homePage, /<SearchBox variant="hero" placeholder="판례명, 사건번호, 헌법 쟁점을 검색하세요" \/>/);
  assert.match(searchBox, /action = "\/search"/);
  assert.match(searchBox, /<form action=\{action\}/);
});

test("homepage exposes the four country navigation entry points in the intended order", () => {
  assert.deepEqual([...HOME_COUNTRY_ORDER], ["Germany", "United States", "France", "Spain"]);
  assert.deepEqual(HOME_COUNTRY_ORDER.map((jurisdiction) => displayJurisdictionLabel(jurisdiction)), ["독일", "미국", "프랑스", "스페인"]);
  assert.match(homePage, /<CountryShortcuts countries=\{countries\} \/>/);
  assert.match(homePage, /href=\{`\/list\?jurisdiction=\$\{encodeURIComponent\(country\.jurisdiction\)\}`\}/);
  assert.match(homePage, /sources\.filter\(\(source\) => source\.isActive\)/);
  assert.match(homePage, /\.sort\(compareHomeCountries\)/);
  assert.match(homePage, /국가별 바로가기/);
  assert.match(homePage, /수록 기관/);
});

test("homepage keeps clean canonical metadata and does not restore legacy v2 links", () => {
  assert.match(homePage, /alternates: \{ canonical: `\$\{getAppBaseUrl\(\)\}\/` \}/);
  assert.doesNotMatch(homePage, /\/v2(?:\/|["'`])/);
});

test("homepage keeps the country latest decisions section", () => {
  assert.match(homePage, /<h2 id="latest-decisions"[^>]*>국가별 최신 판례<\/h2>/);
  assert.match(homePage, /<LatestDecisionList articles=\{latestArticles\} \/>/);
  assert.match(homePage, /listArticles\(\{ jurisdiction, page: 1, pageSize: 1, count: "none", includeViewCounts: false \}\)/);
});
