/**
 * M5.2c remote D1 operator barrel: PART 1 bootstrap + PART 2a schema apply.
 *
 * The Wrangler child-process adapter (`runner.ts`) is intentionally NOT
 * re-exported here: it imports `node:child_process`, and runtime Workers code
 * must never load it. Only the operator CLI imports that module directly. This
 * barrel is pure: it imports no Node builtins.
 */
export * from "./types";
export { D1_REMOTE_TARGETS, selectD1RemoteTargets } from "./targets";
export type { D1RemoteTarget } from "./targets";
export {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
  parseD1ExecuteResultsJson,
} from "./classify";
export type { D1TargetClassification } from "./classify";
export { buildD1RemoteManifest } from "./bootstrap";
export type { BuildD1RemoteManifestOptions } from "./bootstrap";

export { buildD1SchemaApplyManifest, d1SchemaObjects, D1_SCHEMA_OBJECT_QUERY } from "./schema-apply";
export type { BuildD1SchemaApplyManifestOptions, D1SchemaObjects } from "./schema-apply";

export {
  buildD1MigrationApplyManifest,
  buildD1RemoteMigrations,
  normalizeD1MigrationSql,
  parseD1MigrationVerifyDirectives,
  D1_MIGRATION_OBJECT_QUERY,
  D1_MIGRATION_VERIFY_PREFIX,
} from "./migration-apply";
export type { BuildD1MigrationApplyManifestOptions } from "./migration-apply";

export {
  buildD1RemoteReconcileManifest,
  D1_REMOTE_RECONCILE_ACTIONS,
  D1_REMOTE_RECONCILE_DATABASES,
  D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE,
  D1_REMOTE_RECONCILE_DEFAULT_ROWS_PER_INSERT,
  D1_REMOTE_RECONCILE_STATES,
  D1_REMOTE_RECONCILE_VERSION,
} from "./reconcile";
export type {
  BuildD1RemoteReconcileManifestOptions,
  D1RemoteReconcileAction,
  D1RemoteReconcileManifest,
  D1RemoteReconcileManifestTarget,
  D1RemoteReconcileManifestTotals,
  D1RemoteReconcileState,
  D1RemoteReconcileTableTarget,
} from "./reconcile";
