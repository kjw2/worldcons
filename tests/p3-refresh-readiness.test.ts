import assert from "node:assert/strict";
import test from "node:test";
import { readinessSql, summarizeReadiness } from "@/scripts/audit-p3-refresh-readiness";
import { P3_DRIFT_REFRESH_CANARY_IDS } from "@/lib/admin/p4/p3-drift-refresh";

test("preflight only reads the exact four allowed articles", () => {
  const sql = readinessSql([...P3_DRIFT_REFRESH_CANARY_IDS]);
  assert.match(sql, /^SELECT\s/u);
  assert.match(sql, /WHERE a\.id IN/u);
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|DROP)\b/iu);
  assert.throws(() => readinessSql(["00000000-0000-4000-8000-000000000000"]), /invalid_cohort/);
});

test("missing Production rows are not mistaken for successful preflight", () => {
  assert.throws(() => summarizeReadiness([]), /candidate_missing_or_duplicate/);
});
