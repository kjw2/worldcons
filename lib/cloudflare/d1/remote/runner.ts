import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { WranglerD1Runner } from "./types";

/**
 * Operator-only Wrangler child-process adapter for the M5.2c PART 1 remote D1
 * bootstrap.
 *
 * Deliberately NOT re-exported from the remote barrel: it imports
 * `node:child_process`, and runtime Workers code must never load it. Only the
 * operator CLI imports this module directly.
 *
 * Safety:
 *
 * - the Wrangler argument vector is authored by the caller and never built from
 *   untrusted input (the CLI validates `--database` against the canonical set and
 *   `--location` against a fixed pattern before it reaches this module);
 * - a non-zero exit rejects with a bounded message that names the subcommand and
 *   the exit code only, so raw Wrangler output (which can contain account
 *   details) never reaches a log or the persisted manifest;
 * - the child is killed when it exceeds `timeoutMs`;
 * - on Windows the default runner does NOT use the `.cmd` shim or `cmd.exe` at
 *   all: it spawns `process.execPath` (Node) directly with the absolute local
 *   `node_modules/wrangler/bin/wrangler.js` entrypoint as the first argument and
 *   every D1 argument unchanged as its own argv entry. Running through the
 *   command interpreter re-parses the argv into a command line, which splits a
 *   spaceful `--command <SQL>` into multiple arguments and fails; spawning Node
 *   with the JS entrypoint keeps each SQL string as exactly one argv entry and
 *   never invokes `cmd.exe`. The default path fails closed if that local
 *   entrypoint is missing;
 * - an explicit custom `binary`/`prefixArgs` (used by callers and tests) keeps
 *   the `.cmd`/`.bat` handling: such a shim is launched through the command
 *   interpreter from `ComSpec` (`cmd.exe /d /c <binary> <args...>`), never by
 *   spawning the `.cmd` directly with `shell:false`, which Node >=18.20/20.12/22
 *   rejects with `EINVAL` after the CVE-2024-27980 fix.
 */
export const D1_WRANGLER_TIMEOUT_MS = 120_000;

export interface WranglerD1RunnerOptions {
  /** Wrangler executable. Defaults to the platform-appropriate local binary. */
  binary?: string;
  /** Arguments inserted before the D1 args (for example `["exec", "wrangler"]`). */
  prefixArgs?: readonly string[];
  /** Child working directory. Defaults to the current directory. */
  cwd?: string;
  /** Child environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many milliseconds. Defaults to 120s. */
  timeoutMs?: number;
  /** Target platform. Defaults to `process.platform`; overridable for tests. */
  platform?: NodeJS.Platform;
  /** Windows command interpreter override. Defaults to `ComSpec` then `cmd.exe`. */
  comspec?: string;
  /** Node executable override for the Windows default path. Defaults to `process.execPath`. */
  execPath?: string;
}

/** The platform-appropriate Wrangler binary name for a local install. */
export function defaultWranglerBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "wrangler.cmd" : "wrangler";
}

/** The local Wrangler JS entrypoint shipped by the `wrangler` package, relative to the project root. */
export const D1_WRANGLER_LOCAL_ENTRYPOINT = path.join("node_modules", "wrangler", "bin", "wrangler.js");

/**
 * Absolute path to the local Wrangler JS entrypoint under `cwd` (the project
 * root). Existence is checked by `buildDefaultWranglerInvocation`, so a missing
 * install fails closed instead of silently shelling out.
 */
export function resolveLocalWranglerEntrypoint(cwd: string = process.cwd()): string {
  return path.resolve(cwd, D1_WRANGLER_LOCAL_ENTRYPOINT);
}

/**
 * Absolute path to the local Wrangler JS entrypoint under `cwd`, failing closed
 * when it is missing. The default Windows runner spawns this entrypoint with
 * Node directly so a spaceful argument stays a single argv entry.
 */
export function resolveLocalWranglerJs(cwd: string = process.cwd()): string {
  const entrypoint = resolveLocalWranglerEntrypoint(cwd);
  if (!existsSync(entrypoint)) {
    throw new Error(`local wrangler entrypoint not found: ${entrypoint}`);
  }
  return entrypoint;
}

/**
 * Resolves the Windows command interpreter used to launch the `.cmd`/`.bat`
 * shim. `ComSpec` is authoritative when present; otherwise fall back to the
 * conventional `cmd.exe` on `PATH`.
 */
export function resolveWindowsCommandInterpreter(
  env: Record<string, string | undefined> = process.env,
): string {
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim();
  return comspec !== undefined && comspec.length > 0 ? comspec : "cmd.exe";
}

/** The concrete child-process command plus argument vector to spawn. */
export interface WranglerInvocation {
  command: string;
  args: string[];
}

/**
 * Builds the child-process invocation for an explicit custom Wrangler binary.
 *
 * On Windows a `.cmd`/`.bat` shim cannot be spawned directly with
 * `shell:false`, so the invocation is routed through `cmd.exe /d /c <binary>
 * <args...>` (the binary and args stay distinct argv entries; no shell string is
 * assembled from the arguments). Everywhere else the binary is spawned directly.
 *
 * This path is only used when the caller supplies an explicit `binary`
 * (`prefixArgs` count as a custom invocation too). The command interpreter
 * re-parses the argv into a command line, so a spaceful argument such as
 * `--command <SQL>` is only safe on the default path below.
 */
export function buildWranglerInvocation(options: {
  binary: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  comspec?: string;
}): WranglerInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: options.binary, args: [...options.args] };
  const interpreter = options.comspec?.trim() || resolveWindowsCommandInterpreter(options.env);
  return { command: interpreter, args: ["/d", "/c", options.binary, ...options.args] };
}

/**
 * Builds the platform-appropriate child-process invocation for the default
 * (local, unmodified) Wrangler install.
 *
 * On Windows the `.cmd` shim is bypassed entirely: Node (`process.execPath`) is
 * spawned directly with the absolute local `node_modules/wrangler/bin/wrangler.js`
 * entrypoint as the first argument, followed by every argument unchanged. Each
 * argument — including a spaceful `--command <SQL>` — therefore stays exactly one
 * argv entry and `cmd.exe` is never involved. A missing local entrypoint fails
 * closed. Everywhere else the `wrangler` binary is spawned directly.
 */
export function buildDefaultWranglerInvocation(options: {
  args: readonly string[];
  platform?: NodeJS.Platform;
  cwd?: string;
  execPath?: string;
}): WranglerInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: defaultWranglerBinary(platform), args: [...options.args] };
  const entrypoint = resolveLocalWranglerEntrypoint(options.cwd);
  if (!existsSync(entrypoint)) {
    throw new Error(`local wrangler entrypoint not found: ${entrypoint}`);
  }
  return { command: options.execPath ?? process.execPath, args: [entrypoint, ...options.args] };
}

function wranglerSubcommand(args: readonly string[]): string {
  const subcommand = args[0] === "d1" ? `d1 ${args[1] ?? ""}` : args.slice(0, 2).join(" ");
  const trimmed = subcommand.trim();
  return trimmed.length > 0 ? trimmed : "command";
}

/** Builds the Wrangler invocation boundary used by the remote D1 bootstrap CLI. */
export function createWranglerD1Runner(options: WranglerD1RunnerOptions = {}): WranglerD1Runner {
  const platform = options.platform ?? process.platform;
  const prefix = options.prefixArgs ?? [];
  const timeoutMs = options.timeoutMs ?? D1_WRANGLER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");

  // An explicit binary or prefix is a custom invocation and keeps the `.cmd`
  // interpreter handling; the untouched default goes through the local JS
  // entrypoint so a spaceful argument survives as a single argv entry.
  const custom = options.binary !== undefined || prefix.length > 0;

  return (args) =>
    new Promise<string>((resolve, reject) => {
      const invocation = custom
        ? buildWranglerInvocation({
            binary: options.binary ?? defaultWranglerBinary(platform),
            args: [...prefix, ...args],
            platform,
            env: options.env,
            comspec: options.comspec,
          })
        : buildDefaultWranglerInvocation({
            args,
            platform,
            cwd: options.cwd,
            execPath: options.execPath,
          });
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let settled = false;
      // One decoder per child stdout: a multibyte code point may be split across
      // chunk boundaries, so per-chunk `toString("utf8")` would corrupt it. The
      // decoder buffers a trailing partial sequence until the next chunk.
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`wrangler ${wranglerSubcommand(args)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += decoder.write(chunk);
      });
      child.stderr.on("data", () => {
        // Drained to avoid filling the pipe; deliberately never recorded.
      });
      child.on("error", (error) => {
        finish(() => reject(new Error(`failed to run wrangler: ${error.message}`)));
      });
      child.on("close", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(`wrangler ${wranglerSubcommand(args)} failed with exit code ${code ?? "unknown"}`));
            return;
          }
          // Flush the decoder's final partial sequence exactly once on success;
          // a failed/aborted run discards the output, so `end()` is never applied.
          resolve(stdout + decoder.end());
        });
      });
    });
}
