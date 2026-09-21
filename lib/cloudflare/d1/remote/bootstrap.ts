import type { D1Database } from "../types";
import {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
} from "./classify";
import type { D1TargetClassification } from "./classify";
import { selectD1RemoteTargets, type D1RemoteTarget } from "./targets";
import {
  D1_REMOTE_BOOTSTRAP_VERSION,
  D1_REMOTE_DEFAULT_LOCATION,
  type D1RemoteManifest,
  type D1RemoteManifestTarget,
  type D1RemoteTargetState,
  type WranglerD1Runner,
} from "./types";

const LOCATION_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface BuildD1RemoteManifestOptions {
  /** The Wrangler invocation boundary. Tests pass a fake runner. */
  runner: WranglerD1Runner;
  /** Create the missing databases only when this is explicitly true. */
  apply?: boolean;
  /** Jurisdiction passed to `d1 create --location`; defaults to `apac`. */
  location?: string;
  /** Optional subset of targets, in canonical order. */
  databases?: readonly D1Database[];
}

function message(error: unknown): string {
  if (error instanceof D1RemoteError || error instanceof Error) return error.message;
  return String(error);
}

function emptyTarget(target: D1RemoteTarget, location: string): D1RemoteManifestTarget {
  return {
    name: target.name,
    binding: target.binding,
    location,
    state: "unknown",
    action: "refused",
    databaseId: null,
    createdAt: null,
    verified: false,
    errors: [],
  };
}

/**
 * Preflights the four remote D1 targets and, only with `apply`, creates the
 * missing ones one at a time, then re-lists and runs `d1 info` to prove each
 * create before recording it.
 *
 * The function never throws for a remote failure: it returns a manifest with
 * `ok: false` and per-target errors so the operator CLI can still print and
 * persist a machine-readable record. It throws only for an invalid `--location`
 * argument. It never deletes a database, deploys, imports schema/data, or
 * changes production authority.
 */
export async function buildD1RemoteManifest(
  options: BuildD1RemoteManifestOptions,
): Promise<D1RemoteManifest> {
  const apply = options.apply === true;
  const location = (options.location ?? D1_REMOTE_DEFAULT_LOCATION).trim();
  if (!LOCATION_PATTERN.test(location)) {
    throw new Error(`invalid location: ${options.location ?? ""}`);
  }
  const targets = selectD1RemoteTargets(options.databases);
  const commands: string[] = [];
  const errors: string[] = [];
  const results = new Map<string, D1RemoteManifestTarget>();
  for (const target of targets) results.set(target.name, emptyTarget(target, location));

  async function runWrangler(args: string[]): Promise<string> {
    commands.push(args.join(" "));
    return options.runner(args);
  }

  function finalize(): D1RemoteManifest {
    const all = targets.map((target) => results.get(target.name) as D1RemoteManifestTarget);
    const count = (predicate: (target: D1RemoteManifestTarget) => boolean) => all.filter(predicate).length;
    const countState = (state: D1RemoteTargetState) => count((target) => target.state === state);
    return {
      version: D1_REMOTE_BOOTSTRAP_VERSION,
      stage: "d1-remote-bootstrap",
      dryRun: !apply,
      applied: apply,
      location,
      targets: all,
      totals: {
        targets: all.length,
        existing: countState("existing"),
        created: countState("created"),
        missing: countState("missing"),
        refused: count((target) => target.action === "refused"),
      },
      commands: [...commands],
      ok: errors.length === 0,
      errors: [...errors],
    };
  }

  let classifications: D1TargetClassification[];
  try {
    const entries = parseD1RemoteListJson(await runWrangler(["d1", "list", "--json"]));
    classifications = classifyD1RemoteTargets(entries, targets);
  } catch (error) {
    errors.push(`preflight: ${message(error)}`);
    return finalize();
  }

  for (const classification of classifications) {
    const result = results.get(classification.target.name) as D1RemoteManifestTarget;
    if (classification.state === "existing" && classification.entry !== null) {
      result.state = "existing";
      result.action = "none";
      result.databaseId = classification.entry.uuid;
      result.createdAt = classification.entry.createdAt;
      result.verified = true;
    } else if (classification.state === "ambiguous") {
      result.state = "ambiguous";
      result.action = "refused";
      result.databaseId = classification.entry?.uuid ?? null;
      result.errors.push(`ambiguous: ${classification.matches} databases share the name`);
      errors.push(`ambiguous target ${classification.target.name} (${classification.matches} matches)`);
    } else {
      result.state = "missing";
      result.action = "create";
    }
  }

  if (errors.length > 0) return finalize();

  const missing = classifications
    .filter((classification) => classification.state === "missing")
    .map((classification) => classification.target);

  if (apply && missing.length > 0) {
    let aborted = false;
    for (const target of missing) {
      const result = results.get(target.name) as D1RemoteManifestTarget;
      if (aborted) {
        result.action = "refused";
        result.errors.push("not attempted: create run aborted after an earlier failure");
        continue;
      }
      try {
        await runWrangler(["d1", "create", target.name, "--location", location]);
        result.state = "created";
        result.action = "create";
      } catch (error) {
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`create ${target.name}: ${message(error)}`);
        aborted = true;
      }
    }

    const created = missing.filter((target) => results.get(target.name)?.state === "created");
    if (created.length > 0) {
      try {
        const listed = parseD1RemoteListJson(await runWrangler(["d1", "list", "--json"]));
        for (const target of created) {
          const result = results.get(target.name) as D1RemoteManifestTarget;
          const matches = listed.filter((entry) => entry.name === target.name);
          if (matches.length !== 1) {
            result.verified = false;
            result.errors.push(`post-create list matched ${matches.length} databases`);
            errors.push(`verify ${target.name}: post-create list matched ${matches.length} databases`);
            continue;
          }
          result.databaseId = matches[0].uuid;
          result.createdAt = matches[0].createdAt;
          try {
            const info = parseD1RemoteInfoJson(await runWrangler(["d1", "info", target.name, "--json"]));
            if (info.name !== target.name || info.uuid !== matches[0].uuid) {
              throw new D1RemoteError("d1_remote.verification_mismatch", "d1 info did not match the listed database");
            }
            result.createdAt = info.createdAt ?? result.createdAt;
            result.verified = true;
          } catch (error) {
            result.verified = false;
            result.errors.push(message(error));
            errors.push(`verify ${target.name}: ${message(error)}`);
          }
        }
      } catch (error) {
        errors.push(`verify: ${message(error)}`);
        for (const target of created) {
          const result = results.get(target.name) as D1RemoteManifestTarget;
          result.verified = false;
          result.errors.push(message(error));
        }
      }
    }
  }

  return finalize();
}
