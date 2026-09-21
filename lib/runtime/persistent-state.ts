import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCloudflareWorkerRuntime } from "@/lib/runtime/platform";

/**
 * Runtime-neutral persistent JSON state.
 *
 * The Node/Vercel runtime keeps its existing filesystem-backed behaviour (with an
 * in-process fallback when the filesystem is unwritable). The Cloudflare Worker
 * runtime has no reliable request-time filesystem, so it uses an isolate-scoped
 * in-memory store instead of resolving `process.cwd()`/`os.tmpdir()` paths.
 *
 * A future Worker-persistent backend (KV/R2/Durable Object) only has to call
 * `setRuntimeJsonStateStore` with a compatible implementation; callers stay
 * unchanged.
 */
export interface RuntimeJsonStateRef {
  /** Stable identity; also the key used by the in-memory Worker store. */
  fileName: string;
  /** Raw `GEMINI_CACHE_DIR`-style override of the base cache directory. */
  cacheDir?: string;
  /** Raw explicit file path override (absolute or process.cwd-relative). */
  explicitPath?: string;
}

export interface RuntimeJsonStateStore {
  read<T>(ref: RuntimeJsonStateRef): T | null;
  write(ref: RuntimeJsonStateRef, value: unknown): boolean;
}

interface WorldconsPersistentStateGlobal {
  __worldconsRuntimeJsonStateStoreV1?: RuntimeJsonStateStore;
  __worldconsRuntimeJsonStateMemoryV1?: Map<string, unknown>;
}

function runtimeGlobal(): typeof globalThis & WorldconsPersistentStateGlobal {
  return globalThis as typeof globalThis & WorldconsPersistentStateGlobal;
}

function memoryMap(): Map<string, unknown> {
  const target = runtimeGlobal();
  if (!target.__worldconsRuntimeJsonStateMemoryV1) {
    target.__worldconsRuntimeJsonStateMemoryV1 = new Map();
  }
  return target.__worldconsRuntimeJsonStateMemoryV1;
}

export function setRuntimeJsonStateStore(store: RuntimeJsonStateStore | null): void {
  const target = runtimeGlobal();
  if (store) target.__worldconsRuntimeJsonStateStoreV1 = store;
  else delete target.__worldconsRuntimeJsonStateStoreV1;
}

/**
 * In-memory store backed by a shared global map, so re-registering it (for
 * example on every Worker request) never discards state held by the isolate.
 */
export function createMemoryRuntimeJsonStateStore(): RuntimeJsonStateStore {
  return {
    read<T>(ref: RuntimeJsonStateRef): T | null {
      const value = memoryMap().get(ref.fileName);
      return (value ?? null) as T | null;
    },
    write(ref: RuntimeJsonStateRef, value: unknown): boolean {
      memoryMap().set(ref.fileName, value);
      return true;
    },
  };
}

function defaultCacheDir() {
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) return path.join(os.tmpdir(), "worldcons");
  return path.resolve(process.cwd(), ".cache");
}

function resolveStatePath(ref: RuntimeJsonStateRef) {
  const explicitPath = ref.explicitPath?.trim();
  if (explicitPath) return path.resolve(explicitPath);
  const cacheDir = ref.cacheDir?.trim();
  const base = cacheDir ? path.resolve(cacheDir) : defaultCacheDir();
  return path.join(base, ref.fileName);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function createNodeFsRuntimeJsonStateStore(): RuntimeJsonStateStore {
  return {
    read<T>(ref: RuntimeJsonStateRef): T | null {
      const fileValue = readJsonFile<T>(resolveStatePath(ref));
      if (fileValue !== null && fileValue !== undefined) return fileValue;
      const memoryValue = memoryMap().get(ref.fileName);
      return (memoryValue ?? null) as T | null;
    },
    write(ref: RuntimeJsonStateRef, value: unknown): boolean {
      memoryMap().set(ref.fileName, value);
      return writeJsonFile(resolveStatePath(ref), value);
    },
  };
}

export function runtimeJsonStateStore(): RuntimeJsonStateStore {
  const explicit = runtimeGlobal().__worldconsRuntimeJsonStateStoreV1;
  if (explicit) return explicit;
  return isCloudflareWorkerRuntime() ? createMemoryRuntimeJsonStateStore() : createNodeFsRuntimeJsonStateStore();
}

export function readRuntimeJsonState<T>(ref: RuntimeJsonStateRef): T | null {
  return runtimeJsonStateStore().read<T>(ref);
}

export function writeRuntimeJsonState(ref: RuntimeJsonStateRef, value: unknown): boolean {
  return runtimeJsonStateStore().write(ref, value);
}
