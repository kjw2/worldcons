import { AsyncLocalStorage } from "node:async_hooks";
import type { D1Database as D1DatabaseName } from "./types";
import type { VectorizeIndexBinding } from "@/lib/cloudflare/search-vector/types";

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
  run?(): Promise<D1RuntimeResult>;
}

export interface D1RuntimeDatabase {
  prepare(query: string): D1RuntimePreparedStatement;
  batch?(statements: D1RuntimePreparedStatement[]): Promise<D1RuntimeResult[]>;
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
  __worldconsSearchVectorBindingV1?: VectorizeIndexBinding;
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
 * Per-request binding scope. The isolate-global slot remains the fallback for
 * scripts, tests and RPC entrypoints, but a Worker request that runs inside this
 * scope resolves its own D1 wrapper. That keeps `rows_read` accounting attached
 * to the request that actually executed the reads even when another request is
 * rendering concurrently or waiting on a coalesced cache miss.
 */
const d1BindingStorage = new AsyncLocalStorage<D1RuntimeBindings>();

const D1_BINDING_NAMES = Object.keys(D1_RUNTIME_BINDING_NAMES) as D1DatabaseName[];

/**
 * Runs one request with an authoritative request-local binding set. Any D1 read
 * started by this callback (including nested async continuations) sees these
 * bindings instead of whatever another concurrent request stored globally.
 */
export function runWithRuntimeD1Bindings<T>(bindings: D1RuntimeBindings, run: () => T): T {
  const scope: D1RuntimeBindings = {};
  for (const name of D1_BINDING_NAMES) scope[name] = bindings[name] ?? null;
  return d1BindingStorage.run(scope, run);
}

/**
 * Registers the runtime D1 bindings. A `null`/`undefined` value clears that
 * database slot, so re-registering the Worker binding set (for example on every
 * request) is always authoritative and never leaves a stale binding behind.
 * Inside `runWithRuntimeD1Bindings` the request-local scope is updated instead
 * of the isolate-global fallback.
 */
export function setRuntimeD1Bindings(bindings: D1RuntimeBindings): void {
  const scope = d1BindingStorage.getStore();
  const target = scope ?? existing();
  for (const name of D1_BINDING_NAMES) {
    const binding = bindings[name];
    if (binding) target[name] = binding;
    else delete target[name];
  }
}

export function setRuntimeD1Binding(name: D1DatabaseName, binding: D1RuntimeDatabase | null): void {
  const target = d1BindingStorage.getStore() ?? existing();
  if (binding) target[name] = binding;
  else delete target[name];
}

export function getRuntimeD1Binding(name: D1DatabaseName): D1RuntimeDatabase | null {
  const scope = d1BindingStorage.getStore();
  if (scope) return scope[name] ?? null;
  return existing()[name] ?? null;
}

export function getRuntimeD1Bindings(): D1RuntimeBindings {
  const scope = d1BindingStorage.getStore();
  return { ...(scope ?? existing()) };
}

export function setRuntimeSearchVectorBinding(
  binding: VectorizeIndexBinding | null | undefined,
): void {
  const target = runtimeGlobal();
  if (binding) target.__worldconsSearchVectorBindingV1 = binding;
  else delete target.__worldconsSearchVectorBindingV1;
}

export function getRuntimeSearchVectorBinding(): VectorizeIndexBinding | null {
  return runtimeGlobal().__worldconsSearchVectorBindingV1 ?? null;
}

export function clearRuntimeD1Bindings(): void {
  const scope = d1BindingStorage.getStore();
  if (scope) {
    for (const name of D1_BINDING_NAMES) delete scope[name];
    return;
  }
  runtimeGlobal().__worldconsD1RuntimeBindingsV1 = {};
  delete runtimeGlobal().__worldconsSearchVectorBindingV1;
}
