import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  githubDispatchForM8Task,
  isM8KindEnabled,
  isM8TaskMessage,
  M8_INVALID_RETRY_DELAY_SECONDS,
  messagesForM8Cron,
  planM8QueueBatch,
  resolveM8RolloutGate,
  type M8RolloutGate,
  type M8TaskMessage,
} from "../../../lib/cloudflare/async-pipeline/contracts";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function gate(env: Env): M8RolloutGate {
  return resolveM8RolloutGate(env.M8_SCHEDULER_ENABLED === "true", env.M8_ENABLED_KINDS);
}

async function dispatchGitHubWorkflow(env: Env, message: M8TaskMessage) {
  const dispatch = githubDispatchForM8Task(message);
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${dispatch.workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "worldcons-m8-async-pipeline",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF, inputs: dispatch.inputs }),
    },
  );
  if (!response.ok) {
    throw new Error(`m8.github_dispatch_failed:${response.status}`);
  }
  return { workflow: dispatch.workflow, status: response.status, idempotencyKey: message.idempotencyKey };
}

export class WorldconsAsyncWorkflow extends WorkflowEntrypoint<Env, M8TaskMessage> {
  async run(event: WorkflowEvent<M8TaskMessage>, step: WorkflowStep) {
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
    return step.do(
      "dispatch-compatible-executor",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      () => dispatchGitHubWorkflow(this.env, event.payload),
    );
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
      });
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
