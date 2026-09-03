import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

export interface BverfgShadowPolicyEvidence {
  sourceKey: string;
  policyVersion: string;
  officialScopeUrl: string;
  discoveryMethods: string[];
  authorityHosts: string[];
  redirectHosts: string[];
  externalIndexHosts: string[];
  robotsUrl: string;
  licenseBasis: string;
  defaultTextAccessPolicy: string;
  allowRawSnapshot: boolean;
  normalizeReplayPolicy: string;
  boundedReplayFields: string[];
  retentionDays: number;
  minRequestDelayMs: number;
  maxConcurrency: number;
  reviewedBy: string;
  reviewedAt: string;
  reviewDueAt: string;
}

export interface BverfgShadowSnapshotEvidence {
  id: string;
  sourcePolicyVersion: string;
  status: string;
  manifestHash: string | null;
  enumerationManifestHash: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface BverfgShadowReadinessRepository {
  getPolicy(policyVersion: string): Promise<BverfgShadowPolicyEvidence | null>;
  listAnnualSnapshots(scopeFrom: string, scopeTo: string): Promise<BverfgShadowSnapshotEvidence[]>;
}

type Row = Record<string, unknown>;

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : "";
}

function nullableText(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function number(row: Row, key: string) {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function client() {
  const value = getSupabaseServiceRoleAdmin();
  if (!value) throw new Error("bverfg_shadow_readiness.database_unavailable");
  return value;
}

export const postgresBverfgShadowReadinessRepository: BverfgShadowReadinessRepository = {
  async getPolicy(policyVersion) {
    const { data, error } = await client()
      .from("source_corpus_policies")
      .select("source_key, policy_version, official_scope_url, discovery_methods, authority_hosts, redirect_hosts, external_index_hosts, robots_url, license_basis, default_text_access_policy, allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days, min_request_delay_ms, max_concurrency, reviewed_by, reviewed_at, review_due_at")
      .eq("source_key", "de-bverfg")
      .eq("policy_version", policyVersion)
      .maybeSingle();
    if (error) throw new Error(error.message || "bverfg_shadow_readiness.policy_query_failed");
    if (!data || typeof data !== "object") return null;
    const row = data as Row;
    return {
      sourceKey: text(row, "source_key"),
      policyVersion: text(row, "policy_version"),
      officialScopeUrl: text(row, "official_scope_url"),
      discoveryMethods: strings(row.discovery_methods),
      authorityHosts: strings(row.authority_hosts),
      redirectHosts: strings(row.redirect_hosts),
      externalIndexHosts: strings(row.external_index_hosts),
      robotsUrl: text(row, "robots_url"),
      licenseBasis: text(row, "license_basis"),
      defaultTextAccessPolicy: text(row, "default_text_access_policy"),
      allowRawSnapshot: row.allow_raw_snapshot === true,
      normalizeReplayPolicy: text(row, "normalize_replay_policy"),
      boundedReplayFields: strings(row.bounded_replay_fields),
      retentionDays: number(row, "retention_days"),
      minRequestDelayMs: number(row, "min_request_delay_ms"),
      maxConcurrency: number(row, "max_concurrency"),
      reviewedBy: text(row, "reviewed_by"),
      reviewedAt: text(row, "reviewed_at"),
      reviewDueAt: text(row, "review_due_at"),
    };
  },

  async listAnnualSnapshots(scopeFrom, scopeTo) {
    const { data, error } = await client()
      .from("source_inventory_snapshots")
      .select("id, source_policy_version, status, manifest_hash, enumeration_manifest_hash, opened_at, closed_at")
      .eq("source_key", "de-bverfg")
      .eq("scope_from", scopeFrom)
      .eq("scope_to", scopeTo)
      .eq("document_type", "DECISION")
      .order("opened_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message || "bverfg_shadow_readiness.snapshot_query_failed");
    return (Array.isArray(data) ? data : []).map((value) => {
      const row = value as Row;
      return {
        id: text(row, "id"),
        sourcePolicyVersion: text(row, "source_policy_version"),
        status: text(row, "status"),
        manifestHash: nullableText(row, "manifest_hash"),
        enumerationManifestHash: nullableText(row, "enumeration_manifest_hash"),
        openedAt: text(row, "opened_at"),
        closedAt: nullableText(row, "closed_at"),
      };
    });
  },
};
