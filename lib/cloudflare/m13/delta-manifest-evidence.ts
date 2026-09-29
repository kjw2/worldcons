import fs from "node:fs";
import {
  D1_REMOTE_RECONCILE_ACTIONS,
  D1_REMOTE_RECONCILE_STATES,
  D1_REMOTE_RECONCILE_VERSION,
  type D1RemoteReconcileManifest,
  type D1RemoteReconcileManifestTarget,
  type D1RemoteReconcileManifestTotals,
  type D1RemoteReconcileTableTarget,
} from "@/lib/cloudflare/d1/remote/reconcile";
import {
  M13_FINAL_DELTA_DATABASES,
  evaluateM13FinalDelta,
  type M13FinalDeltaReport,
} from "@/lib/cloudflare/m13/final-delta";

/**
 * M13 final-delta evidence from immutable raw reconcile manifests.
 *
 * After the permanent D1 authority switch, Supabase is frozen and D1 receives
 * legitimate new writes. A live `--source=` parity re-run therefore diverges by
 * design and can never reproduce the pre-switch machine evidence. This module
 * lets `pnpm m13:readiness --delta-manifests=<path1>,<path2>,<path3>` re-evaluate
 * the raw, immutable PRE-SWITCH reconcile manifests using the exact same
 * `evaluateM13FinalDelta` logic as a live run.
 *
 * It accepts only raw M5.2d reconcile manifests — never an aggregate boolean or
 * user-authored summary. It fails closed on a missing file, invalid JSON, a
 * non-dry-run/apply manifest, wrong database coverage (missing/duplicate/extra
 * target databases), or a structurally malformed manifest. It reads files
 * locally and read-only; it never writes, never fetches and never mutates.
 */

export interface M13DeltaManifestReader {
  readFile(filePath: string): string;
}

const defaultReader: M13DeltaManifestReader = {
  readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}

function parseTableTarget(raw: unknown, label: string): D1RemoteReconcileTableTarget {
  const table = requireRecord(raw, label);
  const state = requireString(table.state, `${label}.state`);
  if (!(D1_REMOTE_RECONCILE_STATES as readonly string[]).includes(state)) {
    throw new Error(`${label}.state is not a valid reconcile state: ${state}`);
  }
  const action = requireString(table.action, `${label}.action`);
  if (!(D1_REMOTE_RECONCILE_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`${label}.action is not a valid reconcile action: ${action}`);
  }
  const remoteHash = table.remoteHash === null ? null : requireString(table.remoteHash, `${label}.remoteHash`);
  return {
    table: requireString(table.table, `${label}.table`),
    database: requireString(table.database, `${label}.database`) as D1RemoteReconcileTableTarget["database"],
    sourceTable: requireString(table.sourceTable, `${label}.sourceTable`),
    state: state as D1RemoteReconcileTableTarget["state"],
    action: action as D1RemoteReconcileTableTarget["action"],
    expectedRowCount: requireNumber(table.expectedRowCount, `${label}.expectedRowCount`),
    expectedHash: requireString(table.expectedHash, `${label}.expectedHash`),
    remoteRowCount: requireNumber(table.remoteRowCount, `${label}.remoteRowCount`),
    remoteHash,
    insertRowCount: requireNumber(table.insertRowCount, `${label}.insertRowCount`),
    updateRowCount: requireNumber(table.updateRowCount, `${label}.updateRowCount`),
    remoteOnlyRowCount: requireNumber(table.remoteOnlyRowCount, `${label}.remoteOnlyRowCount`),
    commonUnchangedRowCount: requireNumber(table.commonUnchangedRowCount, `${label}.commonUnchangedRowCount`),
    insertStatementCount: requireNumber(table.insertStatementCount, `${label}.insertStatementCount`),
    updateStatementCount: requireNumber(table.updateStatementCount, `${label}.updateStatementCount`),
    verified: requireBoolean(table.verified, `${label}.verified`),
    errors: requireStringArray(table.errors, `${label}.errors`),
  };
}

function parseManifest(raw: unknown, label: string): D1RemoteReconcileManifest {
  const manifest = requireRecord(raw, label);
  if (manifest.version !== D1_REMOTE_RECONCILE_VERSION) {
    throw new Error(`${label}.version must be ${D1_REMOTE_RECONCILE_VERSION}`);
  }
  if (manifest.stage !== "d1-remote-reconcile") {
    throw new Error(`${label}.stage must be "d1-remote-reconcile" (received ${String(manifest.stage)})`);
  }
  if (manifest.dryRun !== true) {
    throw new Error(`${label}.dryRun must be true; only a read-only dry-run reconcile manifest is acceptable evidence`);
  }
  if (manifest.applied !== false) {
    throw new Error(`${label}.applied must be false; an apply manifest is not acceptable evidence`);
  }
  const rawTargets = requireRecordArray(manifest.targets, `${label}.targets`);
  if (rawTargets.length !== 1) {
    throw new Error(`${label}.targets must contain exactly one target database (received ${rawTargets.length})`);
  }
  const targetRecord = rawTargets[0];
  const name = requireString(targetRecord.name, `${label}.targets[0].name`);
  if (!(M13_FINAL_DELTA_DATABASES as readonly string[]).includes(name)) {
    throw new Error(`${label}.targets[0].name is not an M13 final-delta database: ${name}`);
  }
  const action = requireString(targetRecord.action, `${label}.targets[0].action`);
  if (!(D1_REMOTE_RECONCILE_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`${label}.targets[0].action is not a valid reconcile action: ${action}`);
  }
  const rawTables = requireRecordArray(targetRecord.tables, `${label}.targets[0].tables`);
  if (rawTables.length === 0) {
    throw new Error(`${label}.targets[0].tables must contain at least one reconciled table`);
  }
  const target: D1RemoteReconcileManifestTarget = {
    name: name as D1RemoteReconcileManifestTarget["name"],
    binding: requireString(targetRecord.binding, `${label}.targets[0].binding`),
    state: requireString(targetRecord.state, `${label}.targets[0].state`) as D1RemoteReconcileManifestTarget["state"],
    action: action as D1RemoteReconcileManifestTarget["action"],
    tableCount: requireNumber(targetRecord.tableCount, `${label}.targets[0].tableCount`),
    expectedRowCount: requireNumber(targetRecord.expectedRowCount, `${label}.targets[0].expectedRowCount`),
    remoteRowCount: requireNumber(targetRecord.remoteRowCount, `${label}.targets[0].remoteRowCount`),
    insertedRowCount: requireNumber(targetRecord.insertedRowCount, `${label}.targets[0].insertedRowCount`),
    updatedRowCount: requireNumber(targetRecord.updatedRowCount, `${label}.targets[0].updatedRowCount`),
    verified: requireBoolean(targetRecord.verified, `${label}.targets[0].verified`),
    tables: rawTables.map((entry, index) => parseTableTarget(entry, `${label}.targets[0].tables[${index}]`)),
    errors: requireStringArray(targetRecord.errors, `${label}.targets[0].errors`),
  };
  return {
    version: D1_REMOTE_RECONCILE_VERSION,
    stage: "d1-remote-reconcile",
    dryRun: true,
    applied: false,
    targets: [target],
    totals: manifest.totals as D1RemoteReconcileManifestTotals,
    commands: Array.isArray(manifest.commands) ? requireStringArray(manifest.commands, `${label}.commands`) : [],
    ok: manifest.ok === true,
    errors: Array.isArray(manifest.errors) ? requireStringArray(manifest.errors, `${label}.errors`) : [],
  };
}

function parseManifestFile(filePath: string, reader: M13DeltaManifestReader): D1RemoteReconcileManifest {
  let contents: string;
  try {
    contents = reader.readFile(filePath);
  } catch (error) {
    throw new Error(`--delta-manifests could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`--delta-manifests ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(parsed, `--delta-manifests ${filePath}`);
}

function assertManifestStructure(manifest: D1RemoteReconcileManifest): void {
  if (manifest.version !== D1_REMOTE_RECONCILE_VERSION) {
    throw new Error(`--delta-manifests manifest version must be ${D1_REMOTE_RECONCILE_VERSION}`);
  }
  if (manifest.stage !== "d1-remote-reconcile") {
    throw new Error(`--delta-manifests manifest stage must be "d1-remote-reconcile"`);
  }
  if (manifest.dryRun !== true) {
    throw new Error("--delta-manifests manifest dryRun must be true; only a read-only dry-run reconcile manifest is acceptable evidence");
  }
  if (manifest.applied !== false) {
    throw new Error("--delta-manifests manifest applied must be false; an apply manifest is not acceptable evidence");
  }
}

function combineTargets(manifests: readonly D1RemoteReconcileManifest[]): D1RemoteReconcileManifestTarget[] {
  const byDatabase = new Map<string, D1RemoteReconcileManifestTarget>();
  for (const manifest of manifests) {
    assertManifestStructure(manifest);
    if (manifest.targets.length !== 1) {
      throw new Error(`--delta-manifests must supply exactly one target database per manifest (received ${manifest.targets.length})`);
    }
    for (const target of manifest.targets) {
      if (!(M13_FINAL_DELTA_DATABASES as readonly string[]).includes(target.name)) {
        throw new Error(`--delta-manifests target database is outside the M13 final-delta scope: ${target.name}`);
      }
      if (target.tables.length === 0) {
        throw new Error(`--delta-manifests target ${target.name} must contain at least one reconciled table`);
      }
      if (target.tableCount !== target.tables.length) {
        throw new Error(
          `--delta-manifests target ${target.name} tableCount ${target.tableCount} does not match its ${target.tables.length} table entries`,
        );
      }
      for (const table of target.tables) {
        if (table.database !== target.name) {
          throw new Error(
            `--delta-manifests table ${table.table} declares database ${table.database} but is nested under target ${target.name}`,
          );
        }
      }
      if (byDatabase.has(target.name)) {
        throw new Error(`--delta-manifests supplies duplicate target database: ${target.name}`);
      }
      byDatabase.set(target.name, target);
    }
  }
  const missing = M13_FINAL_DELTA_DATABASES.filter((database) => !byDatabase.has(database));
  if (missing.length > 0) {
    throw new Error(`--delta-manifests is missing target database(s): ${missing.join(", ")}`);
  }
  const extra = [...byDatabase.keys()].filter((name) => !(M13_FINAL_DELTA_DATABASES as readonly string[]).includes(name));
  if (extra.length > 0) {
    throw new Error(`--delta-manifests supplies target database(s) outside the M13 final-delta scope: ${extra.join(", ")}`);
  }
  return M13_FINAL_DELTA_DATABASES.map((database) => byDatabase.get(database) as D1RemoteReconcileManifestTarget);
}

/**
 * Re-evaluates already-parsed raw reconcile manifests with the existing M13
 * final-delta logic. Each manifest must cover exactly one distinct target
 * database; the union must be exactly `worldcons_core`, `worldcons_ingest` and
 * `worldcons_ops` with no missing, duplicate or extra database.
 */
export function evaluateM13FinalDeltaFromManifests(
  manifests: readonly D1RemoteReconcileManifest[],
): M13FinalDeltaReport {
  if (manifests.length !== M13_FINAL_DELTA_DATABASES.length) {
    throw new Error(
      `--delta-manifests requires exactly ${M13_FINAL_DELTA_DATABASES.length} raw reconcile manifests (received ${manifests.length})`,
    );
  }
  const targets = combineTargets(manifests);
  const combined: D1RemoteReconcileManifest = {
    version: D1_REMOTE_RECONCILE_VERSION,
    stage: "d1-remote-reconcile",
    dryRun: true,
    applied: false,
    targets,
    totals: manifests[0].totals,
    commands: [],
    ok: manifests.every((manifest) => manifest.ok),
    errors: manifests.flatMap((manifest) => manifest.errors),
  };
  return evaluateM13FinalDelta(combined);
}

/**
 * Reads and validates exactly three raw reconcile manifest files (read-only,
 * local) and returns the same `M13FinalDeltaReport` shape a live `--source=`
 * run produces.
 */
export function evaluateM13FinalDeltaFromManifestFiles(
  paths: readonly string[],
  reader: M13DeltaManifestReader = defaultReader,
): M13FinalDeltaReport {
  if (paths.length !== M13_FINAL_DELTA_DATABASES.length) {
    throw new Error(
      `--delta-manifests requires exactly ${M13_FINAL_DELTA_DATABASES.length} manifest files (received ${paths.length})`,
    );
  }
  const manifests = paths.map((filePath) => parseManifestFile(filePath, reader));
  return evaluateM13FinalDeltaFromManifests(manifests);
}
