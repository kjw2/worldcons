/**
 * M5.2b D1 import barrel.
 *
 * The local `node:sqlite` target (`local-target.ts`) is intentionally NOT
 * re-exported here: it imports `node:sqlite`, and runtime Workers code must never
 * load it. Only the operator CLI and tests import that module directly.
 */
export * from "./types";
export {
  D1_MAX_BOUND_PARAMETERS,
  emitDatabaseImport,
  emitTableImport,
  renderImportSql,
  renderImportStatement,
} from "./emitter";
export type { EmitTableImportOptions } from "./emitter";
export { base64ToBytes, renderSqlLiteral } from "./literal";
export {
  applyDatabaseImport,
  applyDatabaseSchema,
  d1ReadStatement,
  verifyDatabaseImport,
  verifyTableImport,
} from "./apply";
export type { VerifyImportOptions } from "./apply";
export { buildD1ImportReport } from "./pipeline";
export type { BuildD1ImportReportOptions } from "./pipeline";
