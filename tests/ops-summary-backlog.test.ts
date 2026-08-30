import assert from "node:assert/strict";
import test from "node:test";
import { summaryBacklogViolation } from "@/lib/ops/watchdog";

const NOW = new Date("2026-08-30T00:00:00.000Z");

function hoursAgo(hours: number) {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

test("an empty summary backlog raises nothing", () => {
  assert.equal(summaryBacklogViolation("fr-conseil-constitutionnel", { count: 0, oldestCreatedAt: null }, NOW), null);
});

test("a small and recent backlog is treated as normal throughput", () => {
  const violation = summaryBacklogViolation("us-scotus", { count: 6, oldestCreatedAt: hoursAgo(5) }, NOW);
  assert.equal(violation, null);
});

test("a large backlog is critical and names the public impact", () => {
  const violation = summaryBacklogViolation("fr-conseil-constitutionnel", { count: 161, oldestCreatedAt: hoursAgo(400) }, NOW);
  assert.equal(violation?.severity, "critical");
  assert.equal(violation?.sourceKey, "fr-conseil-constitutionnel");
  assert.equal(violation?.key, "summary-backlog:fr-conseil-constitutionnel");
  assert.match(violation?.summary ?? "", /161건/u);
  assert.match(violation?.summary ?? "", /공개 목록에 보이지 않습니다/u);
});

test("a moderate backlog warns on count alone", () => {
  const violation = summaryBacklogViolation("de-bverfg", { count: 45, oldestCreatedAt: hoursAgo(2) }, NOW);
  assert.equal(violation?.severity, "warning");
});

test("a small but stale backlog still warns so slow drain cannot hide", () => {
  // Few rows, but waiting far longer than the daily pipeline window.
  const violation = summaryBacklogViolation("es-tribunal-constitucional", { count: 3, oldestCreatedAt: hoursAgo(200) }, NOW);
  assert.equal(violation?.severity, "warning");
  assert.match(violation?.summary ?? "", /최고령/u);
});

test("a missing oldest timestamp degrades to count-only judgement", () => {
  assert.equal(summaryBacklogViolation("de-bverfg", { count: 5, oldestCreatedAt: null }, NOW), null);
  assert.equal(summaryBacklogViolation("de-bverfg", { count: 130, oldestCreatedAt: null }, NOW)?.severity, "critical");
});
