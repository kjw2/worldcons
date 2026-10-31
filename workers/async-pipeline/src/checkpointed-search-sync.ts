import {
  listManagedSearchProjectionIds,
  runNativeSearchProjectionSync,
  syncManagedSearchProjectionBatch,
  type SearchProjectionSyncBindings,
} from "./search-projection-sync";
import type { WorkflowStep } from "cloudflare:workers";

export const MANAGED_SEARCH_SYNC_BATCH_SIZE = 12;

export async function runCheckpointedSearchProjectionSync(
  bindings: SearchProjectionSyncBindings,
  step: WorkflowStep,
  label: string,
) {
  const ids = await step.do(`${label}-managed-inventory`, {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes",
  }, () => listManagedSearchProjectionIds(bindings.WORLDCONS_CORE));
  let checked = 0;
  const changes = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  for (let start = 0; start < ids.length; start += MANAGED_SEARCH_SYNC_BATCH_SIZE) {
    const batch = ids.slice(start, start + MANAGED_SEARCH_SYNC_BATCH_SIZE);
    const result = await step.do(`${label}-managed-${String(start / MANAGED_SEARCH_SYNC_BATCH_SIZE + 1).padStart(4, "0")}`, {
      retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes",
    }, () => syncManagedSearchProjectionBatch(bindings, batch));
    if (result.processed !== batch.length) throw new Error("search_projection.managed_batch_incomplete");
    checked += result.processed;
    for(const key of ["added","changed","removed","unchanged"] as const)changes[key]+=result.changes[key];
  }
  if (checked !== ids.length) throw new Error("search_projection.managed_batches_incomplete");
  // Still perform the original unprotected full corpus reconciliation and
  // terminal Search/FTS count/identity checks, but do not re-run the already
  // checkpointed protected identities. Reject a changed managed inventory.
  const result = await step.do(`${label}-unmanaged-reconcile`, {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
  }, () => runNativeSearchProjectionSync(bindings, {preverifiedManagedIds:ids}));
  return { ...result, managedChecked: checked, managedChanges: changes,
    managedBatches: Math.ceil(ids.length / MANAGED_SEARCH_SYNC_BATCH_SIZE) };
}
