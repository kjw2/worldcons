import { D1_DATABASES, type D1Schema } from "../types";
import { coreTables } from "./worldcons-core";
import { ingestTables } from "./worldcons-ingest";
import { opsTables } from "./worldcons-ops";
import { searchTables } from "./worldcons-search";
import { ownership } from "./ownership";

/** The canonical M5.1 D1 schema: four databases, covered + planned ownership. */
export const d1Schema: D1Schema = {
  version: 1,
  databases: [...D1_DATABASES],
  tables: [...coreTables, ...ingestTables, ...opsTables, ...searchTables],
  ownership,
};

export { coreTables } from "./worldcons-core";
export { ingestTables } from "./worldcons-ingest";
export { opsTables } from "./worldcons-ops";
export { searchTables } from "./worldcons-search";
export { ownership } from "./ownership";
export { buildTable, index, uniqueIndex } from "./shared";
export type { ColumnSpec, TableSpec } from "./shared";