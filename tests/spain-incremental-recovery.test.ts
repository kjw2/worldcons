import assert from "node:assert/strict";
import test from "node:test";
import {
  pairedSpainStagedOwnership,
  parseSpainIncrementalRecoveryCommand,
  SPAIN_INCREMENTAL_RECOVERY_DAYS,
} from "../workers/async-pipeline/src/spain-incremental-recovery";

test("Spain recovery accepts only exact Cloudflare IAM workflow payload", () => {
  assert.deepEqual(parseSpainIncrementalRecoveryCommand({ schemaVersion: 1, mode: "bootstrap-once" }), { ok: true });
  for (const payload of [
    null,
    { schemaVersion: 1, mode: "bootstrap-once", url: "https://other.example" },
    { schemaVersion: 1, mode: "bootstrap-once", sourceKey: "de-bverfg" },
    { schemaVersion: 1, mode: "bootstrap-once", publish: true },
    { schemaVersion: 1, mode: "bootstrap-once", limit: 9999 },
    { schemaVersion: 1, mode: "unknown" },
    { schemaVersion: 2, mode: "bootstrap-once" },
  ]) assert.equal(parseSpainIncrementalRecoveryCommand(payload).ok, false);
});
test("Spain recovery is staged-owned and distinct from daily 180-day bootstrap", () => {
  const es = "es-tribunal-constitucional";
  assert.equal(SPAIN_INCREMENTAL_RECOVERY_DAYS, 181);
  assert.equal(pairedSpainStagedOwnership(`fr-conseil-constitutionnel,${es}`, `de-bverfg,${es}`), true);
  assert.equal(pairedSpainStagedOwnership(es, ""), false);
  assert.equal(pairedSpainStagedOwnership("de-bverfg", es), false);
  assert.equal(pairedSpainStagedOwnership("es-tribunal", es), false);
});
