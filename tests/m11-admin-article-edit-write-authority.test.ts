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
import {
  clearRuntimeSearchServiceBinding,
  setRuntimeSearchServiceBinding,
  writeAdminArticleEditViaRuntimeSearchService,
} from "@/lib/cloudflare/services/search-service-binding";
import { createWorldconsSearchServiceApp } from "@/workers/search-service/src/index";

test("M11.2 admin article edit authority defaults to Supabase and supports bounded D1 modes", () => {
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({}), { authority: "supabase" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "d1-canary",
  }), { authority: "d1-canary" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminArticleEditWriteAuthorityConfig({
    WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY: "invalid",
  }), { authority: "supabase" });
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

test("M11.2 article edit legacy bridge uses the private Service Binding", async () => {
  clearRuntimeSearchServiceBinding();
  assert.equal(await writeAdminArticleEditViaRuntimeSearchService(sampleEditRow()), null);
  let seenUrl = "";
  let seenBody: unknown = null;
  setRuntimeSearchServiceBinding({
    async fetch(request) {
      seenUrl = request.url;
      seenBody = await request.json();
      return new Response(null, { status: 204 });
    },
  }, false, false);
  assert.equal(await writeAdminArticleEditViaRuntimeSearchService(sampleEditRow()), true);
  assert.equal(seenUrl, "https://worldcons-search.internal/internal/admin-article-edit/write");
  assert.deepEqual(seenBody, sampleEditRow());
  clearRuntimeSearchServiceBinding();
});

test("M11.2 article edit legacy bridge fails closed on a non-ok Service Binding response", async () => {
  clearRuntimeSearchServiceBinding();
  setRuntimeSearchServiceBinding({
    async fetch() {
      return new Response(null, { status: 503 });
    },
  }, false, false);
  await assert.rejects(
    () => writeAdminArticleEditViaRuntimeSearchService(sampleEditRow()),
    /worldcons_admin_article_edit_legacy_bridge_unavailable/u,
  );
  clearRuntimeSearchServiceBinding();
});

test("M11.2 internal article edit bridge validates and writes one bounded row", async () => {
  let written: unknown = null;
  const app = createWorldconsSearchServiceApp({
    async adminArticleEditWrite(row) {
      written = row;
    },
  });
  const response = await app.request(
    "https://worldcons-search.internal/internal/admin-article-edit/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleEditRow()),
    },
    {},
  );
  assert.equal(response.status, 204);
  assert.deepEqual(written, sampleEditRow());

  const invalid = await app.request(
    "https://worldcons-search.internal/internal/admin-article-edit/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleEditRow(), article_id: "" }),
    },
    {},
  );
  assert.equal(invalid.status, 400);

  const invalidFields = await app.request(
    "https://worldcons-search.internal/internal/admin-article-edit/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleEditRow(), changed_fields: [1, 2] }),
    },
    {},
  );
  assert.equal(invalidFields.status, 400);
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
