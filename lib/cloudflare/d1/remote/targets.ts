import { D1_DATABASES, type D1Database } from "../types";
import { D1_BINDINGS } from "./types";

/** One remote D1 bootstrap target: the exact database name plus its binding. */
export interface D1RemoteTarget {
  name: D1Database;
  binding: string;
}

/**
 * The four remote targets in the canonical `worldcons_core` -> `worldcons_search`
 * order. The order is fixed so the manifest and the create sequence are
 * deterministic.
 */
export const D1_REMOTE_TARGETS: readonly D1RemoteTarget[] = D1_DATABASES.map((name) => ({
  name,
  binding: D1_BINDINGS[name],
}));

/** Resolves the manifest order for an operator-selected subset of targets. */
export function selectD1RemoteTargets(
  databases?: readonly D1Database[],
): D1RemoteTarget[] {
  if (databases === undefined) return D1_REMOTE_TARGETS.map((target) => ({ ...target }));
  const selected = new Set(databases);
  return D1_REMOTE_TARGETS.filter((target) => selected.has(target.name)).map((target) => ({ ...target }));
}
