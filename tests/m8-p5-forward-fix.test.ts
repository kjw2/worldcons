import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260927023756_m8_p5_publication_parity_forward_fix.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");

test("M8 P5 forward-fix adds runtime freshness classification without weakening the v4 guard", () => {
  assert.match(sql, /create or replace function article_legacy_version_classify_current_v4\(\)/i);
  assert.match(sql, /after insert on article_content_versions_p3/i);
  assert.match(sql, /'current',\s*'legacy_same_version'/i);
  assert.match(sql, /on conflict \(version_id\) do nothing/i);
  assert.doesNotMatch(sql, /drop trigger[^;]*article_publications_p3_guard_v4_trigger/i);
});

test("M8 P5 parity repair captures current legacy content instead of publishing stale draft versions", () => {
  assert.match(sql, /article_publication_transition_p3\(/i);
  assert.match(
    sql,
    /'published',\s*null,\s*true,\s*'backfill',\s*'m8-p5-forward-fix'/i,
  );
  assert.match(sql, /article_publication_backfill_anomaly_p3\(a\) is null/i);
  assert.match(sql, /M8_P5_PARITY_REPAIR_INCOMPLETE/i);
});

test("M8 P5 quarantine resolution is restricted to attention-clear articles already projected", () => {
  assert.match(sql, /q\.anomaly_code = 'backfill\.lifecycle_attention_not_clear'/i);
  assert.match(sql, /a\.lifecycle_attention_state = 'clear'/i);
  assert.match(sql, /select 1 from public_article_projection_p3 p/i);
  assert.match(sql, /resolution\.lifecycle_attention_cleared_and_projected/i);
  assert.match(sql, /M8_P5_QUARANTINE_RESOLUTION_INCOMPLETE/i);
});

test("M8 P5 forward-fix never mutates immutable resolution or freshness rows in place", () => {
  assert.doesNotMatch(sql, /update\s+legacy_version_freshness_classifications_v4/i);
  assert.doesNotMatch(sql, /delete\s+from\s+legacy_version_freshness_classifications_v4/i);
  assert.doesNotMatch(sql, /update\s+article_publication_quarantine_resolutions_p3/i);
  assert.doesNotMatch(sql, /delete\s+from\s+article_publication_quarantine_resolutions_p3/i);
});
