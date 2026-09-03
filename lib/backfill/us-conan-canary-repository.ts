import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

export interface UsConanCatalogCanaryRepository {
  getEvidence(candidateId: string): Promise<unknown>;
}

export const postgresUsConanCatalogCanaryRepository: UsConanCatalogCanaryRepository = {
  async getEvidence(candidateId) {
    const client = getSupabaseServiceRoleAdmin();
    if (!client) throw new Error("us_canary.database_unavailable");
    const { data, error } = await client.rpc("us_conan_candidate_catalog_canary_v1", {
      p_candidate_id: candidateId,
    });
    if (error) throw new Error(error.message || "us_canary.database_error");
    return data;
  },
};
