import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowHeartbeatIsStale,
  type WorkflowHeartbeatRecord,
} from "@/lib/ops/workflow-heartbeat";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

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
});

test("missing, failed, or invalid heartbeat is stale", () => {
  assert.equal(workflowHeartbeatIsStale(null, NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({ lastStatus: "failed" }), NOW), true);
  assert.equal(workflowHeartbeatIsStale(heartbeat({ lastCompletedAt: "invalid" }), NOW), true);
});
