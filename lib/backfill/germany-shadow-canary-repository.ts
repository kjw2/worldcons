import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

export interface BverfgShadowCanaryRepository {
  getEvidence(snapshotId: string): Promise<unknown>;
}

export const postgresBverfgShadowCanaryRepository: BverfgShadowCanaryRepository = {
  async getEvidence(snapshotId) {
    const client = getSupabaseServiceRoleAdmin();
    if (!client) throw new Error("bverfg_shadow_canary.database_unavailable");
    const { data, error } = await client.rpc("case_backfill_bverfg_shadow_canary_v1", {
      p_snapshot_id: snapshotId,
    });
    if (error) throw new Error(error.message || "bverfg_shadow_canary.database_error");
    return data;
  },
};
