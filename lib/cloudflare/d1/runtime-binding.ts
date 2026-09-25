import type { D1Database as D1DatabaseName } from "./types";

/**
 * M6.1 runtime-safe D1 binding injection.
 *
 * The Worker entry receives its D1 bindings from `env`. This module stores them
 * on an isolate-scoped `globalThis` slot so runtime code (the shadow read seam)
 * can resolve a binding without importing the Worker entry or any Node builtin.
 *
 * It defines only the structural Cloudflare `D1Database` surface the shadow
 * reader uses (`prepare().bind(...).all()`), so it compiles and runs in the
 * Worker without `@cloudflare/workers-types`. No `node:*` import appears here.
 */
export interface D1RuntimeResult<T = Record<string, unknown>> {
  success?: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
  error?: string | null;
}

export interface D1RuntimePreparedStatement {
  bind(...values: unknown[]): D1RuntimePreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>>;
}

export interface D1RuntimeDatabase {
  prepare(query: string): D1RuntimePreparedStatement;
}

/** The D1 binding name for each database (plan section 4.1). */
export const D1_RUNTIME_BINDING_NAMES: Record<D1DatabaseName, string> = {
  worldcons_core: "WORLDCONS_CORE",
  worldcons_ingest: "WORLDCONS_INGEST",
  worldcons_ops: "WORLDCONS_OPS",
  worldcons_search: "WORLDCONS_SEARCH",
};

export type D1RuntimeBindings = Partial<Record<D1DatabaseName, D1RuntimeDatabase | null>>;

interface WorldconsD1RuntimeGlobal {
  __worldconsD1RuntimeBindingsV1?: D1RuntimeBindings;
}

function runtimeGlobal(): typeof globalThis & WorldconsD1RuntimeGlobal {
  return globalThis as typeof globalThis & WorldconsD1RuntimeGlobal;
}

function existing(): D1RuntimeBindings {
  const target = runtimeGlobal();
  if (!target.__worldconsD1RuntimeBindingsV1) target.__worldconsD1RuntimeBindingsV1 = {};
  return target.__worldconsD1RuntimeBindingsV1;
}

/**
 * Registers the runtime D1 bindings. A `null`/`undefined` value clears that
 * database slot, so re-registering the Worker binding set (for example on every
 * request) is always authoritative and never leaves a stale binding behind.
 */
export function setRuntimeD1Bindings(bindings: D1RuntimeBindings): void {
  const target = existing();
  for (const name of Object.keys(D1_RUNTIME_BINDING_NAMES) as D1DatabaseName[]) {
    const binding = bindings[name];
    if (binding) target[name] = binding;
    else delete target[name];
  }
}

export function setRuntimeD1Binding(name: D1DatabaseName, binding: D1RuntimeDatabase | null): void {
  const target = existing();
  if (binding) target[name] = binding;
  else delete target[name];
}

export function getRuntimeD1Binding(name: D1DatabaseName): D1RuntimeDatabase | null {
  return existing()[name] ?? null;
}

export function getRuntimeD1Bindings(): D1RuntimeBindings {
  return { ...existing() };
}

export function clearRuntimeD1Bindings(): void {
  runtimeGlobal().__worldconsD1RuntimeBindingsV1 = {};
}
