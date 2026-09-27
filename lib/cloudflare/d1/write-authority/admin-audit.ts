import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

export const ADMIN_AUDIT_WRITE_AUTHORITY_ENV = "WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY";
export const M11_ADMIN_AUDIT_CANARY_ACTION = "m11.admin_audit_canary";

export type AdminAuditWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface AdminAuditWriteAuthorityConfig {
  authority: AdminAuditWriteAuthority;
}

export interface AdminAuditWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export interface RuntimeAdminAuditWriteRow {
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  article_id: string | null;
  article_slug: string | null;
  source_key: string | null;
  job_id: string | null;
  result: string | null;
  error_class: string | null;
  redacted_metadata: Record<string, unknown>;
  request_ip_hash: string | null;
  user_agent_family: string | null;
}

interface AdminAuditWriteAuthorityGlobal {
  __worldconsAdminAuditWriteAuthorityV1?: AdminAuditWriteAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & AdminAuditWriteAuthorityGlobal {
  return globalThis as typeof globalThis & AdminAuditWriteAuthorityGlobal;
}

export function resolveAdminAuditWriteAuthorityConfig(
  environment: AdminAuditWriteAuthorityEnvironment = {},
): AdminAuditWriteAuthorityConfig {
  const raw = environment[ADMIN_AUDIT_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1" || raw === "d1-canary") return { authority: raw };
  return { authority: "supabase" };
}

export function setRuntimeAdminAuditWriteAuthorityConfig(
  config: AdminAuditWriteAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsAdminAuditWriteAuthorityV1 = config;
  else delete target.__worldconsAdminAuditWriteAuthorityV1;
}

export function getRuntimeAdminAuditWriteAuthorityConfig(): AdminAuditWriteAuthorityConfig {
  return runtimeGlobal().__worldconsAdminAuditWriteAuthorityV1 ?? { authority: "supabase" };
}

export function shouldWriteAdminAuditToD1(
  row: RuntimeAdminAuditWriteRow,
  config: AdminAuditWriteAuthorityConfig = getRuntimeAdminAuditWriteAuthorityConfig(),
) {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return (
    row.action === M11_ADMIN_AUDIT_CANARY_ACTION
    && row.redacted_metadata.m11AuditCanary === true
  );
}

export async function writeAdminAuditToRuntimeD1(
  row: RuntimeAdminAuditWriteRow,
  identity: { id?: string; occurredAt?: string } = {},
) {
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (!binding) throw new Error("admin_audit_d1_authority.binding_unavailable");

  const id = identity.id ?? crypto.randomUUID();
  const occurredAt = identity.occurredAt ?? new Date().toISOString();
  const statement = binding.prepare([
    "INSERT INTO admin_audit_logs (",
    "id, occurred_at, actor_id, actor_role, action, target_type, target_id,",
    "article_id, article_slug, source_key, job_id, result, error_class,",
    "redacted_metadata, request_ip_hash, user_agent_family",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" "));
  const bound = statement.bind(
    id,
    occurredAt,
    row.actor_id,
    row.actor_role,
    row.action,
    row.target_type,
    row.target_id,
    row.article_id,
    row.article_slug,
    row.source_key,
    row.job_id,
    row.result,
    row.error_class,
    JSON.stringify(row.redacted_metadata),
    row.request_ip_hash,
    row.user_agent_family,
  );
  if (!bound.run) throw new Error("admin_audit_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) {
    throw new Error("admin_audit_d1_authority.write_failed");
  }
  if (result.meta?.changes !== 1) {
    throw new Error("admin_audit_d1_authority.unexpected_changes");
  }
  return { id, occurredAt };
}
