import type { SourceAdapter } from "@/lib/sources/types";
import type { SourceDiscoveryOptions } from "@/lib/crawler/types";
import { sourceAdapters } from "@/lib/sources";

export async function discoverSource(adapter: SourceAdapter, limit = Number(process.env.INGEST_LIMIT_PER_SOURCE ?? 20), options?: SourceDiscoveryOptions) {
  const items = await adapter.discover(options);
  return items.slice(0, limit);
}

export async function discoverAllSources(adapters = sourceAdapters) {
  const results = await Promise.allSettled(adapters.map((adapter) => discoverSource(adapter)));
  return results.map((result, index) => ({
    sourceKey: adapters[index]?.sourceKey ?? "unknown",
    status: result.status,
    items: result.status === "fulfilled" ? result.value : [],
    error: result.status === "rejected" ? String(result.reason) : undefined,
  }));
}
