import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import { approvalIdentity, validE2EApproval, type E2EApprovalContext } from "@/lib/cloudflare/e2e/contracts";
import { normalizeD1MigrationSql, parseD1MigrationVerifyDirectives } from "@/lib/cloudflare/d1/remote/migration-apply";

import { SqliteD1, articleId, approval, metadata, input, publish } from "./helpers/e2e-core-fixture";

test("M1 canonical hashes ignore processing timestamps/key order, preserve content/array order/Unicode", async () => {
  const snapshot = { cleaned_text: "é\n正文", summary_json: '{"b":2,"a":[1,2]}', source_metadata: '{"x":1}',
    fetched_at: "old", summarized_at: "old" };
  const initial = await approvalIdentity(articleId, snapshot, "v1");
  assert.deepEqual(await approvalIdentity(articleId, { ...snapshot, fetched_at: "new", summarized_at: "new",
    summary_json: '{ "a": [1,2], "b": 2 }', version_role: null }, "v1"), initial);
  for (const change of [{ cleaned_text: "é\n正文" }, { cleaned_text: "é 正文" },
    { summary_json: '{"a":[2,1],"b":2}' }, { canonical_url: "https://example.test/new" },
    { source_metadata: '{"x":false}' }, { version_role: "enrichment_full" }]) {
    assert.notEqual((await approvalIdentity(articleId, { ...snapshot, ...change }, "v1")).approvalSnapshotHash, initial.approvalSnapshotHash);
  }
  const policy = await approvalIdentity(articleId, snapshot, "v2");
  assert.equal(policy.approvalSnapshotHash, initial.approvalSnapshotHash);
  assert.notEqual(policy.approvalKey, initial.approvalKey);
});

test("M1 preserves legacy P3 hash/ID, adopts current version, then timestamp-only recollection advances nothing", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const legacy = await publish(db, "legacy", { e2eApproval: undefined });
  const legacyVersion = db.rows("article_content_versions_p3")[0];
  assert.equal(db.rows("e2e_generations_v1").length, 0);
  db.db.exec("UPDATE articles SET fetched_at='2026-10-11T00:00:00Z',summarized_at='2026-10-11T01:00:00Z',updated_at='2026-10-11T01:00:00Z'");
  const adopted = await publish(db, "adopt");
  assert.equal(adopted.versionId, legacy.versionId);
  assert.equal(adopted.versionRevision, legacy.versionRevision);
  assert.equal(adopted.publicationApplied, false);
  assert.equal(adopted.generation?.generationSeq, 1);
  assert.deepEqual(db.rows("article_content_versions_p3")[0], legacyVersion);
  const outbox = db.rows("article_cache_outbox_p3");
  db.db.exec("UPDATE articles SET discovered_at='2026-10-11T02:00:00Z',fetched_at='2026-10-11T03:00:00Z',summarized_at='2026-10-11T04:00:00Z',updated_at='2026-10-11T04:00:00Z'");
  const repeated = await publish(db, "recollect");
  assert.equal(repeated.versionCreated, false);
  assert.equal(repeated.publicationApplied, false);
  assert.deepEqual(repeated.generation, { ...adopted.generation!, created: false });
  assert.equal(db.rows("e2e_generations_v1").length, 1);
  assert.equal(db.rows("article_content_versions_p3").length, 1);
  assert.deepEqual(db.rows("article_cache_outbox_p3"), outbox);
  assert.equal(db.rows("e2e_commit_guards_v1").length, 0);
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state, "publication_committed");
  assert.equal(db.rows("e2e_generation_progress_v1")[0].verified_at, null);
});

test("M1 initial opt-in retains legacy content_hash and deterministicVersionId", async (t) => {
  const legacyDb = new SqliteD1(false), m1Db = new SqliteD1();
  t.after(() => { legacyDb.close(); m1Db.close(); });
  const legacy = await publish(legacyDb, "legacy", { e2eApproval: undefined });
  const m1 = await publish(m1Db, "m1");
  assert.equal(m1.versionId, legacy.versionId);
  assert.equal(m1Db.rows("article_content_versions_p3")[0].content_hash, legacyDb.rows("article_content_versions_p3")[0].content_hash);
});

test("M1 additive migration reruns without rewriting history; every verify directive matches SQLite DDL", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db, "before-migration-rerun");
  const history = db.rows("e2e_generations_v1");
  const sql = readFileSync(new URL("../d1/worldcons_core/0004_e2e_generations.sql", import.meta.url), "utf8");
  db.db.exec(sql);
  assert.deepEqual(db.rows("e2e_generations_v1"), history);
  for (const verify of parseD1MigrationVerifyDirectives(sql)) {
    const stored = db.db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(verify.type, verify.name);
    assert.ok(stored);
    for (const fragment of verify.sqlIncludes ?? []) {
      assert.ok(normalizeD1MigrationSql(String(stored.sql)).includes(normalizeD1MigrationSql(fragment)), verify.name);
    }
  }
});

test("M1 catalog role and legacy hash omission cannot silently approve the wrong P3 snapshot", async (t) => {
  for (const change of ["role", "case-key"]) {
    const db = new SqliteD1(); t.after(() => db.close());
    await publish(db, "legacy", { e2eApproval: undefined });
    if (change === "role") db.db.exec("UPDATE article_content_versions_p3 SET version_role='enrichment_full'");
    else db.db.exec("UPDATE articles SET case_key='new-case-key'");
    const before = db.rows("article_content_versions_p3");
    const result = await transitionArticlePublicationInD1(db, input(db, "wrong-snapshot"));
    assert.deepEqual(result, { ok: false, error: { code: "ineligible", retryable: false } });
    assert.deepEqual(db.rows("article_content_versions_p3"), before);
    assert.equal(db.rows("e2e_generations_v1").length, 0);
  }
});

test("M1 changed summary advances P3+generation; policy/tags/review advance only generation; history is preserved", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const first = await publish(db, "first");
  const firstGeneration = db.rows("e2e_generations_v1")[0];
  db.db.prepare("UPDATE articles SET summary_json=?,updated_at=?").run('{"summary":"새 승인 요약","issues":["평등"]}', "2026-10-11T05:00:00Z");
  const second = await publish(db, "changed");
  assert.equal(second.versionRevision, 2);
  assert.equal(second.generation?.generationSeq, 2);
  assert.notEqual(second.generation?.approvalKey, first.generation?.approvalKey);
  const policy = { ...approval, policyVersion: "fr-es-approval-v2" };
  const third = await publish(db, "policy", { e2eApproval: policy });
  assert.equal(third.versionCreated, false);
  assert.equal(third.generation?.generationSeq, 3);
  db.db.exec("INSERT INTO tags (id,slug,name,normalized_name,type,created_at,updated_at) VALUES ('t1','equality','평등','평등','issue','old','old'); INSERT INTO article_tags (article_id,tag_id,confidence,created_at) VALUES ('"+articleId+"','t1',1,'old')");
  const fourth = await publish(db, "tags", { e2eApproval: policy });
  assert.equal(fourth.generation?.generationSeq, 4);
  assert.equal(fourth.generation?.approvalKey, third.generation?.approvalKey);
  assert.equal(fourth.versionId, second.versionId);
  db.db.exec("UPDATE articles SET review_state='unreviewed'");
  const fifth = await publish(db, "review", { e2eApproval: policy });
  assert.equal(fifth.generation?.generationSeq, 5);
  assert.deepEqual(db.rows("e2e_generations_v1")[0], firstGeneration);
  assert.equal(db.rows("article_content_versions_p3").length, 2);
  assert.equal(db.rows("article_cache_outbox_p3").length, 2);
});

test("M1 duplicate delivery returns recorded generation even after newer generation, rejects changed approval context", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const originalInput = input(db, "duplicate");
  const first = await publish(db, "duplicate");
  await publish(db, "new-policy", { e2eApproval: { ...approval, policyVersion: "v2" } });
  const before = db.batches;
  const replay = await transitionArticlePublicationInD1(db, originalInput);
  assert.ok(replay.ok);
  assert.equal(replay.data.idempotent, true);
  assert.deepEqual(replay.data.generation, first.generation);
  const invalid = await transitionArticlePublicationInD1(db, { ...originalInput, e2eApproval: { ...approval, policyVersion: "v3" } });
  assert.deepEqual(invalid, { ok: false, error: { code: "invalid_input", retryable: false } });
  assert.equal(db.batches, before);
});

const transactionalTables = ["article_content_versions_p3", "article_publications_p3", "article_publication_history_p3",
  "article_publication_requests_p3", "article_audit_ledger_p3", "article_cache_outbox_p3",
  "legacy_version_freshness_classifications_v4", "e2e_generations_v1", "e2e_generation_heads_v1",
  "e2e_generation_progress_v1", "e2e_generation_requests_v1", "e2e_commit_guards_v1", "e2e_search_repair_outbox_v1"];

for (const race of ["p3", "v4", "publication", "article", "tags", "generation"] ) {
  test(`M1 ${race} changes after pre-read: CHECK aborts the entire batch`, async (t) => {
    const db = new SqliteD1(); t.after(() => db.close());
    await publish(db, "first");
    db.db.exec("UPDATE articles SET korean_title='새 승인 제목',updated_at='new'");
    const before = transactionalTables.map((table) => db.rows(table));
    db.beforeBatch = () => {
      db.beforeBatch = undefined;
      if (race === "p3") db.db.exec("UPDATE article_version_heads_p3 SET current_revision='9'");
      if (race === "v4") db.db.exec("UPDATE article_revision_heads_v4 SET current_revision='9'");
      if (race === "publication") db.db.exec("UPDATE article_publications_p3 SET revision='9'");
      if (race === "article") db.db.exec("UPDATE articles SET cleaned_text='concurrent source',updated_at='other'");
      if (race === "tags") db.db.exec("INSERT INTO article_tags (article_id,tag_id,created_at) VALUES ('"+articleId+"','concurrent-tag','old')");
      if (race === "generation") db.db.exec("UPDATE e2e_generation_heads_v1 SET generation_seq=9");
    };
    const result = await transitionArticlePublicationInD1(db, input(db, "race"));
    assert.deepEqual(result, { ok: false, error: { code: "stale_revision", retryable: true } });
    for (const [index, table] of transactionalTables.entries()) {
      if (race === "publication" && table === "article_publications_p3") continue;
      if (race === "generation" && table === "e2e_generation_heads_v1") continue;
      assert.deepEqual(db.rows(table), before[index], `no partial write to ${table}`);
    }
  });
}

test("M1 two deliveries with the same observed head: one commits, loser retries idempotently", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const request = input(db, "concurrent-duplicate");
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  db.beforeBatch = async () => { if (++arrivals === 2) release(); await barrier; };
  const results = await Promise.all([transitionArticlePublicationInD1(db, request), transitionArticlePublicationInD1(db, request)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.error.code === "stale_revision").length, 1);
  db.beforeBatch = undefined;
  const retry = await transitionArticlePublicationInD1(db, request);
  assert.ok(retry.ok);
  assert.equal(retry.data.idempotent, true);
  assert.equal(db.rows("article_content_versions_p3").length, 1);
  assert.equal(db.rows("e2e_generations_v1").length, 1);
  assert.equal(db.rows("article_cache_outbox_p3").length, 1);
});

test("M1 SQL failure at batch end rolls back P3, heads, history, cache outbox, requests and generations", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  db.failAtEnd = true;
  const result = await transitionArticlePublicationInD1(db, input(db, "rollback"));
  assert.deepEqual(result, { ok: false, error: { code: "stale_revision", retryable: true } });
  for (const table of [...transactionalTables, "article_version_heads_p3", "article_revision_heads_v4"]) {
    assert.deepEqual(db.rows(table), [], `rolled back ${table}`);
  }
});

test("M1 source-only, provenance conflicts, blocked review and non-official automatic URL stay unpublishable", async (t) => {
  for (const change of [{ source_metadata: JSON.stringify({ ...metadata, catalog: { sourceOnly: true } }) },
    { source_metadata: JSON.stringify({ ...metadata, collectionSafety: { publishable: false } }) },
    { source_metadata: JSON.stringify({ ...metadata, sourceTextStatus: "not_available" }) },
    { review_state: "needs_review" }, { canonical_url: "https://example.test/unverified" }]) {
    const db = new SqliteD1(); t.after(() => db.close());
    for (const [column, value] of Object.entries(change)) db.db.prepare(`UPDATE articles SET ${column}=?`).run(value);
    const result = await transitionArticlePublicationInD1(db, input(db, "blocked"));
    assert.deepEqual(result, { ok: false, error: { code: "ineligible", retryable: false } });
    assert.equal(db.batches, 0);
  }
});

test("M1 withdrawn/re-published same version has separate generations and never claims completed_verified", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const first = await publish(db, "published");
  const withdrawn = await publish(db, "withdraw", { captureLegacy: false, versionId: first.versionId, targetState: "withdrawn" });
  assert.equal(withdrawn.generation?.generationSeq, 2);
  const republished = await publish(db, "republish", { captureLegacy: false, versionId: first.versionId });
  assert.equal(republished.generation?.generationSeq, 3);
  assert.equal(db.rows("article_content_versions_p3").length, 1);
  assert.ok(db.rows("e2e_generation_progress_v1").every((row) => ["publication_committed", "superseded"].includes(String(row.state)) && row.verified_at === null));
});

test("M1 malformed opt-in is rejected before DB access", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  for (const bad of [null, {}, { ...approval, evidenceRef: "" }, { ...approval, policyVersion: 1 }]) {
    assert.equal(validE2EApproval(bad), false);
    const result = await transitionArticlePublicationInD1(db, { ...input(db, "invalid"), e2eApproval: bad as E2EApprovalContext });
    assert.deepEqual(result, { ok: false, error: { code: "invalid_input", retryable: false } });
  }
  assert.equal(db.batches, 0);
});
