import { bundesverfassungsgerichtAdapter } from "@/lib/sources/bundesverfassungsgericht";
import { conseilConstitutionnelAdapter } from "@/lib/sources/conseilconstitutionnel";
import { supremeCourtAdapter } from "@/lib/sources/supremecourt";
import { tribunalConstitucionalAdapter } from "@/lib/sources/tribunalconstitucional";

export const sourceAdapters = [
  bundesverfassungsgerichtAdapter,
  supremeCourtAdapter,
  conseilConstitutionnelAdapter,
  tribunalConstitucionalAdapter,
];

export function getSourceAdapter(sourceKey: string) {
  return sourceAdapters.find((adapter) => adapter.sourceKey === sourceKey) ?? null;
}
