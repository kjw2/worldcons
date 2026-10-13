/**
 * Authenticated operator stage-canary route for the `worldcons-ingest` Worker.
 *
 * `POST /v1/stage-canary` seeds exactly one bounded staged crawl job for a
 * single German (`de-bverfg`) or United States (`us-scotus`) case, using a
 * **dedicated** operator secret (`WORLDCONS_CANARY_TOKEN`). It deliberately:
 *
 * - requires the configured dedicated bearer secret (fail-closed 401 when unset);
 * - accepts only a single case request with an explicit official identifier;
 * - verifies the official host and URL identity before seeding;
 * - reads the configured staged source allowlist and enforces the per-source
 *   canary gate, so a non-staged source is only ever fetched via the explicit
 *   `stages/canary/` exception;
 * - never changes ownership, never publishes, and writes an immutable audit row.
 *
 * The route is intentionally absent from `/health` and does no listing. It uses
 * its own dedicated secret rather than the unrelated browser-transport token, so
 * provisioning the canary token never activates the browser route.
 */
import { resolveIngestBootstrapSources } from "../../../lib/cloudflare/ingest-stages/flags";
import {
  advanceCanaryCase,
  dispatchCanaryCase,
  planCanaryCase,
  seedCanaryCase,
  type CanaryRawBucket,
} from "../../../lib/cloudflare/ingest-stages/canary";
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import type { IngestStageQueueSender } from "../../../lib/cloudflare/ingest-stages/dispatcher";
import { NATIVE_CRAWLER_SOURCES } from "./native-crawler";
import { operatorCanaryAuthorized } from "./worker-auth";

export interface StageCanaryEnv {
  WORLDCONS_INGEST: unknown;
  WORLDCONS_RAW: CanaryRawBucket;
  STAGE_QUEUE_CRAWL: unknown;
  WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST?: string;
  WORLDCONS_CANARY_TOKEN?: string;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

interface CanaryBody {
  sourceKey?: unknown;
  candidateUrl?: unknown;
  ecli?: unknown;
  docket?: unknown;
  title?: unknown;
  operatorId?: unknown;
  dispatch?: unknown;
  jobId?: unknown;
  canaryId?: unknown;
  advance?: unknown;
}

export async function handleStageCanary(request: Request, env: StageCanaryEnv): Promise<Response> {
  if (!(await operatorCanaryAuthorized(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.WORLDCONS_INGEST || !env.WORLDCONS_RAW || !env.STAGE_QUEUE_CRAWL) {
    return json({ error: "Canary bindings are unavailable." }, 503);
  }

  const body = (await request.json().catch(() => null)) as CanaryBody | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid canary request body." }, 400);
  }
  const operatorId = typeof body.operatorId === "string" ? body.operatorId.trim() : "";
  if (!operatorId) {
    return json({ error: "An operatorId is required for the immutable canary audit record." }, 400);
  }
  const now = new Date().toISOString();
  const ingestDb = env.WORLDCONS_INGEST as D1RuntimeDatabase;

  // Optional bounded next-stage advance: requires the exact canary provenance of
  // an already-succeeded canary job. This never seeds and never changes ownership.
  if (body.advance === true) {
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const canaryId = typeof body.canaryId === "string" ? body.canaryId.trim() : "";
    if (!jobId || !canaryId) {
      return json({ error: "advance requires both jobId and canaryId." }, 400);
    }
    const advance = await advanceCanaryCase({ ingestDb, jobId, canaryId, operatorId, deploymentRef: null, now });
    return json({ ...advance }, advance.advanced ? 200 : 409);
  }

  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey.trim() : "";
  const candidateUrl = typeof body.candidateUrl === "string" ? body.candidateUrl.trim() : "";

  const plan = await planCanaryCase(
    {
      sourceKey,
      candidateUrl,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      identifiers: {
        ...(typeof body.ecli === "string" ? { ecli: body.ecli } : {}),
        ...(typeof body.docket === "string" ? { docket: body.docket } : {}),
      },
    },
    { now },
  );

  const seed = await seedCanaryCase(ingestDb, env.WORLDCONS_RAW, plan, {
    operatorId,
    deploymentRef: null,
    now,
  });
  if (!seed.jobId) {
    return json({ outcome: seed.outcome, reason: seed.reason, sourceKey: seed.sourceKey, canaryId: seed.canaryId }, 200);
  }

  let dispatch: { dispatched: boolean; enqueued: number; reason: string } | null = null;
  if (body.dispatch === true) {
    dispatch = await dispatchCanaryCase({
      ingestDb,
      queue: env.STAGE_QUEUE_CRAWL as IngestStageQueueSender,
      jobId: seed.jobId,
      canaryId: seed.canaryId,
      operatorId,
      deploymentRef: null,
      stage: "crawl",
      now,
    });
  }

  // Surface the configured staged sources so the operator can see the canary is
  // a deliberate, non-staged exception (never a source widening).
  const stagedSources = resolveIngestBootstrapSources(env.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST, NATIVE_CRAWLER_SOURCES);
  return json(
    {
      outcome: seed.outcome,
      reason: seed.reason,
      sourceKey: seed.sourceKey,
      canaryId: seed.canaryId,
      candidateId: seed.candidateId,
      jobId: seed.jobId,
      created: seed.created,
      identityEcli: seed.identityEcli,
      identityDocket: seed.identityDocket,
      stagedSources,
      staged: seed.sourceKey ? stagedSources.includes(seed.sourceKey) : false,
      dispatch,
    },
    202,
  );
}
