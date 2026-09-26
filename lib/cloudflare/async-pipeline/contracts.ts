export const M8_SCHEMA_VERSION = 1 as const;

export const M8_TASK_KINDS = [
  "admin-job-drain",
  "watchdog",
  "crawler-daily",
  "embedding-backfill",
  "summary-drain",
  "admin-health",
] as const;

export type M8TaskKind = (typeof M8_TASK_KINDS)[number];

/**
 * Sentinel used by `M8_ENABLED_KINDS` to opt a rollout into every known kind.
 * It is intentionally not the default: an unset/empty/invalid allowlist while
 * the scheduler is enabled resolves to a closed (fail-closed) policy.
 */
export const M8_ENABLED_KINDS_ANY = "*" as const;

export const M8_WORKFLOW_INSTANCE_ID_MAX_LENGTH = 100 as const;

export interface M8TaskMessage {
  schemaVersion: typeof M8_SCHEMA_VERSION;
  kind: M8TaskKind;
  scheduledFor: string;
  idempotencyKey: string;
}

export interface M8GitHubDispatch {
  workflow: string;
  inputs: Record<string, string>;
}

const CRON_TASKS: Readonly<Record<string, readonly M8TaskKind[]>> = {
  "*/15 * * * *": ["admin-job-drain", "watchdog"],
  "0 0 * * *": ["crawler-daily"],
  "30 1 * * *": ["embedding-backfill"],
  "30 3,9,15,21 * * *": ["summary-drain"],
  "17 20 * * *": ["admin-health"],
};

const WORKFLOW_BY_KIND: Readonly<Record<M8TaskKind, string>> = {
  "admin-job-drain": "admin-job-worker.yml",
  watchdog: "admin-watchdog.yml",
  "crawler-daily": "crawlee-worker.yml",
  "embedding-backfill": "embedding-backfill.yml",
  "summary-drain": "summary-drain.yml",
  "admin-health": "admin-health-p5.yml",
};

function scheduledMinute(scheduledTime: number) {
  const date = new Date(scheduledTime);
  if (!Number.isFinite(date.getTime())) throw new Error("m8.invalid_scheduled_time");
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export function buildM8IdempotencyKey(kind: M8TaskKind, scheduledFor: string) {
  return `m8:${kind}:${scheduledFor}`;
}

export function buildM8TaskMessage(kind: M8TaskKind, scheduledTime: number): M8TaskMessage {
  const scheduledFor = scheduledMinute(scheduledTime);
  return {
    schemaVersion: M8_SCHEMA_VERSION,
    kind,
    scheduledFor,
    idempotencyKey: buildM8IdempotencyKey(kind, scheduledFor),
  };
}

export function messagesForM8Cron(cron: string, scheduledTime: number): M8TaskMessage[] {
  return (CRON_TASKS[cron] ?? []).map((kind) => buildM8TaskMessage(kind, scheduledTime));
}

export function isM8TaskMessage(value: unknown): value is M8TaskMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<M8TaskMessage>;
  if (candidate.schemaVersion !== M8_SCHEMA_VERSION) return false;
  if (!M8_TASK_KINDS.includes(candidate.kind as M8TaskKind)) return false;
  if (typeof candidate.scheduledFor !== "string" || scheduledMinute(Date.parse(candidate.scheduledFor)) !== candidate.scheduledFor) {
    return false;
  }
  return candidate.idempotencyKey === buildM8IdempotencyKey(candidate.kind as M8TaskKind, candidate.scheduledFor);
}

export interface M8EnabledKindsPolicy {
  /** True only for the explicit `*` sentinel. Never implied by absence. */
  any: boolean;
  /** The concrete allowed kinds parsed from the allowlist. */
  kinds: readonly M8TaskKind[];
  /** Raw allowlist string as supplied by the environment. */
  raw: string;
  /** Config validation result; failures imply a permanently closed gate. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

function m8KnownKind(value: string): value is M8TaskKind {
  return (M8_TASK_KINDS as readonly string[]).includes(value);
}

/**
 * Runtime-neutral parser for the `M8_ENABLED_KINDS` env allowlist.
 *
 * Semantics:
 * - Comma-separated, exact `M8TaskKind` values. Whitespace around entries is
 *   trimmed; empty entries are ignored.
 * - `*` (alone or as an entry) means "all known kinds" and is only honored when
 *   it is the sole non-empty entry.
 * - An absent/empty allowlist is INVALID (fail closed): enabling the scheduler
 *   must never implicitly enable every kind.
 * - Any unknown kind, or `*` mixed with explicit kinds, is INVALID.
 *
 * An invalid policy makes every gate resolve to "denied" so a misconfigured
 * rollout cannot dispatch anything.
 */
export function parseM8EnabledKinds(raw: string | undefined | null): M8EnabledKindsPolicy {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { any: false, kinds: [], raw: value, valid: false, reason: "m8.enabled_kinds_empty" };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { any: false, kinds: [], raw: value, valid: false, reason: "m8.enabled_kinds_empty" };
  }
  if (entries.includes(M8_ENABLED_KINDS_ANY)) {
    if (entries.length !== 1) {
      return {
        any: false,
        kinds: [],
        raw: value,
        valid: false,
        reason: "m8.enabled_kinds_wildcard_mixed",
      };
    }
    return { any: true, kinds: [...M8_TASK_KINDS], raw: value, valid: true };
  }
  const unknown = entries.filter((entry) => !m8KnownKind(entry));
  if (unknown.length > 0) {
    return {
      any: false,
      kinds: [],
      raw: value,
      valid: false,
      reason: `m8.enabled_kinds_unknown:${unknown.join("|")}`,
    };
  }
  const kinds = [...new Set(entries as M8TaskKind[])];
  return { any: false, kinds, raw: value, valid: true };
}

export interface M8RolloutGate {
  schedulerEnabled: boolean;
  policy: M8EnabledKindsPolicy;
}

/**
 * Combined rollout gate. The scheduler boolean is the master switch; the
 * allowlist can only narrow, never widen, what is eligible. A closed gate
 * (scheduler off, or an invalid allowlist) denies every kind.
 */
export function resolveM8RolloutGate(
  schedulerEnabled: boolean,
  enabledKinds: string | undefined | null,
): M8RolloutGate {
  return { schedulerEnabled, policy: parseM8EnabledKinds(enabledKinds) };
}

export function isM8KindEnabled(gate: M8RolloutGate, kind: M8TaskKind): boolean {
  if (!gate.schedulerEnabled || !gate.policy.valid) return false;
  return gate.policy.any || gate.policy.kinds.includes(kind);
}

export interface M8QueuePartition<T> {
  /** Schema-valid messages whose kind the gate allows; these dispatch. */
  eligible: T[];
  /** Schema-valid but gate-blocked messages; ack without dispatch. */
  blocked: T[];
  /** Schema-invalid messages; retry toward the DLQ. */
  invalid: T[];
}

/**
 * Partitions a Queue batch against the gate. The Worker uses this so the
 * ack/retry/dispatch decision is a single tested function:
 * - invalid -> retry (bounded) so poison messages reach the DLQ;
 * - blocked -> ack (no dispatch, no DLQ churn while a rollout gate is closed);
 * - eligible -> create Workflow(s) then ack.
 */
export function partitionM8QueueBatch<T>(
  gate: M8RolloutGate,
  messages: readonly T[],
  getBody: (message: T) => unknown,
): M8QueuePartition<T> {
  const partition: M8QueuePartition<T> = { eligible: [], blocked: [], invalid: [] };
  for (const message of messages) {
    const body = getBody(message);
    if (!isM8TaskMessage(body)) {
      partition.invalid.push(message);
    } else if (isM8KindEnabled(gate, body.kind)) {
      partition.eligible.push(message);
    } else {
      partition.blocked.push(message);
    }
  }
  return partition;
}

export function workflowInstanceId(message: M8TaskMessage) {
  return message.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, M8_WORKFLOW_INSTANCE_ID_MAX_LENGTH);
}

const M8_WORKFLOW_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * True when an id is acceptable to Cloudflare Workflows: it must start with a
 * letter/underscore, contain only `[A-Za-z0-9_-]`, and be at most 100 chars.
 * `workflowInstanceId` is deterministic, so this is a property of the mapper.
 */
export function isM8WorkflowInstanceId(id: string): boolean {
  return id.length > 0 && id.length <= M8_WORKFLOW_INSTANCE_ID_MAX_LENGTH && M8_WORKFLOW_INSTANCE_ID_PATTERN.test(id);
}

export function githubDispatchForM8Task(message: M8TaskMessage): M8GitHubDispatch {
  return {
    workflow: WORKFLOW_BY_KIND[message.kind],
    inputs: { m8_idempotency_key: message.idempotencyKey },
  };
}

export const M8_CRON_EXPRESSIONS = Object.freeze(Object.keys(CRON_TASKS));
