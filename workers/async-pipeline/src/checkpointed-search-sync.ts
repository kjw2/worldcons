import {
  listManagedSearchProjectionIds,
  runNativeSearchProjectionSync,
  syncManagedSearchProjectionBatch,
  type SearchProjectionSyncBindings,
} from "./search-projection-sync";

export const MANAGED_SEARCH_SYNC_BATCH_SIZE = 12;

type ManagedBatchResult = Awaited<ReturnType<typeof syncManagedSearchProjectionBatch>>;
type FullSyncResult = Awaited<ReturnType<typeof runNativeSearchProjectionSync>>;

/**
 * The main web/test TypeScript compilation cannot import Cloudflare's
 * WorkflowStep runtime module. Keep the checkpoint algorithm portable,
 * while the Worker entrypoint owns real durable step.do operations.
 */
export interface SearchSyncCheckpointAdapter {
  inventory(name: string, read: () => Promise<string[]>): Promise<string[]>;
  managed(name: string, sync: () => Promise<ManagedBatchResult>): Promise<ManagedBatchResult>;
  terminal(name: string, reconcile: () => Promise<FullSyncResult>): Promise<FullSyncResult>;
}

export async function runCheckpointedSearchProjectionSync(
  bindings: SearchProjectionSyncBindings,
  step: SearchSyncCheckpointAdapter,
  label: string,
) {
  const ids = await step.inventory(`${label}-managed-inventory`,
    () => listManagedSearchProjectionIds(bindings.WORLDCONS_CORE));
  let checked = 0;
  const changes = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  for (let start = 0; start < ids.length; start += MANAGED_SEARCH_SYNC_BATCH_SIZE) {
    const batch = ids.slice(start, start + MANAGED_SEARCH_SYNC_BATCH_SIZE);
    const result = await step.managed(
      `${label}-managed-${String(start / MANAGED_SEARCH_SYNC_BATCH_SIZE + 1).padStart(4, "0")}`,
      () => syncManagedSearchProjectionBatch(bindings, batch));
    if (result.processed !== batch.length) throw new Error("search_projection.managed_batch_incomplete");
    checked += result.processed;
    for(const key of ["added","changed","removed","unchanged"] as const)changes[key]+=result.changes[key];
  }
  if (checked !== ids.length) throw new Error("search_projection.managed_batches_incomplete");
  // Still perform the original unprotected full corpus reconciliation and
  // terminal Search/FTS count/identity checks, but do not re-run the already
  // checkpointed protected identities. Reject a changed managed inventory.
  const result = await step.terminal(`${label}-unmanaged-reconcile`,
    () => runNativeSearchProjectionSync(bindings, {preverifiedManagedIds:ids}));
  return { ...result, managedChecked: checked, managedChanges: changes,
    managedBatches: Math.ceil(ids.length / MANAGED_SEARCH_SYNC_BATCH_SIZE) };
}
