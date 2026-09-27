import assert from "node:assert/strict";
import test from "node:test";
import {
  buildM10SiteEventDelete,
  buildM10SiteEventInsert,
  buildM10SiteEventSelect,
  canonicalizeM10SiteEventRow,
  createM10SiteEventCanaryRow,
  M10_SITE_EVENT_CANARY_PATH,
  M10_SITE_EVENT_CANARY_SOURCE_KEY,
  m10SiteEventRowsMatch,
} from "@/lib/cloudflare/d1/write-canary/site-events";

const ID = "ee3ac059-01e6-4728-a627-05fe09a66919";
const OCCURRED_AT = "2026-09-27T12:37:13Z";

test("M10 site-event canary is explicit, bounded and D1-authoritative", () => {
  const row = createM10SiteEventCanaryRow({ id: ID, occurredAt: OCCURRED_AT });
  assert.equal(row.id, ID);
  assert.equal(row.occurred_at, OCCURRED_AT);
  assert.equal(row.event_type, "security_event");
  assert.equal(row.path, M10_SITE_EVENT_CANARY_PATH);
  assert.equal(row.source_key, M10_SITE_EVENT_CANARY_SOURCE_KEY);
  assert.equal(row.result_count, 1);
  assert.equal(row.is_bot, false);
  assert.deepEqual(row.metadata, {
    authority: "d1",
    m10Canary: true,
    purpose: "site_events_write_canary",
  });
});

test("M10 D1 statements bind the canary identity instead of interpolating it", () => {
  const row = createM10SiteEventCanaryRow({ id: ID, occurredAt: OCCURRED_AT });
  const insert = buildM10SiteEventInsert(row);
  const select = buildM10SiteEventSelect(ID);
  const remove = buildM10SiteEventDelete(ID);

  assert.equal(insert.sql.includes(ID), false);
  assert.deepEqual(insert.params?.slice(0, 5), [
    ID,
    OCCURRED_AT,
    "security_event",
    "/__m10/d1-write-canary",
    "m10-d1-write-canary",
  ]);
  assert.equal(select.sql.endsWith("WHERE id = ?"), true);
  assert.deepEqual(select.params, [ID]);
  assert.equal(remove.sql, "DELETE FROM site_events WHERE id = ?");
  assert.deepEqual(remove.params, [ID]);
});

test("M10 canonical comparison treats SQLite and Postgres storage forms as equivalent", () => {
  const d1 = {
    id: ID,
    occurred_at: OCCURRED_AT,
    event_type: "security_event",
    path: "/__m10/d1-write-canary",
    source_key: "m10-d1-write-canary",
    result_count: 1,
    metadata:
      '{"authority":"d1","m10Canary":true,"purpose":"site_events_write_canary"}',
    is_bot: 0,
  };
  const postgres = {
    ...d1,
    metadata: {
      purpose: "site_events_write_canary",
      authority: "d1",
      m10Canary: true,
    },
    is_bot: false,
  };
  assert.equal(m10SiteEventRowsMatch(d1, postgres), true);
  assert.deepEqual(canonicalizeM10SiteEventRow(d1), canonicalizeM10SiteEventRow(postgres));
});

test("M10 canonical comparison fails closed on a field mismatch", () => {
  const base = {
    id: ID,
    occurred_at: OCCURRED_AT,
    event_type: "security_event",
    path: "/__m10/d1-write-canary",
    source_key: "m10-d1-write-canary",
    result_count: 1,
    metadata: '{"authority":"d1","m10Canary":true,"purpose":"site_events_write_canary"}',
    is_bot: 0,
  };
  assert.equal(m10SiteEventRowsMatch(base, { ...base, result_count: 2 }), false);
});

test("M10 canary rejects malformed identity and timestamp", () => {
  assert.throws(
    () => createM10SiteEventCanaryRow({ id: "not-a-uuid", occurredAt: OCCURRED_AT }),
    /invalid_id/u,
  );
  assert.throws(
    () => createM10SiteEventCanaryRow({ id: ID, occurredAt: "2026-09-27T12:37:13.123Z" }),
    /invalid_occurred_at/u,
  );
});
