/**
 * WorldCons staged ingestion pipeline — runtime-neutral stable contract (M0).
 *
 * The user-approved architecture replaces the single monolithic collection /
 * translation / publication path with a per-stage durable job pipeline:
 *
 *   discovery -> crawl -> normalize -> translate -> public-judgment -> publish
 *     -> search
 *
 * Each stage is a durable row in `worldcons_ingest.ingest_stage_jobs` (the
 * source of truth) plus a Cloudflare Queue message that only carries IDs.
 * Physical D1 databases cannot share a transaction, so any operation that spans
 * two databases (a job that changes stage, or an ingest -> core bridge) is
 * expressed as two independent, idempotent steps that are safe to replay.
 *
 * This module is deliberately free of Node builtins, Cloudflare runtime types
 * and any database client so both the Next.js app and the `worldcons-ingest`
 * Worker can import it. Everything here is pure.
 *
 * Feature flags default OFF: the new path never runs unless an operator opts in
 * (see `lib/cloudflare/ingest-stages/flags.ts`). The legacy processing path is
 * left untouched and the new path is ownership-separated by `idempotency_key`
 * so the two never double-process the same article.
 */

export const INGEST_STAGE_SCHEMA_VERSION = 1 as const;

/**
 * The ordered processing stages. `discovery` is the entry point that registers
 * a candidate for collection; every later stage consumes the previous stage's
 * durable job and produces the next one.
 */
export const INGEST_STAGE_NAMES = [
  "discovery",
  "crawl",
  "normalize",
  "translate",
  "public-judgment",
  "publish",
  "search",
] as const;

export type IngestStage = (typeof INGEST_STAGE_NAMES)[number];

/**
 * Durable stage-job states. The lease fields (`claimed_by`, `lease_expires_at`,
 * `fencing_token`) make the dispatcher/consumer pair crash-safe: only the
 * holder of the current fencing token may complete a job.
 */
export const INGEST_STAGE_JOB_STATUSES = [
  "pending",
  "leased",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;

export type IngestStageJobStatus = (typeof INGEST_STAGE_JOB_STATUSES)[number];

/**
 * A job is *claimable* when it is freshly pending or when a previous lease has
 * expired. `expired` is not stored: it is derived from `status='leased'` plus a
 * `lease_expires_at` in the past, so the dispatcher's index query stays stable.
 */
export const INGEST_STAGE_CLAIMABLE_STATUSES = ["pending", "leased"] as const;

/** Per-stage queue name suffix. The physical queues live in `wrangler.jsonc`. */
export const INGEST_STAGE_QUEUES: Readonly<Record<IngestStage, string>> = {
  discovery: "worldcons-stage-discovery-v1",
  crawl: "worldcons-stage-crawl-v1",
  normalize: "worldcons-stage-normalize-v1",
  translate: "worldcons-stage-translate-v1",
  "public-judgment": "worldcons-stage-public-judgment-v1",
  publish: "worldcons-stage-publish-v1",
  search: "worldcons-stage-search-v1",
};

/** The next stage a job transitions to after it succeeds, or `null` at the end. */
export const INGEST_STAGE_NEXT: Readonly<Record<IngestStage, IngestStage | null>> = {
  discovery: "crawl",
  crawl: "normalize",
  normalize: "translate",
  translate: "public-judgment",
  "public-judgment": "publish",
  publish: "search",
  search: null,
};

/** The stage whose consumer runs in the main `worldcons` Worker (existing path). */
export const INGEST_STAGE_TRANSLATE_OWNER = "worldcons" as const;

export function isIngestStage(value: unknown): value is IngestStage {
  return typeof value === "string" && (INGEST_STAGE_NAMES as readonly string[]).includes(value);
}

export function isIngestStageJobStatus(value: unknown): value is IngestStageJobStatus {
  return typeof value === "string" && (INGEST_STAGE_JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * The idempotency key contract: `(articleId, stage, sourceVersion, contentHash)`.
 *
 * A stable, deterministic identity means a redelivered Queue message, a
 * dispatcher retry or a manual replay all resolve to the *same* durable job row
 * via `unique(idempotency_key)`, so no stage can ever double-process one
 * article/version/content combination.
 *
 * `discovery` registers a candidate that has no source version yet; callers pass
 * the discovered `sourceVersion` (for example a discovered-date hint) and the
 * `contentHash` of the discovery evidence.
 */
export interface IngestStageIdempotencyKeyInput {
  articleId: string;
  stage: IngestStage;
  sourceVersion: string;
  contentHash: string;
}

const KEY_SEPARATOR = "\u001f";
const KEY_PREFIX = "ingest-stage";

/**
 * Builds the canonical idempotency key. The separator is a unit separator so a
 * field containing `:` or `|` can never collide with a neighbouring field.
 */
export function buildIngestStageIdempotencyKey(input: IngestStageIdempotencyKeyInput): string {
  return [
    KEY_PREFIX,
    input.articleId,
    input.stage,
    input.sourceVersion,
    input.contentHash,
  ].join(KEY_SEPARATOR);
}

/** Parses an idempotency key back into its fields, or `null` when malformed. */
export function parseIngestStageIdempotencyKey(key: string): IngestStageIdempotencyKeyInput | null {
  const parts = key.split(KEY_SEPARATOR);
  if (parts.length !== 5 || parts[0] !== KEY_PREFIX) return null;
  const [, articleId, stage, sourceVersion, contentHash] = parts;
  if (!articleId || !isIngestStage(stage) || sourceVersion.length === 0 || contentHash.length === 0) return null;
  return { articleId, stage, sourceVersion, contentHash };
}

/**
 * The Queue message body. It carries IDs, the idempotency key and the *fencing
 * token* of the exact dispatcher lease that produced it — never a large payload;
 * R2 holds the document bodies (plan section 10.1). The `jobId` lets a consumer
 * re-read the durable row (the source of truth) before doing anything, and the
 * `fencingToken` lets it prove exclusive ownership: a consumer may only complete
 * the job while the row is still leased under this exact token. A stale message
 * from a superseded (expired-lease) attempt therefore cannot complete work.
 */
export interface IngestStageQueueMessage {
  schemaVersion: typeof INGEST_STAGE_SCHEMA_VERSION;
  stage: IngestStage;
  jobId: string;
  idempotencyKey: string;
  articleId: string;
  sourceVersion: string;
  contentHash: string;
  /** The `claimed_fencing_token` of the dispatcher lease that enqueued this message. */
  fencingToken: string;
  /** ISO-8601 time the dispatcher enqueued the message. */
  enqueuedAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Validates a Queue message body. Any malformed payload is rejected (the
 * consumer retries it toward the DLQ), and a message whose `idempotencyKey`
 * does not match its own fields is rejected as forged.
 */
export function isIngestStageQueueMessage(value: unknown): value is IngestStageQueueMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<IngestStageQueueMessage>;
  if (candidate.schemaVersion !== INGEST_STAGE_SCHEMA_VERSION) return false;
  if (!isIngestStage(candidate.stage)) return false;
  if (!isNonEmptyString(candidate.jobId)) return false;
  if (!isNonEmptyString(candidate.idempotencyKey)) return false;
  if (!isNonEmptyString(candidate.articleId)) return false;
  if (!isNonEmptyString(candidate.sourceVersion)) return false;
  if (!isNonEmptyString(candidate.contentHash)) return false;
  if (!isNonEmptyString(candidate.fencingToken)) return false;
  if (!isIsoInstant(candidate.enqueuedAt)) return false;
  const expected = buildIngestStageIdempotencyKey({
    articleId: candidate.articleId,
    stage: candidate.stage,
    sourceVersion: candidate.sourceVersion,
    contentHash: candidate.contentHash,
  });
  return expected === candidate.idempotencyKey;
}

/** Builds a validated Queue message body from durable job fields. */
export function buildIngestStageQueueMessage(input: {
  stage: IngestStage;
  jobId: string;
  articleId: string;
  sourceVersion: string;
  contentHash: string;
  fencingToken: string;
  enqueuedAt: string;
}): IngestStageQueueMessage {
  if (!isIsoInstant(input.enqueuedAt)) throw new Error("ingest_stage.invalid_enqueued_at");
  if (!isNonEmptyString(input.fencingToken)) throw new Error("ingest_stage.invalid_fencing_token");
  return {
    schemaVersion: INGEST_STAGE_SCHEMA_VERSION,
    stage: input.stage,
    jobId: input.jobId,
    articleId: input.articleId,
    sourceVersion: input.sourceVersion,
    contentHash: input.contentHash,
    fencingToken: input.fencingToken,
    idempotencyKey: buildIngestStageIdempotencyKey({
      articleId: input.articleId,
      stage: input.stage,
      sourceVersion: input.sourceVersion,
      contentHash: input.contentHash,
    }),
    enqueuedAt: input.enqueuedAt,
  };
}

/** Cloudflare Workflow / Queue id must be safe and bounded. */
export const INGEST_STAGE_MESSAGE_ID_MAX_LENGTH = 100 as const;

export async function ingestStageQueueMessageId(message: IngestStageQueueMessage): Promise<string> {
  // Truncating the *prefix* of the idempotency key caused distinct revisions
  // (and different discovery days) to share one physical Queue/outbox ID.
  // Hash the COMPLETE key; this runs in Workers and in Node without node:crypto.
  const bytes = new TextEncoder().encode(message.idempotencyKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return "stage-" + message.stage + "-" + hex;
}

/**
 * How many dispatcher passes are allowed before a job is dead-lettered. Bounds
 * a poisoned job so it cannot spin forever.
 */
export const INGEST_STAGE_MAX_ATTEMPTS = 8 as const;
