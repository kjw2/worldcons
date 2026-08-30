import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsClientIdentifier,
  normalizeAnalyticsSearchQuery,
  primaryAcceptLanguage,
} from "@/lib/analytics/events";
import { clientIpHeaderPriority, getClientIp } from "@/lib/security/request-client";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("spoofable proxy IP headers are ignored unless explicitly trusted", () => {
  withEnvironment({ TRUSTED_CLIENT_IP_HEADERS: undefined }, () => {
    const spoofed = headers({
      "cf-connecting-ip": "198.51.100.1",
      "true-client-ip": "198.51.100.2",
      "x-real-ip": "198.51.100.3",
      "x-vercel-forwarded-for": "203.0.113.7",
    });

    // A caller cannot rotate its rate-limit bucket key by forging proxy headers.
    assert.equal(getClientIp(spoofed), "203.0.113.7");
    assert.equal(clientIpHeaderPriority().includes("cf-connecting-ip"), false);
  });
});

test("an explicitly trusted proxy header takes precedence", () => {
  withEnvironment({ TRUSTED_CLIENT_IP_HEADERS: "cf-connecting-ip" }, () => {
    const proxied = headers({ "cf-connecting-ip": "198.51.100.1", "x-vercel-forwarded-for": "203.0.113.7" });
    assert.equal(getClientIp(proxied), "198.51.100.1");
  });
});

test("client IP resolution uses the left-most forwarded address and rejects unknown headers", () => {
  withEnvironment({ TRUSTED_CLIENT_IP_HEADERS: "x-forwarded-host" }, () => {
    assert.equal(getClientIp(headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" })), "203.0.113.9");
    // An unsupported header name cannot be injected into the trust list.
    assert.equal(clientIpHeaderPriority().includes("x-forwarded-host"), false);
    assert.equal(getClientIp(headers({ "x-client-ip": "198.51.100.4" })), null);
  });
});

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
