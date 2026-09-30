import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { createD1AdminOpsReadRepository } from "@/lib/admin/ops-read-repository/d1-read-repository";
import { mockAdminOpsReads } from "@/lib/admin/ops-read-repository/mock-repository";
import type { AdminOpsReadRepository } from "@/lib/admin/ops-read-repository/types";

export * from "@/lib/admin/ops-read-repository/mock-repository";
export * from "@/lib/admin/ops-read-repository/shared";
export * from "@/lib/admin/ops-read-repository/d1-read-repository";
export * from "@/lib/admin/ops-read-repository/types";

/**
 * Cloudflare D1 is the only persistent privileged admin/ops read authority.
 */
export function adminOpsReads(): AdminOpsReadRepository {
  const core = getRuntimeD1Binding("worldcons_core");
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (core && ingest) {
    const d1 = createD1AdminOpsReadRepository({
      binding: core,
      ingestBinding: ingest,
    });
    return {
      ...d1,
      loadDashboardSnapshot: async () => null,
      isConfigured: () => true,
    };
  }
  return mockAdminOpsReads;
}
