import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsClientIdentifier,
  normalizeAnalyticsSearchQuery,
  primaryAcceptLanguage,
} from "@/lib/analytics/events";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

test("analytics search queries redact direct identifiers", () => {
  assert.equal(normalizeAnalyticsSearchQuery("  표현의 자유 TEST@EXAMPLE.COM  "), "표현의 자유 [email]");
  assert.equal(normalizeAnalyticsSearchQuery("https://example.com/case 판례"), "[url] 판례");
  assert.equal(normalizeAnalyticsSearchQuery("연락처 010-1234-5678"), "연락처 [number]");
  assert.equal(normalizeAnalyticsSearchQuery("사건번호 2025-1234"), "사건번호 2025-1234");
});

test("analytics client identifiers rotate by KST date", () => {
  const requestHeaders = headers({ "x-forwarded-for": "203.0.113.7" });
  const beforeMidnight = analyticsClientIdentifier(requestHeaders, new Date("2026-07-25T14:59:59.000Z"));
  const afterMidnight = analyticsClientIdentifier(requestHeaders, new Date("2026-07-25T15:00:00.000Z"));

  assert.ok(beforeMidnight);
  assert.ok(afterMidnight);
  assert.notEqual(beforeMidnight, afterMidnight);
  assert.equal(beforeMidnight?.includes("203.0.113.7"), false);
});

test("analytics stores only the primary valid language code", () => {
  assert.equal(primaryAcceptLanguage(headers({ "accept-language": "ko-KR,ko;q=0.9,en;q=0.8" })), "ko-KR");
  assert.equal(primaryAcceptLanguage(headers({ "accept-language": "not valid value" })), null);
});
