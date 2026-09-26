import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildM8TaskMessage,
  githubDispatchForM8Task,
  isM8KindEnabled,
  isM8TaskMessage,
  isM8WorkflowInstanceId,
  M8_TASK_KINDS,
  resolveM8RolloutGate,
  workflowInstanceId,
  type M8TaskKind,
} from "@/lib/cloudflare/async-pipeline/contracts";

/**
 * M8 async canary operator CLI.
 *
 *   pnpm m8:canary                              # print policy + message (dry-run)
 *   pnpm m8:canary --kind=admin-health
 *   pnpm m8:canary --apply --kind=admin-health  # publish exactly one message
 *
 * Dry-run by default: it resolves the current canary policy from the Wrangler
 * config (or env overrides), builds the deterministic `M8TaskMessage`, and
 * prints the bounded evidence an operator needs before a controlled canary. It
 * is a policy/inspection tool plus an optional single-message Queue producer.
 *
 * Safety:
 *
 * - It NEVER dispatches GitHub directly and never bypasses the scheduler gate.
 *   `--apply` only posts ONE message to the M8 Queue. The deployed Worker still
 *   applies its own `M8_SCHEDULER_ENABLED` + `M8_ENABLED_KINDS` gate.
 * - By default `--apply` refuses to publish a kind the resolved policy blocks,
 *   so an operator cannot accidentally fan out a disabled kind.
 * - Credentials come from the environment ONLY
 *   (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`). The CLI does not
 *   read or print the Wrangler OAuth/session token.
 */

const WRANGLER_CONFIG = path.join("workers", "async-pipeline", "wrangler.jsonc");
const DEFAULT_QUEUE = "worldcons-async-v1";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function nonEmptyEnv(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface WranglerConfigShape {
  queue: string;
  schedulerEnabled: boolean;
  enabledKinds: string;
}

export function readCanaryPolicy(env: Record<string, string | undefined> = process.env): WranglerConfigShape {
  const raw = JSON.parse(fs.readFileSync(WRANGLER_CONFIG, "utf8")) as {
    vars?: Record<string, string>;
    queues?: { producers?: { queue?: string }[] };
  };
  const vars = raw.vars ?? {};
  return {
    queue: raw.queues?.producers?.[0]?.queue ?? DEFAULT_QUEUE,
    schedulerEnabled: (env.M8_SCHEDULER_ENABLED ?? vars.M8_SCHEDULER_ENABLED) === "true",
    enabledKinds: env.M8_ENABLED_KINDS ?? vars.M8_ENABLED_KINDS ?? "",
  };
}

function resolveKind(args: readonly string[]): M8TaskKind {
  const raw = (argValue(args, "kind") ?? "admin-health").trim();
  if (!(M8_TASK_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`unknown --kind=${raw} (expected ${M8_TASK_KINDS.join("|")})`);
  }
  return raw as M8TaskKind;
}

function resolveScheduledFor(args: readonly string[]): number {
  const raw = argValue(args, "scheduled-for");
  if (raw === null) {
    const now = new Date();
    now.setUTCSeconds(0, 0);
    return now.getTime();
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--scheduled-for is not a valid date: ${raw}`);
  return parsed;
}

async function resolveCredentials(env: Record<string, string | undefined>): Promise<{ accountId: string; apiToken: string }> {
  const envAccountId = nonEmptyEnv(env.CLOUDFLARE_ACCOUNT_ID);
  const envApiToken = nonEmptyEnv(env.CLOUDFLARE_API_TOKEN);
  if (envAccountId !== null && envApiToken !== null) {
    if (!ACCOUNT_ID_PATTERN.test(envAccountId)) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID is not a 32-character hex id");
    }
    return { accountId: envAccountId, apiToken: envApiToken };
  }
  throw new Error(
    "publishing requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the environment; " +
      "set them explicitly (the canary CLI never reads the Wrangler OAuth session token for writes)",
  );
}

async function publishOnce(options: {
  accountId: string;
  apiToken: string;
  queue: string;
  message: unknown;
  fetch: typeof fetch;
}): Promise<{ ok: boolean; status: number; metrics: unknown }> {
  const response = await options.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/queues/${options.queue}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: options.message, content_type: "json" }),
    },
  );
  const parsed = (await response.json().catch(() => null)) as
    | { success?: boolean; result?: { metadata?: unknown } }
    | null;
  return {
    ok: response.ok && parsed?.success === true,
    status: response.status,
    metrics: parsed?.result?.metadata ?? null,
  };
}

export interface CanaryReport {
  dryRun: boolean;
  queue: string;
  schedulerEnabled: boolean;
  enabledKindsRaw: string;
  enabledKinds: readonly string[];
  enabledKindsAny: boolean;
  enabledKindsValid: boolean;
  reason: string | null;
  kind: M8TaskKind;
  kindEnabled: boolean;
  message: ReturnType<typeof buildM8TaskMessage>;
  workflowInstanceId: string;
  workflowInstanceIdValid: boolean;
  githubDispatch: ReturnType<typeof githubDispatchForM8Task>;
}

export function buildCanaryReport(options: {
  kind: M8TaskKind;
  scheduledFor: number;
  policy: WranglerConfigShape;
}): CanaryReport {
  const gate = resolveM8RolloutGate(options.policy.schedulerEnabled, options.policy.enabledKinds);
  const message = buildM8TaskMessage(options.kind, options.scheduledFor);
  const instanceId = workflowInstanceId(message);
  return {
    dryRun: true,
    queue: options.policy.queue,
    schedulerEnabled: gate.schedulerEnabled,
    enabledKindsRaw: gate.policy.raw,
    enabledKinds: gate.policy.kinds,
    enabledKindsAny: gate.policy.any,
    enabledKindsValid: gate.policy.valid,
    reason: gate.policy.reason ?? null,
    kind: options.kind,
    kindEnabled: isM8KindEnabled(gate, options.kind),
    message,
    workflowInstanceId: instanceId,
    workflowInstanceIdValid: isM8WorkflowInstanceId(instanceId),
    githubDispatch: githubDispatchForM8Task(message),
  };
}

function printReport(report: CanaryReport): void {
  console.log(`M8 canary (${report.dryRun ? "dry-run" : "published"})`);
  console.log(`  queue: ${report.queue}`);
  console.log(
    `  schedulerEnabled: ${report.schedulerEnabled}; allowlist "${report.enabledKindsRaw}" ` +
      `(${report.enabledKindsAny ? "*" : report.enabledKinds.join("|") || "none"}) valid=${report.enabledKindsValid}${report.reason ? ` reason=${report.reason}` : ""}`,
  );
  console.log(`  kind: ${report.kind} -> enabled=${report.kindEnabled}`);
  console.log(`  idempotencyKey: ${report.message.idempotencyKey}`);
  console.log(`  workflowInstanceId: ${report.workflowInstanceId} (valid=${report.workflowInstanceIdValid})`);
  console.log(
    `  github: ${report.githubDispatch.workflow} inputs.m8_idempotency_key=${report.githubDispatch.inputs.m8_idempotency_key}`,
  );
  if (!report.message || !isM8TaskMessage(report.message)) console.error("  error: message failed schema validation");
  if (!report.workflowInstanceIdValid) console.error("  error: workflow instance id is not Cloudflare-valid");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = hasFlag(args, "json");
  const apply = hasFlag(args, "apply");
  const kind = resolveKind(args);
  const scheduledFor = resolveScheduledFor(args);
  const policy = readCanaryPolicy();
  const report = buildCanaryReport({ kind, scheduledFor, policy });

  if (!report.enabledKindsValid && policy.schedulerEnabled) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ...report, apply, published: false, error: report.reason }, null, 2)}\n`);
    else printReport(report);
    console.error(`m8 canary refused: allowlist is invalid (${report.reason ?? "unknown"}); fix M8_ENABLED_KINDS first`);
    process.exitCode = 1;
    return;
  }
  if (apply && !report.kindEnabled) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ...report, apply, published: false, error: "kind_not_enabled" }, null, 2)}\n`);
    else printReport(report);
    console.error(`m8 canary refused: kind ${kind} is not enabled by the current policy; refusing to publish`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ...report, apply: false, published: false }, null, 2)}\n`);
    else printReport(report);
    return;
  }

  const { accountId, apiToken } = await resolveCredentials(process.env);
  const result = await publishOnce({ accountId, apiToken, queue: report.queue, message: report.message, fetch });
  const output = { ...report, dryRun: false, apply: true, published: result.ok, status: result.status, metrics: result.metrics };
  if (asJson) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    printReport({ ...report, dryRun: false });
    console.log(`  published: ${result.ok} (status ${result.status})`);
    if (result.metrics) console.log(`  queueMetrics: ${JSON.stringify(result.metrics)}`);
  }
  if (!result.ok) process.exitCode = 1;
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error) => {
    console.error(`m8-async-canary failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
