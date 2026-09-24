import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { assertPostgresIdentifier } from "./select";
import type { PostgresReadRequest, PostgresRowSource } from "./types";

/**
 * Supabase linked read source (operator use only).
 *
 * Deliberately not re-exported from the convert barrel: it imports
 * `node:child_process`, and runtime Workers code must never load it. Only the
 * operator CLI imports this module directly.
 *
 * Safety:
 *
 * - the SELECT is authored here from the hand-authored schema: every relation,
 *   column and ordering identifier is guarded and double-quoted, and `LIMIT`/
 *   `OFFSET` are inlined only after a safe-non-negative-integer check, so no
 *   unguarded text can reach the SQL;
 * - the SQL is passed as a single `argv` entry to `supabase db query --linked
 *   -o json <sql>` via `spawn` with `shell:false`. On Windows the launcher
 *   resolves the bare `supabase` command against `PATH` itself and spawns a
 *   native `supabase.exe` directly; only when nothing but a `.cmd`/`.bat` shim
 *   is available does it fall back to `cmd.exe /d /s /c`, and even then the SQL
 *   is carried in one safely-quoted, verbatim argv entry that `cmd.exe` must not
 *   re-parse;
 * - the child is killed when it exceeds `timeoutMs`, and both stdout and stderr
 *   are bounded, so a runaway query cannot exhaust memory;
 * - the CLI stdout may carry preamble/footer text around exactly one top-level
 *   JSON payload: either an object envelope with a `rows` array (legacy) or a
 *   bare array of row objects (Supabase CLI 2.107.0). Parsing requires that one
 *   payload and fails closed on malformed or ambiguous output;
 * - row values are JSON-decoded but otherwise preserved exactly (bigint decimals
 *   stay strings, jsonb stays objects, arrays stay arrays, booleans stay
 *   booleans), so no scalar is coerced here.
 */
export const SUPABASE_LINKED_TIMEOUT_MS = 60_000;
export const SUPABASE_LINKED_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const SUPABASE_LINKED_MAX_STDERR_BYTES = 64 * 1024;

/**
 * The query boundary. A runner receives the SQL text and resolves with the raw
 * CLI stdout; a non-zero exit, a timeout or an over-bound stream must reject.
 * Tests supply a fake runner; the operator supplies the child-process adapter.
 */
export interface SupabaseLinkedQueryRunner {
  (sql: string): Promise<string>;
}

/** The `supabase db query` argument vector for one SQL statement. */
export function supabaseLinkedQueryArgs(sql: string): string[] {
  return ["db", "query", "--linked", "-o", "json", sql];
}

/**
 * The platform-appropriate Supabase CLI binary name. The bare `supabase` command
 * is used everywhere: on Windows the launcher resolves it against `PATH` itself
 * (preferring a native `supabase.exe`) instead of assuming a specific install
 * location or a hard-coded `.cmd` extension.
 */
export function defaultSupabaseBinary(): string {
  return "supabase";
}

/** The concrete child-process command plus argument vector to spawn. */
export interface SupabaseLinkedInvocation {
  command: string;
  args: string[];
  /**
   * Windows only: when true, `args` is already a verbatim command line and must
   * be handed to `spawn` unchanged, so `cmd.exe` never re-parses the SQL.
   */
  windowsVerbatimArguments?: boolean;
}

/** A test/embedding seam that resolves a bare Windows binary name to a path. */
export type ResolveSupabaseBinary = (binary: string) => string | null;

function windowsCommandInterpreter(env: Record<string, string | undefined>): string {
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim();
  return comspec !== undefined && comspec.length > 0 ? comspec : "cmd.exe";
}

/** True when a Windows command already names a concrete target (path or extension). */
function hasExplicitWindowsTarget(binary: string): boolean {
  return binary.includes("\\") || binary.includes("/") || /\.[A-Za-z0-9]+$/.test(binary);
}

function windowsPathEntries(env: Record<string, string | undefined>): string[] {
  const raw = env.Path ?? env.PATH ?? env.path;
  if (raw === undefined) return [];
  return raw
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** Native extensions first, so a real `.exe` always wins over a script shim. */
function windowsExtensionPriority(env: Record<string, string | undefined>): string[] {
  const pathExt = env.PATHEXT ?? env.PathExt ?? ".COM;.EXE;.BAT;.CMD";
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const extension of [".exe", ".com", ...pathExt.split(";"), ".cmd", ".bat"]) {
    const normalized = extension.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Resolves a bare Windows binary name against `PATH`/`PATHEXT`, searching only
 * the directories actually on `PATH` (no hard-coded install locations) and
 * preferring a directly spawnable native executable (`.exe`/`.com`) over a
 * `.cmd`/`.bat` shim. Returns null when nothing matches, so the caller can fall
 * back to letting `cmd.exe` resolve the name at spawn time.
 */
export function resolveWindowsSupabaseBinary(
  binary: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (hasExplicitWindowsTarget(binary)) return binary;
  const directories = windowsPathEntries(env);
  for (const extension of windowsExtensionPriority(env)) {
    for (const directory of directories) {
      const candidate = path.join(directory, binary + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function isWindowsScript(binary: string): boolean {
  return /\.(cmd|bat)$/i.test(binary);
}

/**
 * Quotes one argument for a `cmd.exe /c` command line. Embedded double quotes are
 * backslash-escaped and a run of trailing backslashes is doubled so it cannot
 * escape the closing quote: this is exactly the argv encoding
 * `CommandLineToArgvW` expects, so the shim's child process recovers the argument
 * byte-for-byte (quoted SQL included).
 */
function quoteWindowsCommandArgument(argument: string): string {
  const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Builds the single `/c` command string. The whole string is wrapped in an extra
 * pair of quotes so `cmd.exe /s` strips only those, leaving every quoted argument
 * intact. It is passed as one verbatim argv entry so Node never re-quotes it.
 *
 * A bare command name is left unquoted so `cmd.exe` still resolves it through
 * `PATH` and a resolved `.cmd`/`.bat` keeps a correct `%~dp0`; a path-bearing
 * command is quoted so spaces survive.
 */
function buildWindowsCommandString(command: string, args: readonly string[]): string {
  const commandToken = /[\\/\s]/.test(command) ? quoteWindowsCommandArgument(command) : command;
  const parts = [commandToken, ...args.map(quoteWindowsCommandArgument)];
  return `"${parts.join(" ")}"`;
}

/**
 * Builds the platform-appropriate child-process invocation. On Windows the bare
 * (or explicitly named) binary is resolved against `PATH`: a native `.exe`/`.com`
 * is spawned directly, keeping the SQL as one argv entry with no shell in the
 * middle. A `.cmd`/`.bat` shim, or a name that cannot be resolved, is routed
 * through `cmd.exe /d /s /c` with a safely-quoted, verbatim command string.
 * Everywhere else the binary is spawned directly.
 */
export function buildSupabaseLinkedInvocation(options: {
  args: readonly string[];
  binary: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  comspec?: string;
  resolveBinary?: ResolveSupabaseBinary;
}): SupabaseLinkedInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: options.binary, args: [...options.args] };
  const env = options.env ?? process.env;
  const resolve = options.resolveBinary ?? ((binaryName: string) => resolveWindowsSupabaseBinary(binaryName, env));
  const resolved = resolve(options.binary);
  if (resolved !== null && !isWindowsScript(resolved)) {
    return { command: resolved, args: [...options.args] };
  }
  const target = resolved ?? options.binary;
  const interpreter = options.comspec?.trim() || windowsCommandInterpreter(env);
  return {
    command: interpreter,
    args: ["/d", "/s", "/c", buildWindowsCommandString(target, options.args)],
    windowsVerbatimArguments: true,
  };
}

export interface SupabaseLinkedQueryRunnerOptions {
  /** Supabase executable. Defaults to the platform-appropriate binary. */
  binary?: string;
  /** Arguments inserted before the query args (for example `["exec", "supabase"]`). */
  prefixArgs?: readonly string[];
  /** Child working directory. Defaults to the current directory. */
  cwd?: string;
  /** Child environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many milliseconds. Defaults to 60s. */
  timeoutMs?: number;
  /** Maximum accepted stdout bytes. Defaults to 8 MiB. */
  maxStdoutBytes?: number;
  /** Maximum accepted stderr bytes. Defaults to 64 KiB. */
  maxStderrBytes?: number;
  /** Target platform. Defaults to `process.platform`; overridable for tests. */
  platform?: NodeJS.Platform;
  /** Windows command interpreter override. Defaults to `ComSpec` then `cmd.exe`. */
  comspec?: string;
  /** Windows resolution seam. Defaults to a `PATH`/`PATHEXT` search. */
  resolveBinary?: ResolveSupabaseBinary;
}

/**
 * The operator-only child-process adapter. It runs `supabase db query --linked
 * -o json <sql>` and resolves with stdout. A non-zero exit rejects with a bounded
 * message that never includes raw CLI output; a timeout or an over-bound stream
 * kills the child and rejects.
 */
export function createSupabaseLinkedQueryRunner(
  options: SupabaseLinkedQueryRunnerOptions = {},
): SupabaseLinkedQueryRunner {
  const platform = options.platform ?? process.platform;
  const binary = options.binary ?? defaultSupabaseBinary();
  const prefix = options.prefixArgs ?? [];
  const timeoutMs = options.timeoutMs ?? SUPABASE_LINKED_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? SUPABASE_LINKED_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? SUPABASE_LINKED_MAX_STDERR_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(maxStdoutBytes) || maxStdoutBytes <= 0) {
    throw new Error("maxStdoutBytes must be a positive integer");
  }
  if (!Number.isInteger(maxStderrBytes) || maxStderrBytes <= 0) {
    throw new Error("maxStderrBytes must be a positive integer");
  }

  return (sql) =>
    new Promise<string>((resolve, reject) => {
      const invocation = buildSupabaseLinkedInvocation({
        args: [...prefix, ...supabaseLinkedQueryArgs(sql)],
        binary,
        platform,
        env: options.env,
        comspec: options.comspec,
        resolveBinary: options.resolveBinary,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      // One decoder per child stdout: a multibyte code point may be split across
      // chunk boundaries, so per-chunk `toString("utf8")` would corrupt it. The
      // decoder buffers the trailing partial sequence until the next chunk.
      const decoder = new StringDecoder("utf8");
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const abort = (message: string): void => {
        finish(() => {
          child.kill();
          reject(new Error(message));
        });
      };
      const timer = setTimeout(() => abort(`supabase db query timed out after ${timeoutMs}ms`), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          abort(`supabase db query output exceeded ${maxStdoutBytes} bytes`);
          return;
        }
        stdout += decoder.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // Drained but never recorded: only the byte count is kept, so raw CLI
        // output cannot reach a log or an error message.
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) {
          abort(`supabase db query wrote more than ${maxStderrBytes} bytes to stderr`);
        }
      });
      child.on("error", (error) => {
        abort(`failed to run supabase: ${error.message}`);
      });
      child.on("close", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(`supabase db query failed with exit code ${code ?? "unknown"}`));
            return;
          }
          // Flush the decoder's final partial sequence exactly once on success;
          // a failed/aborted run discards the output, so `end()` is never applied.
          resolve(stdout + decoder.end());
        });
      });
    });
}

/** Double-quotes a guarded Postgres identifier. */
function quotePostgresIdentifier(name: string): string {
  return `"${assertPostgresIdentifier(name)}"`;
}

/** Guards an inlined bound as a non-negative safe integer. */
function assertPostgresInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid postgres ${name}: ${String(value)}`);
  return value;
}

/**
 * Builds the bounded, deterministic Postgres projection for one read request:
 * quoted authored columns, primary-key ordering, inlined integer `LIMIT`/
 * `OFFSET`. The result is stable for identical input, so the same request always
 * issues the same SQL.
 */
export function buildPostgresSelectSql(request: PostgresReadRequest): string {
  if (request.columns.length === 0) throw new Error(`no projectable columns for ${request.relation}`);
  const relation = quotePostgresIdentifier(request.relation);
  const columns = request.columns.map(quotePostgresIdentifier).join(", ");
  let sql = `select ${columns} from ${relation}`;
  if (request.orderBy.length > 0) sql += ` order by ${request.orderBy.map(quotePostgresIdentifier).join(", ")}`;
  const offset = assertPostgresInteger(request.offset, "offset");
  if (request.limit !== null) sql += ` limit ${assertPostgresInteger(request.limit, "limit")}`;
  if (offset > 0) sql += ` offset ${offset}`;
  return sql;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finds the matching close bracket for the JSON value starting at `start`,
 * tracking string literals and escapes so a bracket inside a string is ignored.
 * Only the starting bracket type is counted, which is sufficient for valid JSON.
 * Returns null when the value is not closed.
 */
function balancedEnd(text: string, start: number): number | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

/**
 * Parses `supabase db query -o json` stdout that may carry preamble/footer text
 * around exactly one top-level JSON payload. The CLI emits either an object
 * envelope with a `rows` array or, as of CLI 2.107.0, a bare top-level array of
 * row objects. It scans for balanced JSON values, collects the object and array
 * payloads, and fails closed on malformed or ambiguous output: zero or more than
 * one payload, an envelope without an array `rows`, or a non-object row all
 * reject. Values are returned exactly as decoded.
 */
export function parseSupabaseLinkedRows(stdout: string): Record<string, unknown>[] {
  const payloads: unknown[] = [];
  let index = 0;
  while (index < stdout.length) {
    const char = stdout[index];
    if (char !== "{" && char !== "[") {
      index += 1;
      continue;
    }
    const end = balancedEnd(stdout, index);
    if (end === null) {
      index += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.slice(index, end + 1));
    } catch {
      index += 1;
      continue;
    }
    payloads.push(parsed);
    index = end + 1;
  }
  if (payloads.length === 0) throw new Error("supabase db query -o json did not return a JSON payload");
  if (payloads.length > 1) throw new Error("supabase db query -o json returned multiple JSON payloads");
  const payload = payloads[0];
  let rows: unknown[];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (isPlainObject(payload)) {
    if (!Array.isArray(payload.rows)) {
      throw new Error("supabase db query -o json envelope is missing a rows array");
    }
    rows = payload.rows;
  } else {
    throw new Error("supabase db query -o json did not return a JSON payload");
  }
  return rows.map((row) => {
    if (!isPlainObject(row)) throw new Error("supabase db query -o json payload contained a non-object row");
    return row;
  });
}

function pickColumns(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) picked[column] = row[column];
  }
  return picked;
}

export interface SupabaseLinkedRowSourceOptions extends SupabaseLinkedQueryRunnerOptions {
  /** The query boundary. Defaults to the child-process adapter. */
  runner?: SupabaseLinkedQueryRunner;
}

/**
 * Read-only `PostgresRowSource` backed by the linked Supabase CLI. It builds the
 * deterministic SELECT, runs it through the injected (or default child-process)
 * runner, parses the single JSON payload (object envelope or bare row array) and
 * projects the requested columns, preserving every value's type exactly.
 */
export function createSupabaseLinkedRowSource(options: SupabaseLinkedRowSourceOptions = {}): PostgresRowSource {
  const query = options.runner ?? createSupabaseLinkedQueryRunner(options);
  let closed = false;
  return {
    isConfigured: () => true,
    async readRows(request: PostgresReadRequest) {
      if (closed) throw new Error("supabase linked row source is closed");
      const rows = parseSupabaseLinkedRows(await query(buildPostgresSelectSql(request)));
      return rows.map((row) => pickColumns(row, request.columns));
    },
    async close() {
      closed = true;
    },
  };
}
