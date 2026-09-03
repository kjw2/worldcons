import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  runWithRequiredWorkflowHeartbeat,
  workflowHeartbeatIsStale,
  type WorkflowHeartbeatRecord,
  type WorkflowHeartbeatStatus,
} from "@/lib/ops/workflow-heartbeat";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const watchdogRoutePath = path.join(process.cwd(), "app/api/ops/watchdog/route.ts");

function heartbeat(overrides: Partial<WorkflowHeartbeatRecord> = {}): WorkflowHeartbeatRecord {
  return {
    workflowKey: "summary",
    lastStartedAt: "2026-08-31T06:30:00.000Z",
    lastCompletedAt: "2026-08-31T06:31:00.000Z",
    lastStatus: "success",
    runId: "run-1",
    ...overrides,
  };
}

test("workflow heartbeat uses each workflow's 2.5x processing interval", () => {
  assert.equal(workflowHeartbeatIsStale(heartbeat(), NOW), false);
  assert.equal(workflowHeartbeatIsStale(heartbeat({ lastCompletedAt: "2026-08-30T18:00:00.000Z" }), NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({
    workflowKey: "collection",
    lastStartedAt: "2026-08-29T00:00:00.000Z",
    lastCompletedAt: "2026-08-29T00:30:00.000Z",
  }), NOW), false);
  assert.equal(workflowHeartbeatIsStale(heartbeat({
    workflowKey: "catalog_backfill",
    lastStartedAt: "2026-08-29T12:00:00.000Z",
    lastCompletedAt: "2026-08-29T12:01:00.000Z",
  }), NOW), false);
  assert.equal(workflowHeartbeatIsStale(heartbeat({
    workflowKey: "catalog_backfill",
    lastStartedAt: "2026-08-28T00:00:00.000Z",
    lastCompletedAt: "2026-08-28T00:01:00.000Z",
  }), NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({
    workflowKey: "watchdog",
    lastStartedAt: "2026-08-30T07:00:00.000Z",
    lastCompletedAt: "2026-08-30T07:00:00.000Z",
  }), NOW), false);
  assert.equal(workflowHeartbeatIsStale(heartbeat({
    workflowKey: "watchdog",
    lastStartedAt: "2026-08-30T05:00:00.000Z",
    lastCompletedAt: "2026-08-30T05:00:00.000Z",
  }), NOW), true);
});

test("missing, failed, or invalid heartbeat is stale", () => {
  assert.equal(workflowHeartbeatIsStale(null, NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({ lastStatus: "failed" }), NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({ lastCompletedAt: "invalid" }), NOW), true);
});

test("required workflow heartbeat records the complete route lifecycle", async () => {
  const statuses: WorkflowHeartbeatStatus[] = [];
  const result = await runWithRequiredWorkflowHeartbeat(
    "watchdog",
    async () => "ok",
    async (_key, status) => { statuses.push(status); },
  );
  assert.equal(result, "ok");
  assert.deepEqual(statuses, ["running", "success"]);

  statuses.length = 0;
  await assert.rejects(
    runWithRequiredWorkflowHeartbeat(
      "watchdog",
      async () => { throw new Error("watchdog failed"); },
      async (_key, status) => { statuses.push(status); },
    ),
    /watchdog failed/,
  );
  assert.deepEqual(statuses, ["running", "failed"]);
});

test("Vercel watchdog route authenticates before recording its required heartbeat", () => {
  const source = fs.readFileSync(watchdogRoutePath, "utf8");
  const authBoundary = source.indexOf("if (!isAuthorizedSecretRequest(request))");
  const heartbeat = source.indexOf("runWithRequiredWorkflowHeartbeat(\"watchdog\"");
  assert(authBoundary >= 0);
  assert(heartbeat > authBoundary);
  assert.match(source, /evaluateWatchdog\(\)[\s\S]*recordWatchdogEvents\(result\)/);
});
