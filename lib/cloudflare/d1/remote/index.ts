/**
 * M5.2c PART 1 remote D1 bootstrap barrel.
 *
 * The Wrangler child-process adapter (`runner.ts`) is intentionally NOT
 * re-exported here: it imports `node:child_process`, and runtime Workers code
 * must never load it. Only the operator CLI imports that module directly.
 */
export * from "./types";
export { D1_REMOTE_TARGETS, selectD1RemoteTargets } from "./targets";
export type { D1RemoteTarget } from "./targets";
export {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
} from "./classify";
export type { D1TargetClassification } from "./classify";
export { buildD1RemoteManifest } from "./bootstrap";
export type { BuildD1RemoteManifestOptions } from "./bootstrap";
