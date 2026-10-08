import assert from "node:assert/strict";
import test from "node:test";
import { getP5HealthEvidenceFromD1 } from "@/lib/admin/p5/d1-health-repository";
import { clearRuntimeD1Bindings, setRuntimeD1Binding, type D1RuntimePreparedStatement, type D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";

function responseFor(sql: string) {
  if (sql.includes("queue_states")) return [{ queue_states: "{}", stale_lease_count: 0, abort_pending_count: 0, retry_waiting_count: 0, legacy_in_flight: 0, new_in_flight: 0 }];
  if (sql.includes("backlog_count")) return [{ backlog_count: 0, unresolved_anomaly_count: 0 }];
  if (sql.includes("legacy_public_count")) return [{ legacy_public_count: 0, explicit_public_count: 0, parity_mismatch_count: 0, quarantine_count: 0, legacy_digest: "0::", explicit_digest: "0::" }];
  if (sql.includes("pending_count")) return [{ pending_count: 0, processing_count: 0, dead_letter_count: 0 }];
  if (sql.includes("FROM sources")) return [{ source_key: "de-bverfg", is_active: 1 }];
  if (sql.includes("MAX(started_at)")) return [{ source_key: "de-bverfg", started_at: "2026-09-29T11:00:00.000Z" }];
  if (sql.includes("total_count")) return [{ total_count: 0, bucket_count: 0 }];
  if (sql.includes("command_attempts_due")) return [{ command_attempts_due: 0, command_events_due: 0, compatibility_due: 0, legal_hold_active: 0 }];
  if (sql.includes("publication_history_due")) return [{ publication_history_due: 0, content_versions_due: 0, delivered_outbox_due: 0, dead_letter_outbox_due: 0 }];
  if (sql.includes("lifecycle_events_due")) return [{ lifecycle_events_due: 0 }];
  return [];
}

function binding(calls: string[], fail = false) {
  return {
    prepare(sql: string) {
      calls.push(sql);
      const statement: D1RuntimePreparedStatement = {
        bind() { return statement; },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          if (fail) return { success: false, error: "query failed" };
          return { success: true, results: responseFor(sql) as T[] };
        },
      };
      return statement;
    },
  };
}

test("P5 D1 adapter reads each owning database and returns the P5 evidence contract", async () => {
  const calls = { ops: [] as string[], core: [] as string[], ingest: [] as string[] };
  setRuntimeD1Binding("worldcons_ops", binding(calls.ops));
  setRuntimeD1Binding("worldcons_core", binding(calls.core));
  setRuntimeD1Binding("worldcons_ingest", binding(calls.ingest));
  try {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const evidence = await getP5HealthEvidenceFromD1({
      observationStart: "2026-09-28T12:00:00.000Z",
      observationEnd: now.toISOString(),
      now,
    });
    assert.equal(evidence.available, true);
    assert.equal(evidence.sources[0]?.sourceKey, "de-bverfg");
    assert.equal(evidence.sources[0]?.freshnessAgeSeconds, 3600);
    assert.equal(evidence.queue.staleLeaseCount, 0);
    assert.ok(calls.ops.some((sql) => sql.includes("admin_compatibility_observations_p5")));
    assert.ok(calls.core.some((sql) => sql.includes("article_publication_quarantine_p3")));
    assert.ok(calls.core.some((sql) => /FROM article_publication_quarantine_p3 q[\s\S]*WHERE NOT EXISTS[\s\S]*article_publication_quarantine_resolutions_p3 r/u.test(sql)), "P5 must exclude historically resolved quarantine rows without deleting the audit trail");
    assert.ok(calls.core.some((sql) => /r\.article_id\s*=\s*q\.article_id\s+AND\s+r\.anomaly_code\s*=\s*q\.anomaly_code/u.test(sql)), "resolution must match article and anomaly identity");
    assert.ok(calls.ingest.some((sql) => sql.includes("FROM ingestion_runs")));
    assert.ok(calls.ops.every((sql) => !sql.includes("FROM sources")));
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("P5 D1 adapter fails closed when an owning D1 read fails", async () => {
  const calls: string[] = [];
  setRuntimeD1Binding("worldcons_ops", binding(calls, true));
  setRuntimeD1Binding("worldcons_core", binding(calls));
  setRuntimeD1Binding("worldcons_ingest", binding(calls));
  try {
    const evidence = await getP5HealthEvidenceFromD1({ observationStart: "2026-09-28T12:00:00.000Z", observationEnd: "2026-09-29T12:00:00.000Z", now: new Date("2026-09-29T12:00:00.000Z") });
    assert.equal(evidence.available, false);
  } finally {
    clearRuntimeD1Bindings();
  }
});
