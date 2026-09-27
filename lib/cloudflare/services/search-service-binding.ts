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
  return state.binding.fetch(request);
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
