import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

export const SITE_EVENTS_WRITE_AUTHORITY_ENV = "WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY";
export const SITE_EVENTS_D1_CANARY_PATH_PREFIX = "/__m11/d1-runtime-canary";

export type SiteEventsWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface SiteEventsWriteAuthorityConfig {
  authority: SiteEventsWriteAuthority;
}

export interface SiteEventsWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export interface RuntimeSiteEventWriteInput {
  eventType: string;
  path: string | null;
  metadata: Record<string, unknown>;
}

export interface RuntimeSiteEventWriteRow {
  event_type: string;
  path: string | null;
  article_id: string | null;
  article_slug: string | null;
  article_title: string | null;
  tag_slug: string | null;
  tag_name: string | null;
  source_key: string | null;
  jurisdiction: string | null;
  institution_name: string | null;
  search_query: string | null;
  search_mode: string | null;
  result_count: number | null;
  referrer_host: string | null;
  user_agent_family: string | null;
  device_type: string | null;
  client_ip_hash: string | null;
  accept_language: string | null;
  client_country: string | null;
  is_bot: boolean;
  metadata: Record<string, unknown>;
}

interface SiteEventsWriteAuthorityGlobal {
  __worldconsSiteEventsWriteAuthorityV1?: SiteEventsWriteAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & SiteEventsWriteAuthorityGlobal {
  return globalThis as typeof globalThis & SiteEventsWriteAuthorityGlobal;
}

export function resolveSiteEventsWriteAuthorityConfig(
  environment: SiteEventsWriteAuthorityEnvironment = {},
): SiteEventsWriteAuthorityConfig {
  const raw = environment[SITE_EVENTS_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1" || raw === "d1-canary") return { authority: raw };
  return { authority: "supabase" };
}

export function setRuntimeSiteEventsWriteAuthorityConfig(
  config: SiteEventsWriteAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsSiteEventsWriteAuthorityV1 = config;
  else delete target.__worldconsSiteEventsWriteAuthorityV1;
}

export function getRuntimeSiteEventsWriteAuthorityConfig(): SiteEventsWriteAuthorityConfig {
  return runtimeGlobal().__worldconsSiteEventsWriteAuthorityV1 ?? { authority: "supabase" };
}

export function shouldWriteSiteEventToD1(
  input: RuntimeSiteEventWriteInput,
  config: SiteEventsWriteAuthorityConfig = getRuntimeSiteEventsWriteAuthorityConfig(),
) {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return (
    input.path?.startsWith(SITE_EVENTS_D1_CANARY_PATH_PREFIX) === true
    && input.metadata.m11Canary === true
  );
}

export async function writeSiteEventToRuntimeD1(
  row: RuntimeSiteEventWriteRow,
  identity: { id?: string; occurredAt?: string } = {},
) {
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (!binding) throw new Error("site_events_d1_authority.binding_unavailable");

  const id = identity.id ?? crypto.randomUUID();
  const occurredAt = identity.occurredAt ?? new Date().toISOString();
  const statement = binding.prepare([
    "INSERT INTO site_events (",
    "id, occurred_at, event_type, path, article_id, article_slug, article_title,",
    "tag_slug, tag_name, source_key, jurisdiction, institution_name, search_query,",
    "search_mode, result_count, referrer_host, user_agent_family, device_type,",
    "metadata, client_ip_hash, accept_language, client_country, is_bot",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" "));
  const bound = statement.bind(
    id,
    occurredAt,
    row.event_type,
    row.path,
    row.article_id,
    row.article_slug,
    row.article_title,
    row.tag_slug,
    row.tag_name,
    row.source_key,
    row.jurisdiction,
    row.institution_name,
    row.search_query,
    row.search_mode,
    row.result_count,
    row.referrer_host,
    row.user_agent_family,
    row.device_type,
    JSON.stringify(row.metadata),
    row.client_ip_hash,
    row.accept_language,
    row.client_country,
    row.is_bot ? 1 : 0,
  );
  if (!bound.run) throw new Error("site_events_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) {
    throw new Error("site_events_d1_authority.write_failed");
  }
  const changes = result.meta?.changes;
  if (changes !== 1) {
    throw new Error("site_events_d1_authority.unexpected_changes");
  }
  return { id, occurredAt };
}
