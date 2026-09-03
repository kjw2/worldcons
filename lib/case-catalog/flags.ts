import { articlePublicationV4ReadsEnabled } from "@/lib/article-publication/compatibility";

export const CASE_CATALOG_WRITE_FLAG = "CASE_CATALOG_WRITE_ENABLED";
export const CASE_CATALOG_PUBLIC_FLAG = "CASE_CATALOG_PUBLIC_ENABLED";
export const CASE_CATALOG_SEARCH_FLAG = "CASE_CATALOG_SEARCH_ENABLED";
export const CASE_CATALOG_PLUGIN_FLAG = "CASE_CATALOG_PLUGIN_ENABLED";
export const CASE_CATALOG_SEMANTIC_FLAG = "CASE_CATALOG_SEMANTIC_ENABLED";

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function caseCatalogWriteEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[CASE_CATALOG_WRITE_FLAG]);
}

export function caseCatalogFlagErrors(environment: Record<string, string | undefined> = process.env) {
  const p3Read = articlePublicationV4ReadsEnabled(environment);
  const publicRead = explicitTrue(environment[CASE_CATALOG_PUBLIC_FLAG]);
  const search = explicitTrue(environment[CASE_CATALOG_SEARCH_FLAG]);
  const plugin = explicitTrue(environment[CASE_CATALOG_PLUGIN_FLAG]);
  const semantic = explicitTrue(environment[CASE_CATALOG_SEMANTIC_FLAG]);
  const errors: string[] = [];
  if (publicRead && !p3Read) errors.push("CASE_CATALOG_PUBLIC_ENABLED requires ADMIN_PUBLICATION_V4_READ_ENABLED");
  if (search && !publicRead) errors.push("CASE_CATALOG_SEARCH_ENABLED requires CASE_CATALOG_PUBLIC_ENABLED");
  if (plugin && !search) errors.push("CASE_CATALOG_PLUGIN_ENABLED requires CASE_CATALOG_SEARCH_ENABLED");
  if (semantic && !search) errors.push("CASE_CATALOG_SEMANTIC_ENABLED requires CASE_CATALOG_SEARCH_ENABLED");
  return errors;
}

export function caseCatalogPublicReadsEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[CASE_CATALOG_PUBLIC_FLAG]) && caseCatalogFlagErrors(environment).length === 0;
}
