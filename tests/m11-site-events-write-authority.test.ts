import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Binding,
  type D1RuntimePreparedStatement,
} from "@/lib/cloudflare/d1/runtime-binding";
import {
  resolveSiteEventsWriteAuthorityConfig,
  setRuntimeSiteEventsWriteAuthorityConfig,
  shouldWriteSiteEventToD1,
  SITE_EVENTS_D1_CANARY_PATH_PREFIX,
  writeSiteEventToRuntimeD1,
} from "@/lib/cloudflare/d1/write-authority/site-events";
import {
  clearRuntimeSearchServiceBinding,
  setRuntimeSearchServiceBinding,
  writeSiteEventViaRuntimeSearchService,
} from "@/lib/cloudflare/services/search-service-binding";
import { createWorldconsSearchServiceApp } from "@/workers/search-service/src/index";

test("M11 site_events authority defaults to Supabase and invalid values fail safe", () => {
  assert.deepEqual(resolveSiteEventsWriteAuthorityConfig({}), { authority: "supabase" });
  assert.deepEqual(
    resolveSiteEventsWriteAuthorityConfig({ WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY: "unexpected" }),
    { authority: "supabase" },
  );
  assert.deepEqual(
    resolveSiteEventsWriteAuthorityConfig({ WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY: "D1" }),
    { authority: "d1" },
  );
  assert.deepEqual(
    resolveSiteEventsWriteAuthorityConfig({ WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY: "d1-canary" }),
    { authority: "d1-canary" },
  );
});

test("M11 d1-canary authority is restricted to the explicit path and marker", () => {
  const config = { authority: "d1-canary" as const };
  assert.equal(shouldWriteSiteEventToD1({
    eventType: "page_view",
    path: `${SITE_EVENTS_D1_CANARY_PATH_PREFIX}-001`,
    metadata: { m11Canary: true },
  }, config), true);
  assert.equal(shouldWriteSiteEventToD1({
    eventType: "page_view",
    path: "/ordinary",
    metadata: { m11Canary: true },
  }, config), false);
  assert.equal(shouldWriteSiteEventToD1({
    eventType: "page_view",
    path: `${SITE_EVENTS_D1_CANARY_PATH_PREFIX}-001`,
    metadata: {},
  }, config), false);
  assert.equal(shouldWriteSiteEventToD1({
    eventType: "page_view",
    path: "/ordinary",
    metadata: {},
  }, { authority: "d1" }), true);
});

test("M11 runtime D1 writer performs one bound insert and requires one changed row", async () => {
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

  const result = await writeSiteEventToRuntimeD1({
    event_type: "page_view",
    path: `${SITE_EVENTS_D1_CANARY_PATH_PREFIX}-001`,
    article_id: null,
    article_slug: null,
    article_title: null,
    tag_slug: null,
    tag_name: null,
    source_key: null,
    jurisdiction: null,
    institution_name: null,
    search_query: null,
    search_mode: null,
    result_count: null,
    referrer_host: null,
    user_agent_family: "Server",
    device_type: "desktop",
    client_ip_hash: null,
    accept_language: "ko-KR",
    client_country: "KR",
    is_bot: false,
    metadata: { m11Canary: true },
  }, {
    id: "82ea78dd-a433-48fc-85e7-ec9e2503f70f",
    occurredAt: "2026-09-27T12:50:00.000Z",
  });

  assert.match(sql, /^INSERT INTO site_events/u);
  assert.equal(values.length, 23);
  assert.equal(values[0], result.id);
  assert.equal(values[1], result.occurredAt);
  assert.equal(values[2], "page_view");
  assert.equal(values[3], `${SITE_EVENTS_D1_CANARY_PATH_PREFIX}-001`);
  assert.equal(values[18], '{"m11Canary":true}');
  assert.equal(values[22], 0);
  clearRuntimeD1Bindings();
});

test("M11 selected D1 authority fails closed when the write binding is unavailable", async () => {
  clearRuntimeD1Bindings();
  setRuntimeSiteEventsWriteAuthorityConfig({ authority: "d1" });
  await assert.rejects(
    () => writeSiteEventToRuntimeD1({
      event_type: "page_view",
      path: "/",
      article_id: null,
      article_slug: null,
      article_title: null,
      tag_slug: null,
      tag_name: null,
      source_key: null,
      jurisdiction: null,
      institution_name: null,
      search_query: null,
      search_mode: null,
      result_count: null,
      referrer_host: null,
      user_agent_family: null,
      device_type: null,
      client_ip_hash: null,
      accept_language: null,
      client_country: null,
      is_bot: false,
      metadata: {},
    }),
    /binding_unavailable/u,
  );
  setRuntimeSiteEventsWriteAuthorityConfig(null);
});

test("M11 Cloudflare legacy bridge uses the private Service Binding and Vercel can fall back locally", async () => {
  clearRuntimeSearchServiceBinding();
  assert.equal(await writeSiteEventViaRuntimeSearchService(sampleRow()), null);

  let seenUrl = "";
  let seenBody: unknown = null;
  setRuntimeSearchServiceBinding({
    async fetch(request) {
      seenUrl = request.url;
      seenBody = await request.json();
      return new Response(null, { status: 204 });
    },
  }, false, false);
  assert.equal(await writeSiteEventViaRuntimeSearchService(sampleRow()), true);
  assert.equal(seenUrl, "https://worldcons-search.internal/internal/site-events/write");
  assert.deepEqual(seenBody, sampleRow());
  clearRuntimeSearchServiceBinding();
});

test("M11 internal legacy bridge validates and writes one bounded Supabase row", async () => {
  let written: unknown = null;
  const app = createWorldconsSearchServiceApp({
    async siteEventWrite(row) {
      written = row;
    },
  });
  const response = await app.request(
    "https://worldcons-search.internal/internal/site-events/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleRow()),
    },
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
  );
  assert.equal(response.status, 204);
  assert.deepEqual(written, sampleRow());

  const invalid = await app.request(
    "https://worldcons-search.internal/internal/site-events/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleRow(), event_type: "not-allowed" }),
    },
    {},
  );
  assert.equal(invalid.status, 400);
});

function sampleRow() {
  return {
    event_type: "page_view",
    path: "/__m11/control",
    article_id: null,
    article_slug: null,
    article_title: null,
    tag_slug: null,
    tag_name: null,
    source_key: null,
    jurisdiction: null,
    institution_name: null,
    search_query: null,
    search_mode: null,
    result_count: null,
    referrer_host: null,
    user_agent_family: "Server",
    device_type: "desktop",
    client_ip_hash: null,
    accept_language: "ko-KR",
    client_country: "KR",
    is_bot: false,
    metadata: { m11Control: true },
  };
}
