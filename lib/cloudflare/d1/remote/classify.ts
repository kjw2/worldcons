import type { D1RemoteListEntry, D1RemoteDatabaseInfo } from "./types";
import type { D1RemoteTarget } from "./targets";

/**
 * A fail-closed remote D1 error. `code` is stable and machine-readable; the
 * message never includes raw Wrangler output, so a malformed or hostile result
 * cannot leak into logs or the manifest.
 */
export class D1RemoteError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "D1RemoteError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parses the current `wrangler d1 list --json` output. It must be a JSON array of
 * objects with a non-empty `name` and `uuid`; anything else fails closed.
 */
export function parseD1RemoteListJson(stdout: string): D1RemoteListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1RemoteError("d1_remote.malformed_list_json", "d1 list --json did not return JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new D1RemoteError("d1_remote.malformed_list_json", "d1 list --json did not return a JSON array");
  }
  return parsed.map((value, index) => {
    const record = asRecord(value);
    const name = record === null ? null : optionalString(record, "name");
    const uuid = record === null ? null : optionalString(record, "uuid");
    if (name === null || uuid === null) {
      throw new D1RemoteError(
        "d1_remote.malformed_list_entry",
        `d1 list --json entry ${index} is missing a string name/uuid`,
      );
    }
    return { uuid, name, createdAt: optionalString(record as Record<string, unknown>, "created_at") };
  });
}

/**
 * Parses the current `wrangler d1 info NAME --json` output. It must be a JSON
 * object with a non-empty `name` and `uuid`; anything else fails closed.
 */
export function parseD1RemoteInfoJson(stdout: string): D1RemoteDatabaseInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1RemoteError("d1_remote.malformed_info_json", "d1 info --json did not return JSON");
  }
  const record = asRecord(parsed);
  const name = record === null ? null : optionalString(record, "name");
  const uuid = record === null ? null : optionalString(record, "uuid");
  if (record === null || name === null || uuid === null) {
    throw new D1RemoteError(
      "d1_remote.malformed_info_json",
      "d1 info --json is missing a string name/uuid",
    );
  }
  return {
    uuid,
    name,
    createdAt: optionalString(record, "created_at"),
    numTables: optionalNumber(record, "num_tables"),
    fileSize: optionalNumber(record, "file_size"),
    jurisdiction: optionalString(record, "jurisdiction"),
  };
}

/** How one target name matches the `d1 list` result. */
export interface D1TargetClassification {
  target: D1RemoteTarget;
  state: "missing" | "existing" | "ambiguous";
  entry: D1RemoteListEntry | null;
  /** How many list entries share the exact target name (0, 1 or more). */
  matches: number;
}

/**
 * Classifies each target against the parsed `d1 list` entries. A name that
 * appears more than once is `ambiguous` and must be refused rather than guessed;
 * only an exact single match is `existing`.
 */
export function classifyD1RemoteTargets(
  entries: readonly D1RemoteListEntry[],
  targets: readonly D1RemoteTarget[],
): D1TargetClassification[] {
  return targets.map((target) => {
    const matches = entries.filter((entry) => entry.name === target.name);
    if (matches.length === 0) return { target, state: "missing", entry: null, matches: 0 };
    if (matches.length === 1) return { target, state: "existing", entry: matches[0], matches: 1 };
    return { target, state: "ambiguous", entry: matches[0], matches: matches.length };
  });
}
