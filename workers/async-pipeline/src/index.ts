import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  isM8KindEnabled,
  isM8TaskMessage,
  M8_INVALID_RETRY_DELAY_SECONDS,
  messagesForM8Cron,
  planM8QueueBatch,
  resolveM8RolloutGate,
  type M8RolloutGate,
  type M8TaskMessage,
} from "../../../lib/cloudflare/async-pipeline/contracts";
import {
  executeM8TaskNative,
  type M8NativeEnvironment,
} from "../../../lib/cloudflare/async-pipeline/native-executor";
import { setRuntimeD1Bindings } from "../../../lib/cloudflare/d1/runtime-binding";
import { handleBrowserNavigate } from "./browser-navigate";
import { runNativeAdminJobDrain } from "./admin-job-drain";
import { runNativeSourceCollection, NATIVE_CRAWLER_SOURCES } from "./native-crawler";
import { runNativeSearchProjectionSync } from "./search-projection-sync";
import { launch } from "@cloudflare/playwright";

async function browserNavigate(input: { url: string; timeoutMs: number; waitUntil: "domcontentloaded"; userAgent: string }, binding: BrowserRun) {
  const browser = await launch(binding, { keep_alive: 60_000 });
  try {
    const page = await browser.newPage({ userAgent: input.userAgent });
    const response = await page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
    return { html: await page.content(), finalUrl: page.url(), status: response?.status() ?? 200, headers: response?.headers() ?? {} };
  } finally {
    await browser.close();
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function gate(env: Env): M8RolloutGate {
  return resolveM8RolloutGate(env.M8_SCHEDULER_ENABLED === "true", env.M8_ENABLED_KINDS);
}

export class WorldconsAsyncWorkflow extends WorkflowEntrypoint<Env, M8TaskMessage> {
  async run(event: WorkflowEvent<M8TaskMessage>, step: WorkflowStep) {
    setRuntimeD1Bindings({
      worldcons_ops: this.env.WORLDCONS_OPS,
      worldcons_core: this.env.WORLDCONS_CORE,
      worldcons_ingest: this.env.WORLDCONS_INGEST,
      worldcons_search: this.env.WORLDCONS_SEARCH,
    });
    const policy = gate(this.env);
    if (!isM8TaskMessage(event.payload)) {
      throw new Error("m8.invalid_workflow_payload");
    }
    if (!isM8KindEnabled(policy, event.payload.kind)) {
      console.log(JSON.stringify({
        event: "m8_workflow_blocked",
        kind: event.payload.kind,
        idempotencyKey: event.payload.idempotencyKey,
        reason: policy.schedulerEnabled ? "kind_not_allowed" : "scheduler_disabled",
      }));
      return { dispatched: false, kind: event.payload.kind, idempotencyKey: event.payload.idempotencyKey };
    }
    if (event.payload.kind === "admin-job-drain") {
      return step.do("native-admin-job-drain", {
        retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
      }, () => runNativeAdminJobDrain({
        env: this.env as unknown as Parameters<typeof runNativeAdminJobDrain>[0]["env"],
        idempotencyKey: event.payload.idempotencyKey,
        maxJobs: 2,
        leaseSeconds: 1200,
        browserNavigate: (input) => browserNavigate(input, this.env.BROWSER),
      }));
    }
    if (event.payload.kind === "search-projection-sync") {
      return step.do("native-search-projection-sync", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
      }, () => runNativeSearchProjectionSync({
        WORLDCONS_CORE: this.env.WORLDCONS_CORE,
        WORLDCONS_SEARCH: this.env.WORLDCONS_SEARCH,
      }));
    }
    if (event.payload.kind === "crawler-daily") {
      const results = [];
      for (const source of NATIVE_CRAWLER_SOURCES) {
        results.push(await step.do(
          `native-crawler-${source}`,
          { retries: { limit: 3, delay: "2 minutes", backoff: "exponential" }, timeout: "25 minutes" },
          () => runNativeSourceCollection(source, this.env, { limit: 20, idempotencyKey: event.payload.idempotencyKey, browserNavigate: (input) => browserNavigate(input, this.env.BROWSER) }),
        ));
      }
      const searchProjection = await step.do("native-search-projection-sync", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
      }, () => runNativeSearchProjectionSync({
        WORLDCONS_CORE: this.env.WORLDCONS_CORE,
        WORLDCONS_SEARCH: this.env.WORLDCONS_SEARCH,
      }));
      return { crawlers: results, searchProjection };
    }
    if (event.payload.kind === "analytics-retention") {
      return step.do("native-analytics-retention", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes",
      }, async () => {
        const retentionDays = Math.min(365, Math.max(30, Number.parseInt(this.env.SITE_ANALYTICS_RETENTION_DAYS ?? "90", 10) || 90));
        const cutoff = new Date(Date.parse(event.payload.scheduledFor) - retentionDays * 86_400_000).toISOString();
        const result = await this.env.WORLDCONS_OPS.prepare("DELETE FROM site_events WHERE occurred_at < ?").bind(cutoff).run();
        return { kind: event.payload.kind, retentionDays, deleted: result.meta.changes ?? 0 };
      });
    }
    return executeM8TaskNative(this.env as unknown as M8NativeEnvironment, event.payload, step);
  }
}

interface BackfillWorkflowPayload {
  snapshotId: string;
  phase: "fetch";
  passNumber: number;
  batchLimit?: number;
  fetchContractVersion?: string;
  requestedBy?: string;
}

interface BackfillOpsServiceBinding {
  runBackfillPass(input: BackfillWorkflowPayload): Promise<unknown>;
}

function validBackfillWorkflowPayload(value: unknown): value is BackfillWorkflowPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["snapshotId", "phase", "passNumber", "batchLimit", "fetchContractVersion", "requestedBy"].includes(key))) return false;
  return typeof payload.snapshotId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.snapshotId)
    && payload.phase === "fetch"
    && Number.isInteger(payload.passNumber) && Number(payload.passNumber) >= 1 && Number(payload.passNumber) <= 2_147_483_647
    && (payload.batchLimit === undefined || (Number.isInteger(payload.batchLimit) && Number(payload.batchLimit) >= 1 && Number(payload.batchLimit) <= 10))
    && (payload.fetchContractVersion === undefined || (typeof payload.fetchContractVersion === "string" && payload.fetchContractVersion.trim().length >= 1 && payload.fetchContractVersion.length <= 120))
    && (payload.requestedBy === undefined || (typeof payload.requestedBy === "string" && payload.requestedBy.trim().length >= 1 && payload.requestedBy.length <= 160));
}

export class WorldconsBackfillWorkflow extends WorkflowEntrypoint<Env, BackfillWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillWorkflowPayload>, step: WorkflowStep) {
    if (!validBackfillWorkflowPayload(event.payload)) throw new Error("case_backfill.invalid_workflow_payload");
    if (event.payload.fetchContractVersion && event.payload.fetchContractVersion !== "bverfg-official-fetch-v1") {
      throw new Error("case_backfill.fetch_contract_not_approved");
    }
    return step.do("run-bounded-backfill-pass", {
      retries: { limit: 0 },
      timeout: "25 minutes",
    }, () => (this.env.WORLDCONS_APP_SERVICE as unknown as BackfillOpsServiceBinding).runBackfillPass({
      ...event.payload,
      batchLimit: event.payload.batchLimit ?? 1,
      fetchContractVersion: event.payload.fetchContractVersion ?? "bverfg-official-fetch-v1",
      requestedBy: event.payload.requestedBy ?? "worldcons-backfill-workflow",
    }));
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const policy = gate(env);
      return json({
        schemaVersion: 1,
        service: "worldcons-ingest",
        schedulerEnabled: policy.schedulerEnabled,
        enabledKinds: policy.policy.kinds,
        enabledKindsAny: policy.policy.any,
        enabledKindsValid: policy.policy.valid,
        enabledKindsReason: policy.policy.reason ?? null,
        browserNavigate: true,
        browserRpc: true,
      });
    }
    // Authenticated Browser Rendering transport, merged in from the retired
    // standalone `worldcons-browser-run` Worker. The existing Node/GitHub
    // crawler caller only needs this bearer-protected POST route.
    if (request.method === "POST" && url.pathname === "/v1/navigate") {
      return handleBrowserNavigate(request, env);
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env) {
    const policy = gate(env);
    if (!policy.schedulerEnabled) {
      console.log(JSON.stringify({ event: "m8_schedule_skipped", reason: "disabled", cron: controller.cron }));
      return;
    }
    if (!policy.policy.valid) {
      console.error(JSON.stringify({
        event: "m8_schedule_skipped",
        reason: policy.policy.reason ?? "m8.enabled_kinds_invalid",
        cron: controller.cron,
      }));
      return;
    }
    const messages = messagesForM8Cron(controller.cron, controller.scheduledTime);
    if (messages.length === 0) throw new Error("m8.unknown_cron");
    const eligible = messages.filter((message) => isM8KindEnabled(policy, message.kind));
    if (eligible.length === 0) {
      console.log(JSON.stringify({
        event: "m8_schedule_skipped",
        reason: "no_enabled_kinds",
        cron: controller.cron,
      }));
      return;
    }
    await env.ASYNC_QUEUE.sendBatch(eligible.map((body) => ({ body, contentType: "json" })));
    console.log(JSON.stringify({
      event: "m8_schedule_enqueued",
      cron: controller.cron,
      count: eligible.length,
      blocked: messages.length - eligible.length,
    }));
  },

  async queue(batch: MessageBatch<M8TaskMessage>, env: Env) {
    const policy = gate(env);
    const reason = policy.schedulerEnabled ? (policy.policy.reason ?? "kind_not_allowed") : "scheduler_disabled";
    const plan = planM8QueueBatch<Message<M8TaskMessage>>(
      policy,
      batch.messages,
      (message) => message.body,
    );
    // Malformed payloads can never become valid; keep the bounded retry -> DLQ
    // path so poison messages are observable rather than dropped.
    for (const message of plan.invalid) {
      message.retry({ delaySeconds: M8_INVALID_RETRY_DELAY_SECONDS });
    }
    // Valid but gate-blocked (scheduler off or kind not allowlisted): ack
    // without dispatch. They must not spin forever or reach the DLQ merely
    // because a rollout gate is closed; a later eligible schedule re-enqueues
    // them. Disallowed kinds are never dispatched.
    for (const message of plan.blocked) {
      message.ack();
      console.log(JSON.stringify({
        event: "m8_queue_kind_blocked",
        kind: message.body.kind,
        idempotencyKey: message.body.idempotencyKey,
        reason,
      }));
    }
    if (plan.creates.length === 0) return;
    try {
      // `createBatch` is idempotent by instance id. `planM8QueueBatch` also
      // dedupes the batch so a redelivery after a consumer restart cannot
      // schedule two Workflows for the same deterministic identity.
      await env.ASYNC_WORKFLOW.createBatch(plan.creates);
      for (const message of plan.eligible) message.ack();
    } catch (error) {
      console.error(JSON.stringify({ event: "m8_workflow_batch_failed", count: plan.creates.length }));
      for (const message of plan.eligible) message.retry();
      throw error;
    }
  },
} satisfies ExportedHandler<Env, M8TaskMessage>;
