import { drainSearchMetadataRepairs } from "@/lib/cloudflare/search-projection/metadata-repair";
import {runDiscoveryCoverageScheduled,type DiscoveryCoverageEnvironment} from "./discovery-coverage-scheduled";
import { stagedE2EOptionsFromEnvironment } from "./staged-e2e";
import { consumeE2ESearchRepairBatch, E2E_SEARCH_REPAIR_QUEUE_NAME, type E2ESearchConsumerEnvironment } from "./e2e-search-repair-queue";
import { runE2ESearchRepairScheduled, type E2ESearchRepairEnvironment } from "./e2e-search-repair-scheduled";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
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
import { resolveM8CrawlerSourcePolicy } from "../../../lib/cloudflare/async-pipeline/crawler-source-ownership";import { setRuntimeD1Bindings } from "../../../lib/cloudflare/d1/runtime-binding";
import { INGEST_STAGE_NAMES, INGEST_STAGE_QUEUES, type IngestStage } from "../../../lib/cloudflare/ingest-stages/contracts";
import { ingestStageGateFromEnvironment, isIngestStageEnabled, resolveIngestBootstrapSources } from "../../../lib/cloudflare/ingest-stages/flags";
import { dispatchIngestStagePass, reconcileIngestStageDispatch, type IngestStageQueueSender } from "../../../lib/cloudflare/ingest-stages/dispatcher";
import { consumeIngestStageBatch, type IngestStageHandlerRegistry } from "./ingest-stage-consumer";
import { createIngestStageHandlers, enqueueIngestStageDiscovery, enqueueCanaryDiscovery } from "./ingest-stage-handlers";
import { canarySourceGateAllows, CANARY_SOURCE_KEYS } from "../../../lib/cloudflare/ingest-stages/canary";
import { canaryDiscoveryId } from "../../../lib/cloudflare/ingest-stages/canary-discovery";
import { evaluateBootstrapDeOnePrecondition, BOOTSTRAP_DE_ONE_SOURCE_KEY } from "../../../lib/cloudflare/ingest-stages/bootstrap-de-one";
import {
  parseOperatorCanaryEvent,
  type OperatorCanaryEvent,
} from "../../../lib/cloudflare/ingest-stages/canary-workflow-payload";
import { planCanaryCase, seedCanaryCase, dispatchCanaryCase, advanceCanaryCase } from "../../../lib/cloudflare/ingest-stages/canary";
import { handleStageCanary } from "./stage-canary-route";
import type { NativeCrawlerBindings, NativeCrawlerSource } from "./native-crawler";
import { handleBrowserNavigate } from "./browser-navigate";
import { runNativeAdminJobDrain } from "./admin-job-drain";
import { runNativeSourceCollection, NATIVE_CRAWLER_SOURCES } from "./native-crawler";
import { runNativeSearchProjectionSync } from "./search-projection-sync";
import { hasPendingP3Publication } from "./publication-recovery";
import { runD1CacheOutboxDrain } from "./cache-outbox-drain";
import { launch } from "@cloudflare/playwright";
import {
  parseGermanyBackfillFetchPayload,
  planGermanyBackfillContinuation,
  recoverGermanyBackfillMissingArtifactsForRefetch,
  runGermanyBackfillFetchPass,
  type GermanyBackfillFetchPayload,
} from "./backfill-fetch";
import {
  parseGermanyBackfillNormalizePayload,
  runGermanyBackfillNormalizePass,
  type GermanyBackfillNormalizePayload,
} from "./backfill-normalize";
import {
  parseGermanyBackfillVerifyPayload,
  runGermanyBackfillVerifyPass,
  type GermanyBackfillVerifyPayload,
} from "./backfill-verify";
import {
  parseGermanyBackfillPublishPayload,
  runGermanyBackfillPublishPass,
  type GermanyBackfillPublishPayload,
} from "./backfill-publish";
import {
  discoverGermanyBackfillInventoryWithLoader,
  fetchGermanyBackfillInventoryPage,
  fetchGermanyBackfillRobots,
  openGermanyBackfillDiscoverSnapshot,
  parseGermanyBackfillDiscoverPayload,
  persistGermanyBackfillInventory,
  startGermanyBackfillDiscoverRun,
  type GermanyBackfillDiscoverPayload,
} from "./backfill-discover";

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
    if (event.payload.kind === "watchdog") {
      const watchdog = await executeM8TaskNative(this.env as unknown as M8NativeEnvironment, event.payload, step);
      const pending = await step.do("probe-unpublished-translations", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "1 minute",
      }, () => hasPendingP3Publication(this.env.WORLDCONS_CORE));
      let publication:Awaited<ReturnType<M8NativeEnvironment["WORLDCONS_APP_SERVICE"]["runPublicationDrain"]>> | null=null;
      let searchProjection:Awaited<ReturnType<typeof runNativeSearchProjectionSync>> | null=null;
      if (pending) {
      const limit = Math.max(1, Math.min(Number(this.env.PUBLICATION_DRAIN_LIMIT ?? 100) || 100, 500));
      const appService = (this.env as unknown as M8NativeEnvironment).WORLDCONS_APP_SERVICE;
      publication = await step.do("watchdog-recover-pending-publication", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes",
      }, () => appService.runPublicationDrain({ limit }));
      if (publication.publishedCount > 0) {
        searchProjection = await step.do("watchdog-sync-search-after-recovery", {
            retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
          }, () => runNativeSearchProjectionSync({
            WORLDCONS_CORE: this.env.WORLDCONS_CORE,
            WORLDCONS_SEARCH: this.env.WORLDCONS_SEARCH,
          }));
      }
      }
      const outbox = await step.do("watchdog-deliver-publication-cache-outbox", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes",
      }, () => runD1CacheOutboxDrain(this.env.WORLDCONS_CORE, () =>
        (this.env as unknown as M8NativeEnvironment).WORLDCONS_APP_SERVICE.revalidatePublicContentCache(),
        {limit:25,workerId:`watchdog:${event.payload.scheduledFor}`}
      ));
      return {kind:event.payload.kind,watchdog,publication,searchProjection,outbox};
    }
    if (event.payload.kind === "translation-drain") {
      const translation = await executeM8TaskNative(this.env as unknown as M8NativeEnvironment, event.payload, step);
      const summarizedCount = "summarizedCount" in translation ? Number(translation.summarizedCount ?? 0) : 0;
      if (summarizedCount <= 0) {
        return { kind: event.payload.kind, translation, publication: null, searchProjection: null };
      }
      const limit = Math.max(1, Math.min(Number(this.env.PUBLICATION_DRAIN_LIMIT ?? 100) || 100, 500));
      const appService = (this.env as unknown as M8NativeEnvironment).WORLDCONS_APP_SERVICE;
      const publication = await step.do("native-publication-drain-after-translation", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes",
      }, () => appService.runPublicationDrain({ limit }));
      const searchProjection = publication.publishedCount > 0
        ? await step.do("native-search-projection-sync-after-translation", {
            retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
          }, () => runNativeSearchProjectionSync({
            WORLDCONS_CORE: this.env.WORLDCONS_CORE,
            WORLDCONS_SEARCH: this.env.WORLDCONS_SEARCH,
          }))
        : null;
      return { kind: event.payload.kind, translation, publication, searchProjection };
    }
    if (event.payload.kind === "publication-drain") {
      const limit = Math.max(1, Math.min(Number(this.env.PUBLICATION_DRAIN_LIMIT ?? 100) || 100, 500));
      const appService = (this.env as unknown as M8NativeEnvironment).WORLDCONS_APP_SERVICE;
      const publication = await step.do("native-publication-drain", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes",
      }, () => appService.runPublicationDrain({ limit }));
      const searchProjection = await step.do("native-search-projection-sync-after-publication", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes",
      }, () => runNativeSearchProjectionSync({
        WORLDCONS_CORE: this.env.WORLDCONS_CORE,
        WORLDCONS_SEARCH: this.env.WORLDCONS_SEARCH,
      }));
      return { kind: event.payload.kind, publication, searchProjection };
    }
    if (event.payload.kind === "crawler-daily") {
      const sourcePolicy = resolveM8CrawlerSourcePolicy(this.env.M8_CRAWLER_SOURCE_EXCLUDE, NATIVE_CRAWLER_SOURCES);
      if (!sourcePolicy.valid) {
        console.error(JSON.stringify({
          event: "m8_crawler_source_policy_invalid",
          kind: event.payload.kind,
          idempotencyKey: event.payload.idempotencyKey,
          reason: sourcePolicy.reason ?? "m8.crawler_source_exclude_invalid",
        }));
      }
      const results = [];
      for (const source of sourcePolicy.effective as readonly NativeCrawlerSource[]) {
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
      const evidence = {
        effectiveSources: [...sourcePolicy.effective],
        excludedSources: [...sourcePolicy.excluded],
        sourceConfigValid: sourcePolicy.valid,
        sourceConfigReason: sourcePolicy.reason ?? null,
      };
      console.log(JSON.stringify({ event: "m8_crawler_source_policy", kind: event.payload.kind, idempotencyKey: event.payload.idempotencyKey, ...evidence }));
      return { crawlers: results, searchProjection, ...evidence };
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

type BackfillWorkflowPayload = GermanyBackfillFetchPayload | string;

interface BackfillWorkflowCreateBinding {
  create(options: { id: string; params: BackfillWorkflowPayload }): Promise<unknown>;
}

type BackfillDiscoverWorkflowPayload = GermanyBackfillDiscoverPayload | string;

export class WorldconsBackfillDiscoverWorkflow extends WorkflowEntrypoint<Env, BackfillDiscoverWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillDiscoverWorkflowPayload>, step: WorkflowStep) {
    const payload = parseGermanyBackfillDiscoverPayload(event.payload);
    if (!payload) throw new Error("case_backfill.invalid_discover_workflow_payload");
    const opened = await step.do(`open-or-resume-${payload.year}-snapshot`, { timeout: "2 minutes" }, () => (
      openGermanyBackfillDiscoverSnapshot(this.env as unknown as Parameters<typeof openGermanyBackfillDiscoverSnapshot>[0], payload)
    ));
    if (opened.alreadyClosed) return { schemaVersion: 1, snapshotId: opened.snapshotId, alreadyClosed: true };
    const context = await step.do("start-discovery-command", { timeout: "2 minutes" }, () => (
      startGermanyBackfillDiscoverRun(
        this.env as unknown as Parameters<typeof startGermanyBackfillDiscoverRun>[0],payload,opened.snapshotId,
      )
    ));
    const robots = await step.do("discover-robots", { timeout: "5 minutes" }, () => (
      fetchGermanyBackfillRobots(this.env as unknown as Parameters<typeof fetchGermanyBackfillRobots>[0], context)
    ));
    if (!robots.allowed) throw new NonRetryableError("case_backfill.dejure_robots_disallowed");
    const pageCalls = new Map<number, number>();
    const inventory = await discoverGermanyBackfillInventoryWithLoader(payload, async (url, page) => {
      const call = (pageCalls.get(page) ?? 0) + 1;
      pageCalls.set(page, call);
      const serialized = await step.do<string>(`discover-page-${page}-${call}`, { timeout: "5 minutes" }, async () => (
        JSON.stringify(await fetchGermanyBackfillInventoryPage(
          this.env as unknown as Parameters<typeof fetchGermanyBackfillInventoryPage>[0],context,url,page,
        ))
      ));
      return JSON.parse(serialized) as Awaited<ReturnType<typeof fetchGermanyBackfillInventoryPage>>;
    });
    const persisted = await step.do("persist-discovery-manifest", { timeout: "20 minutes" }, () => (
      persistGermanyBackfillInventory(
        this.env as unknown as Parameters<typeof persistGermanyBackfillInventory>[0],context,inventory,
      )
    ));
    return { schemaVersion: 1, ...persisted, pageCount: inventory.pageCount, requestCount: inventory.requestCount };
  }
}

export class WorldconsBackfillWorkflow extends WorkflowEntrypoint<Env, BackfillWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillWorkflowPayload>, step: WorkflowStep) {
    const payload = parseGermanyBackfillFetchPayload(event.payload);
    if (!payload) throw new Error("case_backfill.invalid_workflow_payload");
    if (payload.fetchContractVersion && payload.fetchContractVersion !== "bverfg-official-fetch-v1") {
      throw new Error("case_backfill.fetch_contract_not_approved");
    }
    const recovery = payload.recoverMissingArtifacts
      ? await step.do("recover-missing-artifacts-for-refetch", {
          timeout: "10 minutes",
        }, async () => {
          try {
            return await recoverGermanyBackfillMissingArtifactsForRefetch(
              this.env as unknown as Parameters<typeof recoverGermanyBackfillMissingArtifactsForRefetch>[0],
              payload.snapshotId,
            );
          } catch (error) {
            throw new NonRetryableError(error instanceof Error ? error.message : String(error));
          }
        })
      : null;
    const maxPasses = payload.maxPasses ?? 1;
    const results: Awaited<ReturnType<typeof runGermanyBackfillFetchPass>>[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const passNumber = payload.passNumber + index;
      const passPayload = { ...payload, passNumber, maxPasses: undefined, recoverMissingArtifacts: undefined };
      const result = await step.do(`run-bounded-backfill-pass-${passNumber}`, {
        timeout: "25 minutes",
      }, async () => {
        try {
          return await runGermanyBackfillFetchPass(
            this.env as unknown as Parameters<typeof runGermanyBackfillFetchPass>[0],
            passPayload,
          );
        } catch (error) {
          throw new NonRetryableError(error instanceof Error ? error.message : String(error));
        }
      });
      results.push(result);
      if (!result.backlogRemaining) break;
    }
    const last = results.at(-1);
    const continuation = planGermanyBackfillContinuation(
      payload,
      last?.passNumber ?? payload.passNumber,
      last?.backlogRemaining ?? true,
    );
    const scheduledContinuation = continuation
      ? await step.do(`schedule-next-fetch-chain-${continuation.payload.passNumber}`, { timeout: "2 minutes" }, async () => {
          const binding = (this.env as Env & { BACKFILL_WORKFLOW: BackfillWorkflowCreateBinding }).BACKFILL_WORKFLOW;
          try {
            await binding.create({ id: continuation.id, params: continuation.payload });
            return { created: true, id: continuation.id, passNumber: continuation.payload.passNumber };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/already exists|already_exists|instance.*exists/i.test(message)) {
              return { created: false, alreadyExists: true, id: continuation.id, passNumber: continuation.payload.passNumber };
            }
            throw error;
          }
        })
      : null;
    return {
      schemaVersion: 1,
      snapshotId: payload.snapshotId,
      recovery,
      startPassNumber: payload.passNumber,
      lastPassNumber: last?.passNumber ?? payload.passNumber,
      completedPasses: results.length,
      batchLimit: payload.batchLimit ?? 1,
      claimed: results.reduce((sum, result) => sum + result.claimed, 0),
      succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
      retryableFailed: results.reduce((sum, result) => sum + result.retryableFailed, 0),
      terminalFailed: results.reduce((sum, result) => sum + result.terminalFailed, 0),
      backlogRemaining: last?.backlogRemaining ?? true,
      autoContinueUntilPass: payload.autoContinueUntilPass ?? null,
      scheduledContinuation,
    };
  }
}

type BackfillNormalizeWorkflowPayload = GermanyBackfillNormalizePayload | string;

export class WorldconsBackfillNormalizeWorkflow extends WorkflowEntrypoint<Env, BackfillNormalizeWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillNormalizeWorkflowPayload>, step: WorkflowStep) {
    const payload = parseGermanyBackfillNormalizePayload(event.payload);
    if (!payload) throw new Error("case_backfill.invalid_normalize_workflow_payload");
    const maxPasses = payload.maxPasses ?? 1;
    const results: Awaited<ReturnType<typeof runGermanyBackfillNormalizePass>>[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const passNumber = payload.passNumber + index;
      const passPayload = { ...payload, passNumber, maxPasses: undefined };
      const result = await step.do(`run-bounded-normalize-pass-${passNumber}`, { timeout: "10 minutes" }, async () => {
        try {
          return await runGermanyBackfillNormalizePass(
            this.env as unknown as Parameters<typeof runGermanyBackfillNormalizePass>[0],
            passPayload,
          );
        } catch (error) {
          throw new NonRetryableError(error instanceof Error ? error.message : String(error));
        }
      });
      results.push(result);
      if (!result.backlogRemaining) break;
    }
    const last = results.at(-1);
    return {
      schemaVersion: 1, snapshotId: payload.snapshotId, startPassNumber: payload.passNumber,
      lastPassNumber: last?.passNumber ?? payload.passNumber, completedPasses: results.length,
      batchLimit: payload.batchLimit ?? 25,
      claimed: results.reduce((sum, result) => sum + result.claimed, 0),
      succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
      retryableFailed: results.reduce((sum, result) => sum + result.retryableFailed, 0),
      terminalFailed: results.reduce((sum, result) => sum + result.terminalFailed, 0),
      backlogRemaining: last?.backlogRemaining ?? true,
    };
  }
}

type BackfillVerifyWorkflowPayload = GermanyBackfillVerifyPayload | string;

export class WorldconsBackfillVerifyWorkflow extends WorkflowEntrypoint<Env, BackfillVerifyWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillVerifyWorkflowPayload>, step: WorkflowStep) {
    const payload = parseGermanyBackfillVerifyPayload(event.payload);
    if (!payload) throw new Error("case_backfill.invalid_verify_workflow_payload");
    const maxPasses = payload.maxPasses ?? 1;
    const results: Awaited<ReturnType<typeof runGermanyBackfillVerifyPass>>[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const passNumber = payload.passNumber + index;
      const result = await step.do(`run-bounded-verify-pass-${passNumber}`, { timeout: "10 minutes" }, async () => {
        try {
          return await runGermanyBackfillVerifyPass(
            this.env as unknown as Parameters<typeof runGermanyBackfillVerifyPass>[0],
            { ...payload, passNumber, maxPasses: undefined },
          );
        } catch (error) {
          throw new NonRetryableError(error instanceof Error ? error.message : String(error));
        }
      });
      results.push(result);
      if (!result.backlogRemaining) break;
    }
    const last = results.at(-1);
    return {
      schemaVersion: 1, snapshotId: payload.snapshotId, startPassNumber: payload.passNumber,
      lastPassNumber: last?.passNumber ?? payload.passNumber, completedPasses: results.length,
      batchLimit: payload.batchLimit ?? 25,
      claimed: results.reduce((sum, result) => sum + result.claimed, 0),
      succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
      retryableFailed: results.reduce((sum, result) => sum + result.retryableFailed, 0),
      terminalFailed: results.reduce((sum, result) => sum + result.terminalFailed, 0),
      backlogRemaining: last?.backlogRemaining ?? true,
    };
  }
}

type BackfillPublishWorkflowPayload = GermanyBackfillPublishPayload | string;

export class WorldconsBackfillPublishWorkflow extends WorkflowEntrypoint<Env, BackfillPublishWorkflowPayload> {
  async run(event: WorkflowEvent<BackfillPublishWorkflowPayload>, step: WorkflowStep) {
    const payload = parseGermanyBackfillPublishPayload(event.payload);
    if (!payload) throw new Error("case_backfill.invalid_publish_workflow_payload");
    const maxPasses = payload.maxPasses ?? 1;
    const results: Awaited<ReturnType<typeof runGermanyBackfillPublishPass>>[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const passNumber = payload.passNumber + index;
      const result = await step.do(`run-bounded-publish-pass-${passNumber}`, { timeout: "10 minutes" }, async () => {
        try {
          return await runGermanyBackfillPublishPass(
            this.env as unknown as Parameters<typeof runGermanyBackfillPublishPass>[0],
            { ...payload, passNumber, maxPasses: undefined },
          );
        } catch (error) {
          throw new NonRetryableError(error instanceof Error ? error.message : String(error));
        }
      });
      results.push(result);
      if (!result.backlogRemaining) break;
    }
    const last = results.at(-1);
    return {
      schemaVersion: 1, snapshotId: payload.snapshotId, startPassNumber: payload.passNumber,
      lastPassNumber: last?.passNumber ?? payload.passNumber, completedPasses: results.length,
      batchLimit: payload.batchLimit ?? 10,
      claimed: results.reduce((sum, result) => sum + result.claimed, 0),
      succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
      retryableFailed: results.reduce((sum, result) => sum + result.retryableFailed, 0),
      terminalFailed: results.reduce((sum, result) => sum + result.terminalFailed, 0),
      backlogRemaining: last?.backlogRemaining ?? true,
    };
  }
}

/**
 * Operator-invokable, administratively-authenticated single-case staged canary
 * Workflow. This is an ALTERNATIVE to the bearer-token `POST /v1/stage-canary`
 * route (which stays fail-closed when `WORLDCONS_CANARY_TOKEN` is unset): it is
 * triggered with `wrangler workflows trigger`, so authorization is the operator's
 * existing Cloudflare account/OAuth scope rather than a Worker Secret.
 *
 * It seeds exactly ONE case (German `de-bverfg` or US `us-scotus`) via the same
 * canonical modules the route uses — `planCanaryCase` (official host/URL identity
 * gating), `seedCanaryCase` (per-source rate limit + immutable audit + explicit
 * `stages/canary/` payload), and `dispatchCanaryCase` (fenced single Crawl Queue
 * dispatch). It never changes source ownership, never publishes, never bypasses
 * review, and never fabricates a seven-stage lineage. Every step is idempotent
 * (`step.do` name + deterministic job key), so a retry cannot duplicate the job,
 * and the returned values are small, serializable, non-secret IDs.
 */
export class WorldconsOperatorCanaryWorkflow extends WorkflowEntrypoint<Env, OperatorCanaryEvent | string> {
  async run(event: WorkflowEvent<OperatorCanaryEvent | string>, step: WorkflowStep) {
    const parsed = parseOperatorCanaryEvent(event.payload);
    if (!parsed.ok) throw new NonRetryableError(parsed.error);
    const payload = parsed.value;

    setRuntimeD1Bindings({
      worldcons_core: this.env.WORLDCONS_CORE,
      worldcons_ingest: this.env.WORLDCONS_INGEST,
      worldcons_search: this.env.WORLDCONS_SEARCH,
      worldcons_ops: this.env.WORLDCONS_OPS,
    });
    const ingestDb = this.env.WORLDCONS_INGEST as unknown as Parameters<typeof seedCanaryCase>[0];

    // ---- Discover-one branch (Germany only; genuine seventh stage) --------
    // Seed a GENUINE `discovery` stage job that fetches the real official BVerfG
    // homepage SSR anchors (never a caller-supplied candidate) and yields exactly
    // ONE child `crawl` job with the same `canary-owner:<canaryId>` provenance.
    // It carries no candidate URL/ECLI, so it can neither fabricate nor masquerade
    // the discovery step. Continuing the chain uses the existing `advance` mode.
    if (payload.payloadKind === "discover-one") {
      const discoveryBinding = (this.env.STAGE_QUEUE_DISCOVERY as unknown as IngestStageQueueSender | undefined);
      const rawBucket = this.env.WORLDCONS_RAW as unknown as Parameters<typeof enqueueCanaryDiscovery>[1];
      // Derive the canary id from the stable workflow instance seed so a replay
      // cannot seed a second case. The `now` used by the actual D1/R2 write is
      // inside the step (also replay-idempotent via the deterministic job key).
      const canaryId = await canaryDiscoveryId(payload.sourceKey, event.instanceId);
      const seeded = await step.do(`discover-one-seed-${payload.sourceKey}-${canaryId}`, { timeout: "2 minutes" }, () =>
        enqueueCanaryDiscovery(ingestDb, rawBucket, {
          sourceKey: payload.sourceKey,
          rangeDays: payload.rangeDays,
          canaryId,
          operatorId: payload.operatorId,
          now: new Date().toISOString(),
        }),
      );
      let dispatch: { dispatched: boolean; enqueued: number; reason: string } | null = null;
      if (payload.dispatch) {
        if (!discoveryBinding) throw new NonRetryableError("operator_canary.discovery_queue_binding_missing");
        dispatch = await step.do(`discover-one-dispatch-${canaryId}`, { timeout: "2 minutes" }, () =>
          dispatchCanaryCase({
            ingestDb,
            queue: discoveryBinding,
            jobId: seeded.jobId,
            canaryId,
            operatorId: payload.operatorId,
            deploymentRef: null,
            stage: "discovery",
            now: new Date().toISOString(),
          }),
        );
      }
      return {
        schemaVersion: 1,
        mode: "discover-one" as const,
        sourceKey: payload.sourceKey,
        canaryId,
        jobId: seeded.jobId,
        created: seeded.created,
        payloadRef: seeded.payloadRef,
        dispatchReason: dispatch?.reason ?? null,
        enqueued: dispatch?.enqueued ?? 0,
        note: "Seeded exactly one genuine official-homepage discovery job (Germany). It yields at most one child crawl job with same-case provenance; continue the chain via the advance mode. It does not publish, bypass review, or change ownership.",
      };
    }

    // ---- Ordinary DE bootstrap branch (Germany only; NON-canary) ----------
    // A bounded one-off that seeds the EXACT ordinary daily discovery job the
    // `0 21 * * *` scheduled bootstrap would (`enqueueIngestStageDiscovery`, the
    // regular `stages/ingest-discovery-request/de-bverfg/...` payload with no
    // canary marker). It first consults the LIVE M8 exclude and staged allowlist
    // from env and requires exact-paired ownership + an enabled Production
    // `discovery` stage; otherwise it fails closed with no side effect. It then
    // optionally dispatches the single ordinary job via the ordinary fenced
    // dispatcher (never the canary-owner path); when dispatch is false the job
    // simply waits for the normal `*/15` dispatcher.
    if (payload.payloadKind === "bootstrap-de-one") {
      const gateForPrecondition = ingestStageGateFromEnvironment(this.env as unknown as Record<string, string | undefined>);
      const precondition = evaluateBootstrapDeOnePrecondition({
        gate: gateForPrecondition,
        stagedAllowlistRaw: this.env.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST,
        m8ExcludeRaw: this.env.M8_CRAWLER_SOURCE_EXCLUDE,
        nativeSources: NATIVE_CRAWLER_SOURCES,
      });
      if (!precondition.ok) throw new NonRetryableError(precondition.reason ?? "bootstrap_de_one.precondition_failed");

      const rawBucket = this.env.WORLDCONS_RAW as unknown as Parameters<typeof enqueueIngestStageDiscovery>[1];
      // The ordinary scheduled bootstrap limit (1 in Production); never widened.
      const bootstrapLimit = boundedStageInteger(this.env.WORLDCONS_INGEST_STAGE_BOOTSTRAP_LIMIT, 1, 1, 20);
      if (bootstrapLimit !== 1) throw new NonRetryableError("bootstrap_de_one.limit_must_equal_one");
      const seeded = await step.do("bootstrap-de-one-seed-de-bverfg", { timeout: "2 minutes" }, () =>
        enqueueIngestStageDiscovery(this.env.WORLDCONS_INGEST, rawBucket, {
          sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY,
          limit: bootstrapLimit,
          now: new Date().toISOString(),
        }),
      );
      let dispatch: { dispatched: boolean; enqueued: number; reason: string } | null = null;
      if (payload.dispatch) {
        const discoveryBinding = (this.env.STAGE_QUEUE_DISCOVERY as unknown as IngestStageQueueSender | undefined);
        if (!discoveryBinding) throw new NonRetryableError("bootstrap_de_one.discovery_queue_binding_missing");
        const leaseSeconds = boundedStageInteger(this.env.WORLDCONS_INGEST_STAGE_LEASE_SECONDS, 300, 30, 3600);
        const pass = await step.do("bootstrap-de-one-dispatch", { timeout: "2 minutes" }, () =>
          dispatchIngestStagePass({
            ingestDb: this.env.WORLDCONS_INGEST,
            queue: discoveryBinding,
            stage: "discovery",
            // Ordinary worker identity: this is NOT a canary-owner dispatch.
            workerId: `bootstrap-de-one:${event.instanceId}`,
            limit: 1,
            leaseSeconds,
            now: new Date().toISOString(),
            jobId: seeded.jobId,
          }),
        );
        dispatch = {
          dispatched: pass.enqueued === 1,
          enqueued: pass.enqueued,
          reason: pass.enqueued === 1 ? "bootstrap_de_one.dispatched" : "bootstrap_de_one.dispatch_no_change",
        };
      }
      return {
        schemaVersion: 1,
        mode: "bootstrap-de-one" as const,
        sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY,
        jobId: seeded.jobId,
        created: seeded.created,
        limit: bootstrapLimit,
        pairedOwnership: true,
        stagedSources: precondition.stagedSources,
        effectiveM8Sources: precondition.effectiveM8Sources,
        dispatchReason: dispatch?.reason ?? null,
        enqueued: dispatch?.enqueued ?? 0,
        note: "Seeded exactly one ORDINARY staged Germany discovery job (no canary marker). The normal */15 dispatcher processes it, or an immediate one-shot dispatch was performed on request. It does not publish, bypass review, or change ownership.",
      };
    }

    // ---- Advance branch ----------------------------------------------------
    // Continue an already-seeded canary by exactly one stage. No source/URL/identity
    // is accepted here; provenance comes only from the durable job row + the
    // stage-advance event. `advanceCanaryCase` dispatches the next job to the
    // correct per-stage queue via the Worker's own bindings.
    if (payload.payloadKind === "advance") {
      const advanced = await step.do(`advance-${payload.canaryId}-${payload.jobId}`, { timeout: "2 minutes" }, () =>
        advanceCanaryCase({
          ingestDb,
          jobId: payload.jobId,
          canaryId: payload.canaryId,
          operatorId: payload.operatorId,
          deploymentRef: null,
          now: new Date().toISOString(),
          queueFor: (stage) => stageQueueSender(this.env, stage),
        }),
      );
      if (!advanced.advanced) {
        throw new NonRetryableError(advanced.reason);
      }
      return {
        schemaVersion: 1,
        mode: "advance" as const,
        jobId: payload.jobId,
        canaryId: payload.canaryId,
        fromStage: advanced.fromStage,
        nextStage: advanced.nextStage,
        nextJobId: advanced.nextJobId,
        sourceKey: advanced.sourceKey,
        dispatched: advanced.dispatched,
        enqueued: advanced.enqueued,
        reason: advanced.reason,
        note: "Advanced exactly one already-succeeded canary job to its next stage. No publish, no review bypass, no ownership change.",
      };
    }

    // ---- Seed branch -------------------------------------------------------
    const rawBucket = this.env.WORLDCONS_RAW as unknown as Parameters<typeof seedCanaryCase>[1];
    const crawlBinding = (this.env.STAGE_QUEUE_CRAWL as unknown as IngestStageQueueSender | undefined);
    if (!crawlBinding) throw new NonRetryableError("operator_canary.crawl_queue_binding_missing");

    // Deterministic step ids from the event identity keep a workflow retry from
    // re-seeding (the job key is idempotent) or double-dispatching (the fence and
    // per-source rate limit make the second attempt a no-op).
    const stepKey = `${payload.sourceKey}:${payload.ecli ?? payload.docket ?? "case"}`;
    const now = new Date().toISOString();

    // Plan and seed in ONE step so only a small, serializable result crosses the
    // step boundary (the full candidate is persisted to R2 by seedCanaryCase).
    // A denied plan is recorded by seedCanaryCase as an immutable audit row and
    // returned with `jobId: null`; it is never retried or fabricated into a job.
    const seed = await step.do(`seed-${payload.sourceKey}-${payload.ecli ?? payload.docket ?? "case"}`, { timeout: "2 minutes" }, () =>
      (async () => {
        const plan = await planCanaryCase(
          {
            sourceKey: payload.sourceKey,
            candidateUrl: payload.candidateUrl,
            identifiers: {
              ...(payload.ecli ? { ecli: payload.ecli } : {}),
              ...(payload.docket ? { docket: payload.docket } : {}),
            },
          },
          { now },
        );
        return seedCanaryCase(ingestDb, rawBucket, plan, {
          operatorId: payload.operatorId,
          deploymentRef: null,
          now,
        });
      })(),
    );
    if (!seed.jobId) {
      return {
        schemaVersion: 1,
        mode: payload.mode,
        stepKey,
        outcome: seed.outcome,
        reason: seed.reason,
        sourceKey: seed.sourceKey,
        canaryId: seed.canaryId,
        enqueued: 0,
        note: "Canary denied at the source/identity gate; an immutable audit row was recorded and no job was seeded.",
      };
    }

    let dispatch: { dispatched: boolean; enqueued: number; reason: string } | null = null;
    if (payload.mode === "seed-and-dispatch") {
      dispatch = await step.do(`dispatch-${seed.canaryId}`, { timeout: "2 minutes" }, () =>
        dispatchCanaryCase({
          ingestDb,
          queue: crawlBinding,
          jobId: seed.jobId as string,
          canaryId: seed.canaryId,
          operatorId: payload.operatorId,
          deploymentRef: null,
          stage: "crawl",
          now,
        }),
      );
    }

    // Only non-secret identifiers/status are returned; never the candidate body,
    // token, or any credential.
    return {
      schemaVersion: 1,
      mode: payload.mode,
      stepKey,
      outcome: seed.outcome,
      reason: seed.reason,
      sourceKey: seed.sourceKey,
      canaryId: seed.canaryId,
      candidateId: seed.candidateId,
      jobId: seed.jobId,
      identityEcli: seed.identityEcli,
      identityDocket: seed.identityDocket,
      enqueued: dispatch?.enqueued ?? 0,
      dispatchReason: dispatch?.reason ?? null,
      note: "Canary seeds and dispatches exactly one staged Crawl job. It does not publish, bypass review, or produce a seven-stage lineage; observe with pnpm audit:canary-lineage.",
    };
  }
}

const STAGE_QUEUE_TO_STAGE: Readonly<Record<string, IngestStage>> = Object.freeze(
  Object.fromEntries(Object.entries(INGEST_STAGE_QUEUES).map(([stage, queue]) => [queue, stage as IngestStage])),
);

const STAGE_TO_QUEUE_BINDING: Readonly<Record<IngestStage, keyof Env>> = Object.freeze({
  discovery: "STAGE_QUEUE_DISCOVERY",
  crawl: "STAGE_QUEUE_CRAWL",
  normalize: "STAGE_QUEUE_NORMALIZE",
  translate: "STAGE_QUEUE_TRANSLATE",
  "public-judgment": "STAGE_QUEUE_PUBLIC_JUDGMENT",
  publish: "STAGE_QUEUE_PUBLISH",
  search: "STAGE_QUEUE_SEARCH",
});

function stageForQueue(queue: string): IngestStage | null {
  return STAGE_QUEUE_TO_STAGE[queue] ?? null;
}

/** The physical stage queue sender for a stage, from the Worker's bindings. */
function stageQueueSender(env: Env, stage: IngestStage): IngestStageQueueSender {
  const bindingName = STAGE_TO_QUEUE_BINDING[stage];
  const binding = env[bindingName] as unknown as IngestStageQueueSender;
  if (!binding) throw new Error(`ingest_stage.queue_binding_missing:${stage}`);
  return binding;
}

function stageCrawlerBindings(env: Env): NativeCrawlerBindings {
  return {
    WORLDCONS_CORE: env.WORLDCONS_CORE as unknown as NativeCrawlerBindings["WORLDCONS_CORE"],
    WORLDCONS_INGEST: env.WORLDCONS_INGEST as unknown as NativeCrawlerBindings["WORLDCONS_INGEST"],
    WORLDCONS_RAW: env.WORLDCONS_RAW as unknown as NativeCrawlerBindings["WORLDCONS_RAW"],
  };
}

/**
 * Builds the per-stage handler registry for this Worker invocation. Only the
 * stages with a real implementation are registered; `translate`,
 * `public-judgment`, `publish` and `search` stay absent (fail closed) until a
 * real translation / publication / projection adapter is provided. The consumer
 * then blocks those stages explicitly instead of faking completion.
 */
/**
 * The `worldcons` Worker's `WorldconsOpsService` methods the staged handlers
 * call per item. Every method is scoped to exactly one article id.
 */
interface WorldconsOpsStageService {
  runSummaryArticle(input: { articleId: string; model?: string }): Promise<{
    result?: { status?: "summarized" | "failed" | "skipped"; retryable?: boolean; errorMessage?: string; reason?: string };
  }>;
  runPublishArticle(input: { articleId: string; actorId?: string }): Promise<{
    published: boolean;
    skippedReason?: "not_found" | "ineligible" | null;
    versionId?: string | null;
    state?: string | null;
  }>;
  runProjectArticle(input: { articleId: string }): Promise<{ desiredEligible: boolean; documentCount: number; ftsCount: number }>;
}

/**
 * Builds the per-stage handler registry for this Worker invocation.
 *
 * `discovery`/`crawl`/`normalize` reuse the audited native crawler path.
 * `translate`/`publish`/`search` are backed by the `worldcons` Worker service
 * binding, which runs the real per-item `runSummaryArticle`, per-article P3
 * publication and per-article search projection — never a whole-queue drain.
 * `public-judgment` is a local fail-closed authority gate over the core DB.
 * A stage whose adapter is genuinely absent stays unregistered so the consumer
 * fails closed rather than faking completion.
 */
function ingestStageHandlersFor(env: Env): IngestStageHandlerRegistry {
  const appService = env.WORLDCONS_APP_SERVICE as unknown as WorldconsOpsStageService;
  return createIngestStageHandlers({
    e2e: stagedE2EOptionsFromEnvironment(env as unknown as E2ESearchConsumerEnvironment & {WORLDCONS_SEARCH:Env["WORLDCONS_SEARCH"]}),
    // Explicit operator-canary sources carry the candidate/artifact reference
    // across stages so one German/US case can complete a seven-stage lineage.
    // They never gain FR/ES auto-approval; every gate stays fail-closed.
    canarySources: [...CANARY_SOURCE_KEYS],
    crawlerBindings: stageCrawlerBindings(env),
    rawBucket: env.WORLDCONS_RAW as unknown as Parameters<typeof createIngestStageHandlers>[0]["rawBucket"],
    browserNavigate: (input) => browserNavigate(input, env.BROWSER),
    translation: {
      async summarize(articleId) {
        const response = await appService.runSummaryArticle({ articleId });
        const result = response?.result;
        const status = result?.status;
        if (status === "summarized") return { status: "summarized" };
        if (status === "skipped") return { status: "skipped", errorCode: "ingest_stage.translate_skipped", errorSummary: result?.reason ?? null };
        if (status === "failed") return { status: "failed", retryable: result?.retryable, errorCode: "ingest_stage.translate_failed", errorSummary: result?.errorMessage ?? null };
        // An unrecognised response is treated as an unavailable service, not a
        // success; the caller then fails closed instead of fabricating work.
        return { status: "unavailable", errorCode: "ingest_stage.translate_unavailable", errorSummary: "Summary service returned no recognized result." };
      },
    },
    publication: {
      async publish(articleId) {
        const response = await appService.runPublishArticle({ articleId, actorId: "ingest-stage-publish" });
        if (!response.published) return { published: false, skippedReason: response.skippedReason ?? "ineligible" };
        return { published: true, versionId: response.versionId ?? null, state: response.state ?? null };
      },
    },
    search: {
      async project(articleId) {
        const response = await appService.runProjectArticle({ articleId });
        if (!response.desiredEligible) {
          return { projected: false, errorCode: "ingest_stage.search_article_not_eligible", errorSummary: "Article is not an eligible published search source." };
        }
        return { projected: true, documentCount: response.documentCount, ftsCount: response.ftsCount };
      },
    },
  });
}

function boundedStageInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * The staged-pipeline scheduled tick. It is a no-op unless the stage rollout
 * gate explicitly enables at least one stage (default OFF). When enabled it:
 *   1. reconciles bounded pending dispatch-outbox rows (a crash between the D1
 *      commit and the Queue send is replayed here), then
 *   2. runs one bounded dispatch pass per enabled stage.
 *
 * It never completes a job and never touches the legacy M8 path.
 */
async function runIngestStageScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const gate = ingestStageGateFromEnvironment(env as unknown as Record<string, string | undefined>);
  const enabled = INGEST_STAGE_NAMES.filter((stage) => isIngestStageEnabled(gate, stage));
  if (enabled.length === 0) return;
  setRuntimeD1Bindings({
    worldcons_core: env.WORLDCONS_CORE,
    worldcons_ingest: env.WORLDCONS_INGEST,
    worldcons_ops: env.WORLDCONS_OPS,
    worldcons_search: env.WORLDCONS_SEARCH,
  });
  const now = new Date(controller.scheduledTime).toISOString();
  const limit = boundedStageInteger(env.WORLDCONS_INGEST_STAGE_DISPATCH_LIMIT, 25, 1, 100);
  const leaseSeconds = boundedStageInteger(env.WORLDCONS_INGEST_STAGE_LEASE_SECONDS, 300, 30, 3600);
  const workerId = `worldcons-ingest:${controller.cron}:${now}`;
  try {
    const reconciliation = await reconcileIngestStageDispatch({
      ingestDb: env.WORLDCONS_INGEST,
      queueFor: (stage) => stageQueueSender(env, stage),
      limit: Math.min(limit * 4, 200),
      now,
    });
    const passes = [];
    for (const stage of enabled) {
      passes.push(await dispatchIngestStagePass({
        ingestDb: env.WORLDCONS_INGEST,
        queue: stageQueueSender(env, stage),
        stage,
        workerId,
        limit,
        leaseSeconds,
        now,
      }));
    }
    console.log(JSON.stringify({ event: "ingest_stage_dispatch", cron: controller.cron, reconciliation, passes }));
  } catch (error) {
    console.error(JSON.stringify({ event: "ingest_stage_dispatch_failed", cron: controller.cron, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
  }
}

/**
 * Seeds durable discovery jobs for the configured sources. Runs only on the
 * dedicated stage-bootstrap cron and only when the `discovery` stage is enabled.
 * The dispatcher then fans the actual crawl work out; this function performs no
 * network collection itself.
 */
async function runIngestStageDiscoveryBootstrap(controller: ScheduledController, env: Env): Promise<void> {
  const gate = ingestStageGateFromEnvironment(env as unknown as Record<string, string | undefined>);
  if (!isIngestStageEnabled(gate, "discovery")) return;
  const now = new Date(controller.scheduledTime).toISOString();
  try {
    const enqueued: Array<{ sourceKey: string; created: boolean }> = [];
    const rawBucket = env.WORLDCONS_RAW as unknown as Parameters<typeof enqueueIngestStageDiscovery>[1];
    const allowedSources = resolveIngestBootstrapSources(
      env.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST,
      NATIVE_CRAWLER_SOURCES,
    );
    const bootstrapLimit = boundedStageInteger(env.WORLDCONS_INGEST_STAGE_BOOTSTRAP_LIMIT, 1, 1, 20);
    for (const sourceKey of allowedSources) {
      const { created } = await enqueueIngestStageDiscovery(env.WORLDCONS_INGEST, rawBucket, {
        sourceKey: sourceKey as NativeCrawlerSource,
        limit: bootstrapLimit,
        now,
      });
      enqueued.push({ sourceKey, created });
    }
    console.log(JSON.stringify({ event: "ingest_stage_discovery_bootstrap", cron: controller.cron, sourceAllowlistCount: allowedSources.length, bootstrapLimit, enqueued }));
  } catch (error) {
    console.error(JSON.stringify({ event: "ingest_stage_discovery_bootstrap_failed", cron: controller.cron, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const policy = gate(env);
      const stageGate = ingestStageGateFromEnvironment(env as unknown as Record<string, string | undefined>);
      const crawlerSourcePolicy = resolveM8CrawlerSourcePolicy(env.M8_CRAWLER_SOURCE_EXCLUDE, NATIVE_CRAWLER_SOURCES);
      return json({
        schemaVersion: 1,
        service: "worldcons-ingest",
        schedulerEnabled: policy.schedulerEnabled,
        enabledKinds: policy.policy.kinds,
        enabledKindsAny: policy.policy.any,
        enabledKindsValid: policy.policy.valid,
        enabledKindsReason: policy.policy.reason ?? null,
        crawlerSourceOwnership: {
          nativeSources: [...NATIVE_CRAWLER_SOURCES],
          effectiveSources: crawlerSourcePolicy.effective,
          excludedSources: crawlerSourcePolicy.excluded,
          valid: crawlerSourcePolicy.valid,
          reason: crawlerSourcePolicy.reason ?? null,
        },
        browserNavigate: true,
        browserRpc: true,
        ingestStages: {
          enabled: stageGate.masterEnabled && stageGate.productionEnvironment && stageGate.policy.valid,
          stages: stageGate.policy.valid ? stageGate.policy.stages : [],
          bootstrapSources: resolveIngestBootstrapSources(env.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST, NATIVE_CRAWLER_SOURCES),
          bootstrapLimit: boundedStageInteger(env.WORLDCONS_INGEST_STAGE_BOOTSTRAP_LIMIT, 1, 1, 20),
          dispatchLimit: boundedStageInteger(env.WORLDCONS_INGEST_STAGE_DISPATCH_LIMIT, 25, 1, 100),
        },
      });
    }
    // Authenticated Browser Rendering transport, merged in from the retired
    // standalone `worldcons-browser-run` Worker. The existing Node/GitHub
    // crawler caller only needs this bearer-protected POST route.
    if (request.method === "POST" && url.pathname === "/v1/navigate") {
      return handleBrowserNavigate(request, env);
    }
    // Authenticated operator single-case staged canary (Germany/US). Guarded by
    // the same operator bearer secret as `/v1/navigate`; fail-closed when unset.
    if (request.method === "POST" && url.pathname === "/v1/stage-canary") {
      return handleStageCanary(
        request,
        env as unknown as Parameters<typeof handleStageCanary>[1],
      );
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env) {
    // Staged-ingestion pipeline entries. These are ownership-separated from the
    // M8 gate: they are no-ops unless the stage rollout gate (default OFF)
    // enables the relevant stage, and they never complete a job or touch the
    // legacy M8 path. The frequent cron drives dispatch/reconciliation; the
    // daily crawler cron seeds discovery requests.
    if (controller.cron === "* * * * *") {
      await runE2ESearchRepairScheduled(env as unknown as E2ESearchRepairEnvironment);
      await runDiscoveryCoverageScheduled(env as unknown as DiscoveryCoverageEnvironment);
      try { console.log(JSON.stringify({event:"search_metadata_drain",...await drainSearchMetadataRepairs(env)})); }
      catch(error) { console.error(JSON.stringify({event:"search_metadata_drain_failed",error:String(error).slice(0,200)})); }
      return; // Dedicated tick must never fan out legacy M8 work.
    }
    if (controller.cron === "*/15 * * * *") {
      await runIngestStageScheduled(controller, env);
    }
    if (controller.cron === "0 21 * * *") {
      await runIngestStageDiscoveryBootstrap(controller, env);
    }
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
    if (batch.queue===E2E_SEARCH_REPAIR_QUEUE_NAME) {
      await consumeE2ESearchRepairBatch(batch.messages,env as unknown as E2ESearchConsumerEnvironment);
      return;
    }
    const stage = stageForQueue(batch.queue);
    if (stage) {
      const stagedSources = resolveIngestBootstrapSources(env.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST, NATIVE_CRAWLER_SOURCES);
      await consumeIngestStageBatch(batch, {
        gate: ingestStageGateFromEnvironment(env as unknown as Record<string, string | undefined>),
        ingestDb: env.WORLDCONS_INGEST as unknown as Parameters<typeof consumeIngestStageBatch>[1]["ingestDb"],
        coreDb: env.WORLDCONS_CORE as unknown as Parameters<typeof consumeIngestStageBatch>[1]["coreDb"],
        now: new Date().toISOString(),
        handlers: ingestStageHandlersFor(env),
        env,
        invalidRetryDelaySeconds: M8_INVALID_RETRY_DELAY_SECONDS,
        // Keep the broad source-ownership split intact: a non-staged source is
        // only fetched through the explicit single-case canary prefix.
        sourceGate: ({ stage: jobStage, sourceKey, payloadRef }) =>
          canarySourceGateAllows({ stage: jobStage, sourceKey, payloadRef, stagedSources }),
      });
      return;
    }
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
