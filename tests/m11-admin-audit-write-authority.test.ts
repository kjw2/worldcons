import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Binding,
  type D1RuntimePreparedStatement,
} from "@/lib/cloudflare/d1/runtime-binding";
import {
  M11_ADMIN_AUDIT_CANARY_ACTION,
  resolveAdminAuditWriteAuthorityConfig,
  shouldWriteAdminAuditToD1,
  writeAdminAuditToRuntimeD1,
} from "@/lib/cloudflare/d1/write-authority/admin-audit";

test("M13 admin audit authority defaults to D1 and supports bounded canary mode", () => {
  assert.deepEqual(resolveAdminAuditWriteAuthorityConfig({}), { authority: "d1" });
  assert.deepEqual(resolveAdminAuditWriteAuthorityConfig({
    WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY: "d1-canary",
  }), { authority: "d1-canary" });
  assert.deepEqual(resolveAdminAuditWriteAuthorityConfig({
    WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminAuditWriteAuthorityConfig({
    WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY: "invalid",
  }), { authority: "d1" });
});

test("M11.1 d1-canary only selects the explicit canary action plus marker", () => {
  const row = sampleAuditRow();
  assert.equal(shouldWriteAdminAuditToD1(row, { authority: "d1-canary" }), true);
  assert.equal(shouldWriteAdminAuditToD1(
    { ...row, action: "ordinary.admin.action" },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteAdminAuditToD1(
    { ...row, redacted_metadata: {} },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteAdminAuditToD1(
    { ...row, action: "ordinary.admin.action", redacted_metadata: {} },
    { authority: "d1" },
  ), true);
});

test("M11.1 D1 audit writer performs one parameterized insert", async () => {
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
  const result = await writeAdminAuditToRuntimeD1(sampleAuditRow(), {
    id: "2342e778-523b-47da-8fa6-c74ba617e4a5",
    occurredAt: "2026-09-27T13:40:00.000Z",
  });
  assert.match(sql, /^INSERT INTO admin_audit_logs/u);
  assert.equal(values.length, 16);
  assert.equal(values[0], result.id);
  assert.equal(values[1], result.occurredAt);
  assert.equal(values[4], M11_ADMIN_AUDIT_CANARY_ACTION);
  assert.equal(values[13], '{"m11AuditCanary":true,"runId":"m11.1"}');
  clearRuntimeD1Bindings();
});

test("M11.1 selected D1 audit authority fails closed when the write binding is unavailable", async () => {
  clearRuntimeD1Bindings();
  await assert.rejects(
    () => writeAdminAuditToRuntimeD1(sampleAuditRow()),
    /binding_unavailable/u,
  );
});

function sampleAuditRow() {
  return {
    actor_id: "m11-canary",
    actor_role: "admin",
    action: M11_ADMIN_AUDIT_CANARY_ACTION,
    target_type: "migration_canary",
    target_id: "worldcons_ops.admin_audit_logs",
    article_id: null,
    article_slug: null,
    source_key: null,
    job_id: null,
    result: "ok",
    error_class: null,
    redacted_metadata: { m11AuditCanary: true, runId: "m11.1" },
    request_ip_hash: null,
    user_agent_family: "Server",
  };
}
