import { bundesverfassungsgerichtAdapter } from "@/lib/sources/bundesverfassungsgericht";
import { conseilConstitutionnelAdapter } from "@/lib/sources/conseilconstitutionnel";
import { supremeCourtAdapter } from "@/lib/sources/supremecourt";

export const sourceAdapters = [
  bundesverfassungsgerichtAdapter,
  supremeCourtAdapter,
  conseilConstitutionnelAdapter,
];

export function getSourceAdapter(sourceKey: string) {
  return sourceAdapters.find((adapter) => adapter.sourceKey === sourceKey) ?? null;
}
