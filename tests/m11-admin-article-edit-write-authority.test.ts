import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Binding,
  type D1RuntimePreparedStatement,
} from "@/lib/cloudflare/d1/runtime-binding";
import {
  M11_ADMIN_ARTICLE_EDIT_CANARY_ARTICLE_SLUG,
  resolveAdminArticleEditWriteAuthorityConfig,
  shouldWriteAdminArticleEditToD1,
  writeAdminArticleEditToRuntimeD1,
} from "@/lib/cloudflare/d1/write-authority/admin-article-edit";

test("M13 admin article edit authority defaults to D1 and supports bounded canary mode", () => {
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({}), { authority: "d1" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "d1-canary",
  }), { authority: "d1-canary" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "invalid",
  }), { authority: "d1" });
});

test("M11.2 d1-canary only selects the explicit canary article slug", () => {
  const row = sampleEditRow();
  assert.equal(shouldWriteAdminArticleEditToD1(row, { authority: "d1-canary" }), true);
  assert.equal(shouldWriteAdminArticleEditToD1(
    { ...row, article_slug: "ordinary-article" },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteAdminArticleEditToD1(
    { ...row, article_slug: null },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteAdminArticleEditToD1(
    { ...row, article_slug: "ordinary-article" },
    { authority: "d1" },
  ), true);
});

test("M11.2 D1 article edit writer performs one parameterized insert", async () => {
  clearRuntimeD1Bindings();
  let sql = "";
  let values: unknown[] = [];
  const statement: D1RuntimePreparedStatement = {
    bind(...bound) {
      values = bound;
      return statement;
    },
    async all() {
      return { success: true, results: [] };
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  };
  setRuntimeD1Binding("worldcons_ops", {
    prepare(query) {
      sql = query;
      return statement;
    },
  });
  const result = await writeAdminArticleEditToRuntimeD1(sampleEditRow(), {
    id: "5c0f12d2-4f9a-4b40-9d75-3b7a24a3d6e2",
    editedAt: "2026-09-28T09:15:00.000Z",
  });
  assert.match(sql, /^INSERT INTO admin_article_edit_history/u);
  assert.equal(values.length, 9);
  assert.equal(values[0], result.id);
  assert.equal(values[1], "1f0c7d51-6c05-4c2a-9d6a-1a2b3c4d5e6f");
  assert.equal(values[3], result.editedAt);
  assert.equal(values[5], '["coreSummary","tags"]');
  assert.equal(values[8], '{"changedFields":["coreSummary","tags"],"note":"m11.2"}');
  clearRuntimeD1Bindings();
});

test("M11.2 selected D1 article edit authority fails closed when the write binding is unavailable", async () => {
  clearRuntimeD1Bindings();
  await assert.rejects(
    () => writeAdminArticleEditToRuntimeD1(sampleEditRow()),
    /binding_unavailable/u,
  );
});

function sampleEditRow() {
  return {
    article_id: "1f0c7d51-6c05-4c2a-9d6a-1a2b3c4d5e6f",
    article_slug: M11_ADMIN_ARTICLE_EDIT_CANARY_ARTICLE_SLUG,
    actor_id: "m11-canary",
    changed_fields: ["coreSummary", "tags"],
    previous_summary_hash: "a".repeat(64),
    next_summary_hash: "b".repeat(64),
    diff_redacted: { changedFields: ["coreSummary", "tags"], note: "m11.2" },
  };
}
