import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { m13ProfileValueForEnvVar } from "@/lib/cloudflare/m13/profile-override";

export const ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY_ENV = "WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY";
export const M11_ADMIN_ARTICLE_EDIT_CANARY_ARTICLE_SLUG = "m11-admin-article-edit-canary";

export type AdminArticleEditWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface AdminArticleEditWriteAuthorityConfig {
  authority: AdminArticleEditWriteAuthority;
}

export interface AdminArticleEditWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export interface RuntimeAdminArticleEditWriteRow {
  article_id: string;
  article_slug: string | null;
  actor_id: string | null;
  changed_fields: string[];
  previous_summary_hash: string | null;
  next_summary_hash: string | null;
  diff_redacted: Record<string, unknown>;
}

interface AdminArticleEditWriteAuthorityGlobal {
  __worldconsAdminArticleEditWriteAuthorityV1?: AdminArticleEditWriteAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & AdminArticleEditWriteAuthorityGlobal {
  return globalThis as typeof globalThis & AdminArticleEditWriteAuthorityGlobal;
}

export function resolveAdminArticleEditWriteAuthorityConfig(
  environment: AdminArticleEditWriteAuthorityEnvironment = {},
): AdminArticleEditWriteAuthorityConfig {
  if (m13ProfileValueForEnvVar(ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1-canary") return { authority: raw };
  return { authority: "d1" };
}

export function setRuntimeAdminArticleEditWriteAuthorityConfig(
  config: AdminArticleEditWriteAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsAdminArticleEditWriteAuthorityV1 = config;
  else delete target.__worldconsAdminArticleEditWriteAuthorityV1;
}

export function getRuntimeAdminArticleEditWriteAuthorityConfig(): AdminArticleEditWriteAuthorityConfig {
  return runtimeGlobal().__worldconsAdminArticleEditWriteAuthorityV1 ?? { authority: "d1" };
}

export function shouldWriteAdminArticleEditToD1(
  row: RuntimeAdminArticleEditWriteRow,
  config: AdminArticleEditWriteAuthorityConfig = getRuntimeAdminArticleEditWriteAuthorityConfig(),
) {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return row.article_slug === M11_ADMIN_ARTICLE_EDIT_CANARY_ARTICLE_SLUG;
}

export async function writeAdminArticleEditToRuntimeD1(
  row: RuntimeAdminArticleEditWriteRow,
  identity: { id?: string; editedAt?: string } = {},
) {
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (!binding) throw new Error("admin_article_edit_d1_authority.binding_unavailable");

  const id = identity.id ?? crypto.randomUUID();
  const editedAt = identity.editedAt ?? new Date().toISOString();
  const statement = binding.prepare([
    "INSERT INTO admin_article_edit_history (",
    "id, article_id, article_slug, edited_at, actor_id, changed_fields,",
    "previous_summary_hash, next_summary_hash, diff_redacted",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" "));
  const bound = statement.bind(
    id,
    row.article_id,
    row.article_slug,
    editedAt,
    row.actor_id,
    JSON.stringify(row.changed_fields),
    row.previous_summary_hash,
    row.next_summary_hash,
    JSON.stringify(row.diff_redacted),
  );
  if (!bound.run) throw new Error("admin_article_edit_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) {
    throw new Error("admin_article_edit_d1_authority.write_failed");
  }
  if (result.meta?.changes !== 1) {
    throw new Error("admin_article_edit_d1_authority.unexpected_changes");
  }
  return { id, editedAt };
}
