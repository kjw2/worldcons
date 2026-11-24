import { AsyncLocalStorage } from "node:async_hooks";
import type { D1RuntimeDatabase } from "./runtime-binding";

/**
 * Request-local memoization for the pure tag candidate lookup used by public
 * list reads. A `/list` render resolves the same tag twice (the crawlable list
 * and the popular-list fallback), so both callers share one tag-id query and
 * one article-id query inside a single explicitly scoped read.
 *
 * The scope is one AsyncLocalStorage run, never a module-level promise or D1
 * result. There is no fallback cache outside a scope, so independent requests,
 * scripts, tests and any write path keep their existing behavior.
 */
type TagCandidateScope = WeakMap<D1RuntimeDatabase, Map<string, Promise<string[]>>>;

const tagCandidateStorage = new AsyncLocalStorage<TagCandidateScope>();

/**
 * Runs one bounded read with a fresh request-local tag-candidate scope. Nested
 * calls reuse the existing scope, so caller-provided scopes are never replaced.
 */
export function runWithRequestLocalTagCandidates<T>(run: () => T): T {
  if (tagCandidateStorage.getStore()) return run();
  return tagCandidateStorage.run(new WeakMap(), run);
}

/**
 * Returns the cached tag candidate article ids for this binding and tag text,
 * or starts the loader once. A rejected loader is removed from the scope before
 * the rejection escapes so a later read can retry instead of observing a stale
 * failed promise.
 */
export function memoizeRequestLocalTagCandidates(
  binding: D1RuntimeDatabase,
  tag: string,
  load: () => Promise<string[]>,
): Promise<string[]> {
  const scope = tagCandidateStorage.getStore();
  if (!scope) return load();
  let byTag = scope.get(binding);
  if (!byTag) {
    byTag = new Map();
    scope.set(binding, byTag);
  }
  const cached = byTag.get(tag);
  if (cached) return cached;
  const pending = load().catch((error) => {
    if (byTag.get(tag) === pending) byTag.delete(tag);
    throw error;
  });
  byTag.set(tag, pending);
  return pending;
}
