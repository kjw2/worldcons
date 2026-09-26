import { classifyD1RemoteTargets, parseD1RemoteListJson } from "@/lib/cloudflare/d1/remote/classify";
import { selectD1RemoteTargets } from "@/lib/cloudflare/d1/remote/targets";
import type { WranglerD1Runner } from "@/lib/cloudflare/d1/remote/types";
import { materializeError } from "./errors";
import { SEARCH_MATERIALIZE_D1_DATABASE } from "./types";

/**
 * Cloudflare preflight helpers for the M7.5 operator.
 *
 * They resolve the exact D1 `worldcons_search` database and, when the repository
 * `wrangler.jsonc` records an expected id, require the live id to match it. No
 * value is ever printed; credentials are resolved by the operator CLI.
 */

export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
export const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

function stripJsonComments(content: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Extracts the `worldcons_search` D1 database id recorded in the repository
 * `wrangler.jsonc` (a JSONC file). Returns null when it is absent. It never
 * performs I/O; the caller reads the file.
 */
export function parseWranglerSearchDatabaseId(content: string): string | null {
  const tryParse = (text: string): string | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      const entries = (parsed as { d1_databases?: unknown }).d1_databases;
      if (!Array.isArray(entries)) return null;
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as { database_name?: unknown; database_id?: unknown };
        if (record.database_name === SEARCH_MATERIALIZE_D1_DATABASE && typeof record.database_id === "string") {
          return record.database_id;
        }
      }
      return null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(content);
  if (direct !== null) return direct;
  const stripped = tryParse(stripJsonComments(content));
  if (stripped !== null) return stripped;
  const match = /"database_name"\s*:\s*"worldcons_search"[\s\S]{0,400}?"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(
    content,
  );
  return match === null ? null : match[1];
}

export interface ResolvedSearchD1Target {
  name: typeof SEARCH_MATERIALIZE_D1_DATABASE;
  uuid: string;
}

/**
 * Resolves the live `worldcons_search` D1 database from exactly one `d1 list`
 * entry. An absent or ambiguous name fails closed; when an expected id is
 * supplied (from `wrangler.jsonc`) a mismatch fails closed.
 */
export async function resolveSearchD1Target(options: {
  runner: WranglerD1Runner;
  expectedUuid?: string | null;
}): Promise<ResolvedSearchD1Target> {
  const entries = parseD1RemoteListJson(await options.runner(["d1", "list", "--json"]));
  const [classification] = classifyD1RemoteTargets(entries, selectD1RemoteTargets([SEARCH_MATERIALIZE_D1_DATABASE]));
  if (classification === undefined || classification.state !== "existing" || classification.entry === null) {
    throw materializeError(
      "cloudflare_preflight_failed",
      `d1 list did not resolve ${SEARCH_MATERIALIZE_D1_DATABASE} to exactly one existing database`,
    );
  }
  const uuid = classification.entry.uuid;
  if (options.expectedUuid !== undefined && options.expectedUuid !== null && options.expectedUuid !== uuid) {
    throw materializeError(
      "cloudflare_preflight_failed",
      "live worldcons_search id does not match the repository wrangler.jsonc id",
    );
  }
  return { name: SEARCH_MATERIALIZE_D1_DATABASE, uuid };
}

export function requireAccountId(value: string | undefined, fallback: string): string {
  const resolved = (value ?? "").trim().length > 0 ? (value as string).trim() : fallback;
  if (!ACCOUNT_ID_PATTERN.test(resolved)) {
    throw materializeError("cloudflare_preflight_failed", "resolved account id is not a 32-character hex id");
  }
  return resolved;
}

export function requireApiToken(value: string | undefined, fallback: string): string {
  const resolved = (value ?? "").trim().length > 0 ? (value as string).trim() : fallback.trim();
  if (resolved.length === 0) {
    throw materializeError("cloudflare_preflight_failed", "cloudflare api token is empty");
  }
  return resolved;
}
