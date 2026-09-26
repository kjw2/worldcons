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

export function messagesForM8Cron(cron: string, scheduledTime: number): M8TaskMessage[] {
  const scheduledFor = scheduledMinute(scheduledTime);
  return (CRON_TASKS[cron] ?? []).map((kind) => ({
    schemaVersion: M8_SCHEMA_VERSION,
    kind,
    scheduledFor,
    idempotencyKey: buildM8IdempotencyKey(kind, scheduledFor),
  }));
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

export function workflowInstanceId(message: M8TaskMessage) {
  return message.idempotencyKey;
}

export function githubDispatchForM8Task(message: M8TaskMessage): M8GitHubDispatch {
  return {
    workflow: WORKFLOW_BY_KIND[message.kind],
    inputs: { m8_idempotency_key: message.idempotencyKey },
  };
}

export const M8_CRON_EXPRESSIONS = Object.freeze(Object.keys(CRON_TASKS));
