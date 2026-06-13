import type { SourceAdapter } from "@/lib/sources/types";

export const sourceAdapterKeys = [
  "de-bverfg",
  "us-scotus",
  "fr-conseil-constitutionnel",
  "es-tribunal-constitucional",
] as const;

type SourceAdapterKey = (typeof sourceAdapterKeys)[number];

const adapterLoaders: Record<SourceAdapterKey, () => Promise<SourceAdapter>> = {
  "de-bverfg": async () => (await import("@/lib/sources/bundesverfassungsgericht")).bundesverfassungsgerichtAdapter,
  "us-scotus": async () => (await import("@/lib/sources/supremecourt")).supremeCourtAdapter,
  "fr-conseil-constitutionnel": async () => (await import("@/lib/sources/conseilconstitutionnel")).conseilConstitutionnelAdapter,
  "es-tribunal-constitucional": async () => (await import("@/lib/sources/tribunalconstitucional")).tribunalConstitucionalAdapter,
};

export async function loadSourceAdapter(sourceKey: string) {
  const loader = adapterLoaders[sourceKey as SourceAdapterKey];
  return loader ? loader() : null;
}

export async function loadSourceAdapters(options: { sourceKey?: string; activeSourceKeys?: Set<string> | null } = {}) {
  const keys = options.sourceKey ? [options.sourceKey] : sourceAdapterKeys;
  const adapters: SourceAdapter[] = [];

  for (const key of keys) {
    if (options.activeSourceKeys && !options.activeSourceKeys.has(key)) continue;
    const adapter = await loadSourceAdapter(key);
    if (adapter) adapters.push(adapter);
  }

  return adapters;
}
