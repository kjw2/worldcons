export interface WorldconsSearchServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

interface RuntimeSearchServiceState {
  enabled: boolean;
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
  enabled: boolean,
) {
  runtimeGlobal().__worldconsSearchServiceBindingV1 = {
    enabled,
    binding: binding ?? null,
  };
}

export function clearRuntimeSearchServiceBinding() {
  delete runtimeGlobal().__worldconsSearchServiceBindingV1;
}

export function runtimeSearchServiceState(): RuntimeSearchServiceState {
  return runtimeGlobal().__worldconsSearchServiceBindingV1 ?? {
    enabled: false,
    binding: null,
  };
}

export async function forwardToRuntimeSearchService(request: Request): Promise<Response | null> {
  const state = runtimeSearchServiceState();
  if (!state.enabled) return null;
  if (!state.binding) throw new Error("worldcons_search_service_binding_unavailable");
  return state.binding.fetch(request);
}
