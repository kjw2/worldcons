import { spawn } from "node:child_process";
import process from "node:process";
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
 *   -o json <sql>` via `spawn` with `shell:false` (on Windows the command is
 *   routed through `cmd.exe /d /c` so cmd.exe resolves the shim via `PATH` and
 *   `PATHEXT`), so it is never assembled into a shell string;
 * - the child is killed when it exceeds `timeoutMs`, and both stdout and stderr
 *   are bounded, so a runaway query cannot exhaust memory;
 * - the CLI stdout may carry preamble/footer text around exactly one JSON
 *   envelope; parsing requires that one envelope with a `rows` array and fails
 *   closed on malformed or ambiguous output;
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
 * The platform-appropriate Supabase CLI binary name. On Windows the bare
 * `supabase` command is used rather than a hard-coded `.cmd` shim: the binary is
 * launched through `cmd.exe /d /c`, and cmd.exe resolves the command name via
 * `PATH` and `PATHEXT`, so it finds whichever shim the machine actually has
 * (`supabase.exe` from scoop, or an npm `supabase.cmd`). A hard-coded extension
 * only works for one install method.
 */
export function defaultSupabaseBinary(): string {
  return "supabase";
}

/** The concrete child-process command plus argument vector to spawn. */
export interface SupabaseLinkedInvocation {
  command: string;
  args: string[];
}

function windowsCommandInterpreter(env: Record<string, string | undefined>): string {
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim();
  return comspec !== undefined && comspec.length > 0 ? comspec : "cmd.exe";
}

/**
 * Builds the platform-appropriate child-process invocation. On Windows a
 * `.cmd`/`.bat` shim cannot be spawned directly with `shell:false`, so the
 * invocation is routed through `cmd.exe /d /c <binary> <args...>` (binary and
 * args stay distinct argv entries); cmd.exe resolves `<binary>` via `PATH` and
 * `PATHEXT`, so the bare `supabase` command finds the installed `.exe`/`.cmd`.
 * Everywhere else the binary is spawned directly.
 */
export function buildSupabaseLinkedInvocation(options: {
  args: readonly string[];
  binary: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  comspec?: string;
}): SupabaseLinkedInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: options.binary, args: [...options.args] };
  const interpreter = options.comspec?.trim() || windowsCommandInterpreter(options.env ?? process.env);
  return { command: interpreter, args: ["/d", "/c", options.binary, ...options.args] };
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
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
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
        stdout += chunk.toString("utf8");
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
          resolve(stdout);
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
 * around exactly one JSON envelope. It scans for balanced JSON values, counts the
 * object ones as envelopes, and fails closed on malformed or ambiguous output:
 * zero or more than one envelope, a missing/non-array `rows`, or a non-object
 * row all reject. Values are returned exactly as decoded.
 */
export function parseSupabaseLinkedRows(stdout: string): Record<string, unknown>[] {
  const envelopes: Record<string, unknown>[] = [];
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
    if (isPlainObject(parsed)) envelopes.push(parsed);
    index = end + 1;
  }
  if (envelopes.length === 0) throw new Error("supabase db query -o json did not return a JSON envelope");
  if (envelopes.length > 1) throw new Error("supabase db query -o json returned multiple JSON envelopes");
  const rows = envelopes[0].rows;
  if (!Array.isArray(rows)) throw new Error("supabase db query -o json envelope is missing a rows array");
  return rows.map((row) => {
    if (!isPlainObject(row)) throw new Error("supabase db query -o json envelope contained a non-object row");
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
 * runner, parses the single JSON envelope and projects the requested columns,
 * preserving every value's type exactly.
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
