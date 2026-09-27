export interface WorldconsSearchServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

interface RuntimeSearchServiceState {
  cclrag2Enabled: boolean;
  cclMetasearchEnabled: boolean;
  binding: WorldconsSearchServiceFetcher | null;
}

interface RuntimeSearchServiceGlobal {
  __worldconsSearchServiceBindingV1?: RuntimeSearchServiceState;
}

function runtimeGlobal(): typeof globalThis & RuntimeSearchServiceGlobal {
  return globalThis as typeof globalThis & RuntimeSearchServiceGlobal;
}

export function setRuntimeSearchServiceBinding(
  binding: WorldconsSearchServiceFetcher | undefined,
  cclrag2Enabled: boolean,
  cclMetasearchEnabled = false,
) {
  runtimeGlobal().__worldconsSearchServiceBindingV1 = {
    cclrag2Enabled,
    cclMetasearchEnabled,
    binding: binding ?? null,
  };
}

export function clearRuntimeSearchServiceBinding() {
  delete runtimeGlobal().__worldconsSearchServiceBindingV1;
}

export function runtimeSearchServiceState(): RuntimeSearchServiceState {
  return runtimeGlobal().__worldconsSearchServiceBindingV1 ?? {
    cclrag2Enabled: false,
    cclMetasearchEnabled: false,
    binding: null,
  };
}

export async function forwardToRuntimeSearchService(request: Request): Promise<Response | null> {
  const state = runtimeSearchServiceState();
  if (!state.cclrag2Enabled) return null;
  if (!state.binding) throw new Error("worldcons_search_service_binding_unavailable");
  const response = await state.binding.fetch(request);
  return materializeRuntimeSearchServiceResponse(response);
}

async function materializeRuntimeSearchServiceResponse(response: Response) {
  const init: ResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
  if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
    await response.body?.cancel();
    return new Response(null, init);
  }
  return new Response(await response.arrayBuffer(), init);
}

export type BoundCclMetasearchInput = {
  query: string;
  limit: number;
  offset: number;
  sort: "relevance" | "latest";
};

export type BoundCclMetasearchPage<Item = unknown> = {
  items: Item[];
  total: number;
};

export type BoundSiteEventWriteRow = {
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
};

export type BoundAdminAuditWriteRow = {
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
};

export type BoundAdminArticleEditWriteRow = {
  article_id: string;
  article_slug: string | null;
  actor_id: string | null;
  changed_fields: string[];
  previous_summary_hash: string | null;
  next_summary_hash: string | null;
  diff_redacted: Record<string, unknown>;
};

/**
 * Cloudflare-only legacy write bridge used during M11.
 *
 * A null result means no Service Binding exists (for example Vercel), so the
 * caller must keep using its existing local Supabase client. Once a binding is
 * present, failure is explicit and must not silently fall through to another
 * remote writer.
 */
export async function writeSiteEventViaRuntimeSearchService(
  row: BoundSiteEventWriteRow,
): Promise<true | null> {
  const state = runtimeSearchServiceState();
  if (!state.binding) return null;
  const response = await state.binding.fetch(new Request(
    "https://worldcons-search.internal/internal/site-events/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    },
  ));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("worldcons_site_events_legacy_bridge_unavailable");
  }
  await response.body?.cancel();
  return true;
}

export async function writeAdminAuditViaRuntimeSearchService(
  row: BoundAdminAuditWriteRow,
): Promise<true | null> {
  const state = runtimeSearchServiceState();
  if (!state.binding) return null;
  const response = await state.binding.fetch(new Request(
    "https://worldcons-search.internal/internal/admin-audit/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    },
  ));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("worldcons_admin_audit_legacy_bridge_unavailable");
  }
  await response.body?.cancel();
  return true;
}

export async function writeAdminArticleEditViaRuntimeSearchService(
  row: BoundAdminArticleEditWriteRow,
): Promise<true | null> {
  const state = runtimeSearchServiceState();
  if (!state.binding) return null;
  const response = await state.binding.fetch(new Request(
    "https://worldcons-search.internal/internal/admin-article-edit/write",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    },
  ));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("worldcons_admin_article_edit_legacy_bridge_unavailable");
  }
  await response.body?.cancel();
  return true;
}

export async function searchCclMetasearchViaRuntimeService<Item = unknown>(
  input: BoundCclMetasearchInput,
): Promise<BoundCclMetasearchPage<Item> | null> {
  const state = runtimeSearchServiceState();
  if (!state.cclMetasearchEnabled) return null;
  if (!state.binding) throw new Error("worldcons_search_service_binding_unavailable");

  const response = await state.binding.fetch(new Request(
    "https://worldcons-search.internal/internal/cclmetasearch/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  ));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("worldcons_cclmetasearch_service_unavailable");
  }
  const payload = await response.json() as unknown;
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray((payload as Record<string, unknown>).items)
    || !Number.isSafeInteger((payload as Record<string, unknown>).total)
    || Number((payload as Record<string, unknown>).total) < 0
  ) {
    throw new Error("worldcons_cclmetasearch_service_invalid_response");
  }
  return payload as BoundCclMetasearchPage<Item>;
}
