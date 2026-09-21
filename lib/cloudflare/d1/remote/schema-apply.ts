import { emitDatabaseDdl } from "../ddl";
import { d1Schema } from "../schema";
import type { D1Database, D1Schema } from "../types";
import {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1ExecuteResultsJson,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
} from "./classify";
import { selectD1RemoteTargets, type D1RemoteTarget } from "./targets";
import {
  D1_REMOTE_SCHEMA_APPLY_VERSION,
  type D1RemoteSchemaManifest,
  type D1RemoteSchemaManifestTarget,
  type WranglerD1Runner,
} from "./types";

/**
 * M5.2c PART 2a remote D1 schema-apply operator.
 *
 * Applies the M5.1 DDL to the four *existing* remote `worldcons_*` databases that
 * M5.2c PART 1 created. It is operator-only, dry-run by default and verified:
 *
 * - preflight reads `d1 list --json` and refuses a missing or ambiguous target
 *   (it never creates a database);
 * - in apply mode it writes the emitted DDL through `materializeDdl`, runs
 *   `wrangler d1 execute NAME --remote --yes --file <path>` and parses the
 *   `--json` result envelope, so a non-`success` response fails closed;
 * - it reads `sqlite_master` through `d1 execute --command` and confirms every
 *   expected table and index name is present, in both dry-run and apply mode;
 * - it never deletes a database, never deploys, never copies data and never
 *   changes production authority.
 *
 * It never throws for a remote failure: it returns a manifest with `ok:false`
 * and per-target errors. It throws only for a caller error (an apply without a
 * `materializeDdl` implementation).
 */
export const D1_SCHEMA_OBJECT_QUERY =
  "select type, name from sqlite_master where type in ('table', 'index') order by type, name";

/** The expected D1 objects for one database, derived from the M5.1 schema. */
export interface D1SchemaObjects {
  tables: string[];
  indexes: string[];
  objects: string[];
}

/** Derives the expected table and index names for one database, deterministically. */
export function d1SchemaObjects(database: D1Database, schema: D1Schema = d1Schema): D1SchemaObjects {
  const tables = schema.tables
    .filter((table) => table.database === database)
    .map((table) => table.name)
    .sort((left, right) => left.localeCompare(right));
  const indexes: string[] = [];
  for (const table of schema.tables) {
    if (table.database !== database) continue;
    for (const index of table.indexes) indexes.push(index.name);
  }
  indexes.sort((left, right) => left.localeCompare(right));
  return { tables, indexes, objects: [...tables, ...indexes] };
}

export interface BuildD1SchemaApplyManifestOptions {
  /** The Wrangler invocation boundary. Tests pass a fake runner. */
  runner: WranglerD1Runner;
  /** Write DDL to the remote databases only when this is explicitly true. */
  apply?: boolean;
  /** Optional subset of targets, in canonical order. */
  databases?: readonly D1Database[];
  /** The D1 schema to apply. Defaults to the live M5.1 schema. */
  schema?: D1Schema;
  /**
   * Persists the emitted DDL for one database and returns the path passed to
   * `wrangler d1 execute --file`. Required in apply mode.
   */
  materializeDdl?: (database: D1Database, sql: string) => string;
}

function message(error: unknown): string {
  if (error instanceof D1RemoteError || error instanceof Error) return error.message;
  return String(error);
}

function emptyTarget(target: D1RemoteTarget, objects: D1SchemaObjects): D1RemoteSchemaManifestTarget {
  return {
    name: target.name,
    binding: target.binding,
    state: "unknown",
    action: "refused",
    databaseId: null,
    reportedTables: null,
    expectedTables: objects.tables.length,
    expectedIndexes: objects.indexes.length,
    expectedObjects: objects.objects.length,
    foundObjects: 0,
    missingObjects: [...objects.objects],
    verified: false,
    errors: [],
  };
}

export async function buildD1SchemaApplyManifest(
  options: BuildD1SchemaApplyManifestOptions,
): Promise<D1RemoteSchemaManifest> {
  const apply = options.apply === true;
  const schema = options.schema ?? d1Schema;
  if (apply && typeof options.materializeDdl !== "function") {
    throw new Error("materializeDdl is required to apply the D1 schema");
  }
  const targets = selectD1RemoteTargets(options.databases);
  const commands: string[] = [];
  const errors: string[] = [];
  const results = new Map<string, D1RemoteSchemaManifestTarget>();
  for (const target of targets) {
    results.set(target.name, emptyTarget(target, d1SchemaObjects(target.name, schema)));
  }

  async function runWrangler(args: string[]): Promise<string> {
    commands.push(args.join(" "));
    return options.runner(args);
  }

  function get(name: D1Database): D1RemoteSchemaManifestTarget {
    return results.get(name) as D1RemoteSchemaManifestTarget;
  }

  function finalize(): D1RemoteSchemaManifest {
    const all = targets.map((target) => get(target.name));
    return {
      version: D1_REMOTE_SCHEMA_APPLY_VERSION,
      stage: "d1-remote-schema-apply",
      dryRun: !apply,
      applied: apply,
      targets: all,
      totals: {
        targets: all.length,
        applied: all.filter((target) => target.state === "applied").length,
        present: all.filter((target) => target.verified).length,
        missing: all.filter((target) => target.state === "missing").length,
        refused: all.filter((target) => target.action === "refused").length,
      },
      commands: [...commands],
      ok: errors.length === 0,
      errors: [...errors],
    };
  }

  let classifications: ReturnType<typeof classifyD1RemoteTargets>;
  try {
    const entries = parseD1RemoteListJson(await runWrangler(["d1", "list", "--json"]));
    classifications = classifyD1RemoteTargets(entries, targets);
  } catch (error) {
    errors.push(`preflight: ${message(error)}`);
    return finalize();
  }

  const ready: D1RemoteTarget[] = [];
  for (const classified of classifications) {
    const result = get(classified.target.name);
    if (classified.state === "ambiguous") {
      result.state = "ambiguous";
      result.action = "refused";
      result.databaseId = classified.entry?.uuid ?? null;
      result.errors.push(`ambiguous: ${classified.matches} databases share the name`);
      errors.push(`ambiguous target ${classified.target.name} (${classified.matches} matches)`);
    } else if (classified.state === "missing") {
      result.state = "missing";
      result.action = "refused";
      result.errors.push("remote database does not exist; run pnpm d1:provision --apply first");
      errors.push(`schema target ${classified.target.name} is missing`);
    } else {
      result.databaseId = classified.entry?.uuid ?? null;
      ready.push(classified.target);
    }
  }
  if (errors.length > 0) return finalize();

  let aborted = false;
  for (const target of ready) {
    const result = get(target.name);
    const objects = d1SchemaObjects(target.name, schema);
    result.state = "existing";
    result.action = "apply";
    if (aborted) {
      result.action = "refused";
      result.errors.push("not attempted: schema apply aborted after an earlier failure");
      continue;
    }
    try {
      const info = parseD1RemoteInfoJson(await runWrangler(["d1", "info", target.name, "--json"]));
      if (result.databaseId !== null && info.uuid !== result.databaseId) {
        throw new D1RemoteError("d1_remote.verification_mismatch", "d1 info did not match the listed database");
      }
      result.databaseId = info.uuid;
      result.reportedTables = info.numTables;
    } catch (error) {
      result.state = "unknown";
      result.action = "refused";
      result.errors.push(message(error));
      errors.push(`info ${target.name}: ${message(error)}`);
      aborted = true;
      continue;
    }
    if (apply) {
      let path: string;
      try {
        path = (options.materializeDdl as (database: D1Database, sql: string) => string)(
          target.name,
          emitDatabaseDdl(target.name, schema),
        );
      } catch (error) {
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`materialize ${target.name}: ${message(error)}`);
        aborted = true;
        continue;
      }
      try {
        parseD1ExecuteResultsJson(
          await runWrangler(["d1", "execute", target.name, "--remote", "--yes", "--json", "--file", path]),
        );
        result.state = "applied";
        result.action = "apply";
      } catch (error) {
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`execute ${target.name}: ${message(error)}`);
        aborted = true;
        continue;
      }
    }
    try {
      const rows = parseD1ExecuteResultsJson(
        await runWrangler([
          "d1",
          "execute",
          target.name,
          "--remote",
          "--yes",
          "--json",
          "--command",
          D1_SCHEMA_OBJECT_QUERY,
        ]),
      );
      const present = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
      const missing = objects.objects.filter((object) => !present.has(object));
      result.foundObjects = objects.objects.length - missing.length;
      result.missingObjects = missing;
      result.verified = missing.length === 0;
      if (result.verified && !apply) result.action = "none";
      if (!result.verified && apply) errors.push(`verify ${target.name}: ${missing.length} schema objects missing`);
    } catch (error) {
      result.verified = false;
      result.errors.push(message(error));
      errors.push(`verify ${target.name}: ${message(error)}`);
      if (!apply) {
        result.state = "unknown";
        result.action = "refused";
      }
    }
  }

  return finalize();
}
