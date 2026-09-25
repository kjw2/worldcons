import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildD1ShadowParityReport,
  d1ShadowParityExitCode,
  parseD1ShadowNdjson,
  renderD1ShadowParityReportMarkdown,
  type D1ShadowParityReport,
  type D1ShadowParityThresholds,
} from "@/lib/cloudflare/d1/shadow/report";

/**
 * M6.5 shadow parity report CLI.
 *
 * Reads newline-delimited `worldcons.d1_shadow` JSON from a file path argument
 * and/or stdin, then writes a deterministic parity report to stdout or
 * `--output`. Local/read-only evidence tooling: no network, no deployment, no
 * Cloudflare/Supabase/D1 mutation, no authority switch and no `GO-D1-READ`
 * claim.
 *
 *   pnpm d1:shadow-report --input=shadow.ndjson
 *   Get-Content shadow.ndjson | pnpm d1:shadow-report --format=markdown
 *   pnpm d1:shadow-report --input=shadow.ndjson --strict-scope=m6
 */

export interface D1ShadowParityCliIo {
  args: string[];
  readFile: (filePath: string) => string;
  readStdin: () => Promise<string>;
  writeFile: (filePath: string, contents: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** True when stdin is an interactive terminal (prevents a silent hang). */
  stdinIsTty: boolean;
}

interface ParsedCliArgs {
  inputPath: string | null;
  format: "json" | "markdown";
  outputPath: string | null;
  strictScope: "none" | "m6" | "global";
  thresholds: Partial<D1ShadowParityThresholds>;
  help: boolean;
}

const HELP = `Usage: pnpm d1:shadow-report [input.ndjson] [options]

Reads NDJSON \`worldcons.d1_shadow\` events from a file path or stdin and emits a
deterministic M6.5 parity report. Local read-only evidence only.

Options:
  --input=<path>                    input file (also the first positional path; \`-\` = stdin)
  --format=json|markdown            output format (default json)
  --output=<path>                   write the report to a file instead of stdout
  --min-compared-per-method=<n>     minimum compared samples per method (default 20)
  --max-mismatch-rate=<0..1>        maximum mismatch rate (default 0)
  --max-error-rate=<0..1>           maximum error rate (default 0)
  --max-timeout-rate=<0..1>         maximum timeout rate (default 0)
  --strict-scope=m6|global|none     exit nonzero on \`m6\` non-go / global blocked (default none)
  --strict                          alias for --strict-scope=global
  -h, --help                        show this help

Thresholds are proposed local defaults, not agreed production policy. The global
GO-D1-READ gate stays blocked while M7 search and both admin RPC snapshots are
unresolved, so \`--strict-scope=global\` (and \`--strict\`) intentionally exit nonzero.
`;

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseRate(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be a number in [0, 1]`);
  return parsed;
}

export function parseD1ShadowParityCliArgs(args: readonly string[]): ParsedCliArgs {
  const positional: string[] = [];
  let format: "json" | "markdown" = "json";
  let outputPath: string | null = null;
  let strictScope: "none" | "m6" | "global" = "none";
  let help = false;
  const thresholds: Partial<D1ShadowParityThresholds> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${name} requires a value`);
      index += 1;
      return next;
    };

    switch (name) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--input":
        positional.push(takeValue());
        break;
      case "--format": {
        const value = takeValue().toLowerCase();
        if (value !== "json" && value !== "markdown") throw new Error("--format must be json or markdown");
        format = value;
        break;
      }
      case "--output":
        outputPath = takeValue();
        break;
      case "--min-compared-per-method":
        thresholds.minComparedPerMethod = parsePositiveInteger(takeValue(), name);
        break;
      case "--max-mismatch-rate":
        thresholds.maxMismatchRate = parseRate(takeValue(), name);
        break;
      case "--max-error-rate":
        thresholds.maxErrorRate = parseRate(takeValue(), name);
        break;
      case "--max-timeout-rate":
        thresholds.maxTimeoutRate = parseRate(takeValue(), name);
        break;
      case "--strict-scope": {
        const value = takeValue().toLowerCase();
        if (value !== "none" && value !== "m6" && value !== "global") {
          throw new Error("--strict-scope must be m6, global or none");
        }
        strictScope = value;
        break;
      }
      case "--strict":
        strictScope = "global";
        break;
      case "--json":
        format = "json";
        break;
      case "--markdown":
        format = "markdown";
        break;
      default:
        if (name.startsWith("-") && name !== "-") throw new Error(`unknown option ${name}`);
        positional.push(arg);
    }
  }

  if (positional.length > 1) throw new Error("at most one input path may be provided");
  return {
    inputPath: positional[0] ?? null,
    format,
    outputPath,
    strictScope,
    thresholds,
    help,
  };
}

function render(report: D1ShadowParityReport, format: "json" | "markdown"): string {
  if (format === "markdown") return renderD1ShadowParityReportMarkdown(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function runD1ShadowParityReportCli(io: D1ShadowParityCliIo): Promise<number> {
  try {
    const parsed = parseD1ShadowParityCliArgs(io.args);
    if (parsed.help) {
      io.stdout(HELP);
      return 0;
    }

    const usesStdin = parsed.inputPath === null || parsed.inputPath === "-";
    if (usesStdin && io.stdinIsTty) {
      throw new Error("no input path provided and stdin is a TTY; pipe NDJSON or pass an input file");
    }
    const text = usesStdin ? await io.readStdin() : io.readFile(parsed.inputPath as string);

    const ndjson = parseD1ShadowNdjson(text);
    const report = buildD1ShadowParityReport({
      events: ndjson.events,
      malformedJsonLines: ndjson.malformedJsonLines,
      blankLines: ndjson.blankLines,
      thresholds: parsed.thresholds,
    });

    const output = render(report, parsed.format);
    if (parsed.outputPath !== null) io.writeFile(parsed.outputPath, output);
    else io.stdout(output);

    return d1ShadowParityExitCode(report, parsed.strictScope);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    io.stderr(`d1-shadow-parity-report: ${message}\n`);
    return 2;
  }
}

function defaultIo(): D1ShadowParityCliIo {
  return {
    args: process.argv.slice(2),
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString("utf8");
    },
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents, "utf8"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTty: Boolean(process.stdin.isTTY),
  };
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  void runD1ShadowParityReportCli(defaultIo()).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
