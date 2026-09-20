import assert from "node:assert/strict";
import test from "node:test";
import { acquireOperatorLock } from "../lib/ops/operator-lock";

test("operator lock blocks a concurrent claimant and releases cleanly", async () => {
  const key = "unit-operator-lock-" + process.pid;
  const first = await acquireOperatorLock(key);
  await assert.rejects(() => acquireOperatorLock(key), /operator_lock\.busy/);
  await first.release();

  const second = await acquireOperatorLock(key);
  await second.release();
});
