import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { dispatchSearchRepairs, readSearchRepairHealth, reconcileMissingSearchRepairs,
  type SearchRepairQueue } from "../../../lib/cloudflare/e2e/search-repair-dispatcher";

// Optional until M3 provisions a dedicated queue and deploys its protected
// Consumer. Never redirect identity messages to the existing M8/stage queues.
export interface E2ESearchRepairEnvironment {
  WORLDCONS_CORE: D1RuntimeDatabase;
  WORLDCONS_E2E_SEARCH_DISPATCH_ENABLED?: string;
  WORLDCONS_E2E_SEARCH_CONSUMER_READY?: string;
  E2E_SEARCH_REPAIR_QUEUE?: SearchRepairQueue;
}

export async function runE2ESearchRepairScheduled(env: E2ESearchRepairEnvironment) {
  if (env.WORLDCONS_E2E_SEARCH_DISPATCH_ENABLED !== "true") return { skipped: true,reason: "disabled" } as const;
  if (env.WORLDCONS_E2E_SEARCH_CONSUMER_READY !== "true" || !env.E2E_SEARCH_REPAIR_QUEUE) {
    console.error(JSON.stringify({ event: "e2e_search_repair_not_ready",reason: "protected_consumer_or_queue_missing" }));
    return { skipped: true,reason: "not_ready" } as const;
  }
  try {
    const reconciliation = await reconcileMissingSearchRepairs(env.WORLDCONS_CORE);
    const dispatch = await dispatchSearchRepairs(env.WORLDCONS_CORE,env.E2E_SEARCH_REPAIR_QUEUE);
    const health = await readSearchRepairHealth(env.WORLDCONS_CORE);
    console[health.requiresAttention ? "error" : "log"](JSON.stringify({
      event: health.requiresAttention ? "e2e_search_repair_attention" : "e2e_search_repair_dispatch",
      ...reconciliation,...dispatch,...health,
    }));
    return { skipped: false,reconciliation,dispatch,health } as const;
  } catch {
    // Missing new schema/DB errors are operational failures, never empty success.
    // Leased rows survive exceptions and are recovered by the next pass.
    console.error(JSON.stringify({ event: "e2e_search_repair_failed",reason: "schema_or_dispatch_unavailable" }));
    return { skipped: true,reason: "unavailable" } as const;
  }
}
