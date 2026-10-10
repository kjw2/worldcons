import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { auditSelectStatements } from "@/scripts/audit-p3-snapshot-drift";

test("P3 snapshot drift audit is exactly two read-only SELECT statements", () => {
  const sql = readFileSync(resolve("scripts/sql/worldcons-p3-snapshot-drift-audit.sql"), "utf8");
  const statements = auditSelectStatements(sql);
  assert.equal(statements.length, 2);
  assert.ok(statements.every((statement) => statement.includes("article_publications_p3")));
});

test("P3 snapshot drift audit refuses write statements", () => {
  assert.throws(() => auditSelectStatements("SELECT 1; UPDATE articles SET status='published';"), /only_two_selects_allowed/);
});
