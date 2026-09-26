import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  githubDispatchForM8Task,
  isM8TaskMessage,
  messagesForM8Cron,
  workflowInstanceId,
  type M8TaskMessage,
} from "../../../lib/cloudflare/async-pipeline/contracts";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function enabled(env: Env) {
  return env.M8_SCHEDULER_ENABLED === "true";
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
    if (!enabled(this.env)) throw new Error("m8.scheduler_disabled");
    if (!isM8TaskMessage(event.payload)) throw new Error("m8.invalid_workflow_payload");
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
      return json({ schemaVersion: 1, service: "worldcons-ingest", schedulerEnabled: enabled(env) });
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env) {
    if (!enabled(env)) {
      console.log(JSON.stringify({ event: "m8_schedule_skipped", reason: "disabled", cron: controller.cron }));
      return;
    }
    const messages = messagesForM8Cron(controller.cron, controller.scheduledTime);
    if (messages.length === 0) throw new Error("m8.unknown_cron");
    await env.ASYNC_QUEUE.sendBatch(messages.map((body) => ({ body, contentType: "json" })));
    console.log(JSON.stringify({ event: "m8_schedule_enqueued", cron: controller.cron, count: messages.length }));
  },

  async queue(batch: MessageBatch<M8TaskMessage>, env: Env) {
    if (!enabled(env)) {
      for (const message of batch.messages) message.retry({ delaySeconds: 300 });
      return;
    }
    const valid = batch.messages.filter((message) => isM8TaskMessage(message.body));
    const invalid = batch.messages.filter((message) => !isM8TaskMessage(message.body));
    for (const message of invalid) message.retry({ delaySeconds: 300 });
    if (valid.length === 0) return;
    try {
      await env.ASYNC_WORKFLOW.createBatch(valid.map((message) => ({
        id: workflowInstanceId(message.body),
        params: message.body,
      })));
      for (const message of valid) message.ack();
    } catch (error) {
      console.error(JSON.stringify({ event: "m8_workflow_batch_failed", count: valid.length }));
      for (const message of valid) message.retry();
      throw error;
    }
  },
} satisfies ExportedHandler<Env, M8TaskMessage>;
