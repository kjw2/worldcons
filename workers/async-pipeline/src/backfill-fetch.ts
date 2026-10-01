import { createHash } from "node:crypto";
import { load } from "cheerio";
import { d1AdminCommandRepository } from "../../../lib/admin/command-control-plane/d1-repository";
import { canonicalJson } from "../../../lib/backfill/canonical-json";
import { d1CaseBackfillRepository } from "../../../lib/backfill/d1-repository";
import type { CaseBackfillAttemptAuthority, CaseBackfillClaimedItem } from "../../../lib/backfill/types";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";

export const GERMANY_2023_BACKFILL_SNAPSHOT_ID = "57948d51-1300-4ff1-86db-be00a6572bc9";
const FETCH_CONTRACT_VERSION = "bverfg-official-fetch-v1";
const SOURCE_POLICY_VERSION = "bverfg-unattended-canary-v2";
const SOURCE_KEY = "de-bverfg";

export interface GermanyBackfillFetchPayload {
  snapshotId: string;
  phase: "fetch";
  passNumber: number;
  batchLimit?: number;
  fetchContractVersion?: string;
  requestedBy?: string;
}

export function parseGermanyBackfillFetchPayload(value: unknown): GermanyBackfillFetchPayload | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const payload = candidate as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["snapshotId", "phase", "passNumber", "batchLimit", "fetchContractVersion", "requestedBy"].includes(key))) return null;
  if (
    typeof payload.snapshotId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.snapshotId)
    || payload.phase !== "fetch"
    || !Number.isInteger(payload.passNumber)
    || Number(payload.passNumber) < 1
    || Number(payload.passNumber) > 2_147_483_647
    || (payload.batchLimit !== undefined && (!Number.isInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 10))
    || (payload.fetchContractVersion !== undefined && (typeof payload.fetchContractVersion !== "string" || payload.fetchContractVersion.trim().length < 1 || payload.fetchContractVersion.length > 120))
    || (payload.requestedBy !== undefined && (typeof payload.requestedBy !== "string" || payload.requestedBy.trim().length < 1 || payload.requestedBy.length > 160))
  ) return null;
  return payload as unknown as GermanyBackfillFetchPayload;
}

export interface GermanyBackfillFetchEnv {
  WORLDCONS_OPS: D1RuntimeDatabase;
  WORLDCONS_CORE: D1RuntimeDatabase;
  WORLDCONS_INGEST: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  CASE_CATALOG_GERMANY_HISTORY_ENABLED?: string;
}

interface ExecutorDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function retryable(error: unknown) {
  return /timeout|network|fetch|429|502|503|504|rate|unresolved/i.test(errorText(error));
}

function boundedErrorCode(error: unknown) {
  const value = errorText(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "case_backfill.fetch_failed";
}

function boundedErrorSummary(error: unknown) {
  return errorText(error).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

async function queryRows<T extends Record<string, unknown>>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "case_backfill.workflow_d1_read_failed");
  }
  return result.results;
}

function officialDecisionUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["www.bundesverfassungsgericht.de", "www.bverfg.de"].includes(url.hostname.toLowerCase())
      && /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/[a-z]{2}\d{8}_[a-z0-9]+\.html$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function candidateUrls(item: CaseBackfillClaimedItem) {
  const candidates = stringArray(item.inventoryMetadata.officialUrlCandidates).filter(officialDecisionUrl);
  if (officialDecisionUrl(item.discoveredUrl)) candidates.unshift(item.discoveredUrl);
  return [...new Set(candidates)];
}

function htmlText(html: string) {
  const $ = load(html);
  $("script,style,noscript,svg").remove();
  for (const selector of ["main", "article", "#pagemaindiv", ".c-detail", ".content", "#content", "body"]) {
    const value = $(selector).first().text().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (value.length > 200) return value;
  }
  return $("body").text().replace(/\s+/g, " ").trim();
}

function htmlTitle(html: string) {
  const $ = load(html);
  return $("h1").first().text().replace(/\s+/g, " ").trim()
    || $("title").first().text().replace(/\s+/g, " ").trim()
    || undefined;
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function heartbeat(authority: CaseBackfillAttemptAuthority) {
  const result = await d1AdminCommandRepository.heartbeat(authority.attemptId, authority.fencingToken, 900);
  if (!result.ok) throw new Error(`case_backfill.${result.error.code}`);
  authority.leaseExpiresAt = result.data.leaseExpiresAt;
}

async function permit(
  snapshotId: string,
  authority: CaseBackfillAttemptAuthority,
  origin: string,
  sleepImpl: (milliseconds: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await heartbeat(authority);
    const result = await d1CaseBackfillRepository.acquireSourceRequestPermit({
      snapshotId,
      phase: "fetch",
      authority,
      requestOrigin: origin,
      requestedLeaseSeconds: 90,
    });
    if (result.granted && result.permitId) return result.permitId;
    await sleepImpl(Math.max(25, Math.min(result.retryAfterMs || 1_000, 5_000)));
  }
  throw new Error("case_backfill.request_permit_wait_exhausted");
}

async function governedRequest(
  snapshotId: string,
  authority: CaseBackfillAttemptAuthority,
  initialUrl: string,
  fetchImpl: typeof fetch,
  sleepImpl: (milliseconds: number) => Promise<void>,
) {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const parsed = new URL(current);
    const permitId = await permit(snapshotId, authority, parsed.origin, sleepImpl);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "WorldCons/1.0 (+https://worldcons.cclib.workers.dev)",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de,en;q=0.8",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } finally {
      await d1CaseBackfillRepository.releaseSourceRequestPermit({ permitId, authority });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("case_backfill.bverfg_redirect_missing_location");
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("case_backfill.bverfg_redirect_limit");
}

async function fetchOfficialDecision(
  item: CaseBackfillClaimedItem,
  snapshotId: string,
  authority: CaseBackfillAttemptAuthority,
  fetchImpl: typeof fetch,
  sleepImpl: (milliseconds: number) => Promise<void>,
) {
  const candidates = candidateUrls(item);
  if (candidates.length === 0) throw new Error("case_backfill.bverfg_official_url_unresolved");
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const { response, finalUrl } = await governedRequest(snapshotId, authority, candidate, fetchImpl, sleepImpl);
      if (response.status === 404) {
        lastError = new Error("case_backfill.bverfg_official_candidate_404");
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`case_backfill.bverfg_http_${response.status}`);
      if (!response.ok) {
        lastError = new Error(`case_backfill.bverfg_http_${response.status}`);
        continue;
      }
      if (!officialDecisionUrl(finalUrl)) throw new Error("case_backfill.bverfg_authority_url_invalid");
      const html = await response.text();
      const extracted = htmlText(html);
      if (extracted.length < 200) throw new Error("case_backfill.bverfg_source_text_too_short");
      const decisionDate = text(item.inventoryMetadata.decisionDate) || item.decisionDateHint?.slice(0, 10) || "";
      const raw = {
        sourceKey: SOURCE_KEY,
        url: finalUrl,
        canonicalUrl: finalUrl,
        title: htmlTitle(html),
        publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(decisionDate) ? `${decisionDate}T00:00:00.000Z` : undefined,
        contentType: "decision",
        text: extracted,
        metadata: {
          ...(item.sourceRecordId ? { sourceRecordId: item.sourceRecordId } : {}),
          sourceInventory: item.inventoryMetadata,
          sourceEtag: response.headers.get("etag") ?? undefined,
          sourceLastModifiedAt: response.headers.get("last-modified") ?? undefined,
          collection: {
            strategy: "fetch",
            confidence: "high",
            sourceUrlVerified: true,
            publishable: extracted.length >= 500,
            sourceTextAvailable: extracted.length >= 500,
          },
          contentTypeHeader: response.headers.get("content-type") ?? undefined,
          extraction: "cheerio-backfill-d1",
        },
      };
      return raw;
    } catch (error) {
      if (retryable(error)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("case_backfill.bverfg_authority_fetch_failed");
}

function boundedReplayPayload(raw: Record<string, unknown>, allowedFields: string[], inventoryMetadata: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(field)) continue;
    if (raw[field] !== undefined) payload[field] = raw[field];
  }
  const metadata = record(payload.metadata);
  payload.metadata = { ...metadata, sourceInventory: inventoryMetadata };
  return payload;
}

export async function runGermanyBackfillFetchPass(
  env: GermanyBackfillFetchEnv,
  input: GermanyBackfillFetchPayload,
  dependencies: ExecutorDependencies = {},
) {
  if (env.CASE_CATALOG_GERMANY_HISTORY_ENABLED !== "true") throw new Error("case_backfill.germany_history_disabled");
  if (input.snapshotId !== GERMANY_2023_BACKFILL_SNAPSHOT_ID) throw new Error("case_backfill.germany_snapshot_not_approved");
  if (input.phase !== "fetch") throw new Error("case_backfill.d1_phase_unsupported");
  if ((input.fetchContractVersion ?? FETCH_CONTRACT_VERSION) !== FETCH_CONTRACT_VERSION) throw new Error("case_backfill.fetch_contract_not_approved");
  const batchLimit = Math.max(1, Math.min(input.batchLimit ?? 1, 10));
  const requestedBy = input.requestedBy?.trim() || "worldcons-backfill-workflow";
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleepImpl = dependencies.sleep ?? wait;
  const now = dependencies.now ?? (() => new Date());

  setRuntimeD1Bindings({
    worldcons_ops: env.WORLDCONS_OPS,
    worldcons_core: env.WORLDCONS_CORE,
    worldcons_ingest: env.WORLDCONS_INGEST,
    worldcons_search: env.WORLDCONS_SEARCH,
  });

  const snapshot = await d1CaseBackfillRepository.getSnapshot(input.snapshotId);
  if (snapshot.sourceKey !== SOURCE_KEY || snapshot.status !== "closed" || snapshot.sourcePolicyVersion !== SOURCE_POLICY_VERSION) {
    throw new Error("case_backfill.germany_snapshot_contract_mismatch");
  }
  const policy = await d1CaseBackfillRepository.getSourcePolicy(snapshot.sourceKey, snapshot.sourcePolicyVersion);
  if (policy.minRequestDelayMs !== 30_000 || policy.maxConcurrency !== 1 || policy.normalizeReplayPolicy !== "bounded_evidence") {
    throw new Error("case_backfill.germany_policy_contract_mismatch");
  }
  const activeCommands = await queryRows(env.WORLDCONS_OPS, `
    SELECT r.id FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id
    WHERE c.command_type='p1.case-backfill.fetch' AND r.status IN ('queued','running','retry_wait') LIMIT 1
  `);
  if (activeCommands.length > 0) throw new Error("case_backfill.fetch_command_already_active");
  const openRuns = await d1CaseBackfillRepository.listNonTerminalRuns(input.snapshotId, "fetch");
  if (openRuns.length > 0) throw new Error("case_backfill.fetch_run_already_active");
  if (await d1CaseBackfillRepository.countResidualClaims(input.snapshotId) > 0) throw new Error("case_backfill.residual_claims_present");
  const passRow = (await queryRows(env.WORLDCONS_INGEST, `
    SELECT COALESCE(MAX(pass_number),0)+1 AS next_pass FROM source_backfill_runs WHERE snapshot_id=? AND phase='fetch'
  `, [input.snapshotId]))[0];
  const nextPass = Number(passRow?.next_pass ?? 1);
  if (input.passNumber !== nextPass) throw new Error(`case_backfill.expected_pass_${nextPass}`);

  const payloadRef = {
    cohort: "catalog-backfill",
    snapshotId: input.snapshotId,
    passNumber: input.passNumber,
    batchLimit,
    fetchContractVersion: FETCH_CONTRACT_VERSION,
  };
  const submitted = await d1AdminCommandRepository.submit({
    commandType: "p1.case-backfill.fetch",
    payloadRef,
    idempotencyKey: `backfill-pass:${input.snapshotId}:fetch:${input.passNumber}`,
    dedupeKey: `backfill-active:${input.snapshotId}:fetch`,
    requestedBy,
    priority: 100,
    maxAttempts: 1,
    retryBackoffBaseSeconds: 60,
    retryBackoffCapSeconds: 60,
    shadowOnly: false,
  });
  if (!submitted.ok) throw new Error(`case_backfill.command_submit_failed.${submitted.error.code}`);
  const claimedCommand = await d1AdminCommandRepository.claim({
    workerId: `cloudflare-backfill:${input.snapshotId}:${input.passNumber}`,
    commandTypes: ["p1.case-backfill.fetch"],
    cohorts: ["catalog-backfill"],
    leaseSeconds: 900,
  });
  if (!claimedCommand.ok) throw new Error(`case_backfill.command_claim_failed.${claimedCommand.error.code}`);
  if (!claimedCommand.data || claimedCommand.data.runId !== submitted.data.runId) {
    await d1AdminCommandRepository.abort({ runId: submitted.data.runId, requestedBy, reason: "exact pass claim failed" });
    throw new Error("case_backfill.command_claim_mismatch");
  }
  const attempt = claimedCommand.data;
  const authority: CaseBackfillAttemptAuthority = {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    fencingToken: attempt.fencingToken,
    leaseExpiresAt: attempt.leaseExpiresAt,
  };
  const passInput = {
    cohort: "catalog-backfill" as const,
    snapshotId: input.snapshotId,
    phase: "fetch" as const,
    passNumber: input.passNumber,
    batchLimit,
    fetchContractVersion: FETCH_CONTRACT_VERSION,
  };
  const runId = await d1CaseBackfillRepository.beginRun(passInput, authority);
  let claimed = 0;
  let succeeded = 0;
  let retryableFailed = 0;
  let terminalFailed = 0;
  try {
    while (claimed < batchLimit) {
      await heartbeat(authority);
      const [item] = await d1CaseBackfillRepository.claimItems({ ...passInput, batchLimit: 1 }, authority);
      if (!item) break;
      claimed += 1;
      try {
        const raw = await fetchOfficialDecision(item, input.snapshotId, authority, fetchImpl, sleepImpl);
        await d1CaseBackfillRepository.extendItems([item.itemId], "fetch", authority);
        const replayPayload = boundedReplayPayload(raw, policy.boundedReplayFields, item.inventoryMetadata);
        const document = canonicalJson(replayPayload);
        const payloadHash = createHash("sha256").update(document).digest("hex");
        const artifactId = await d1CaseBackfillRepository.recordFetchArtifact({
          itemId: item.itemId,
          authority,
          sourcePolicyVersion: snapshot.sourcePolicyVersion,
          authorityUrl: text(raw.canonicalUrl),
          httpStatus: 200,
          responseHeaders: {},
          sourceEtag: text(record(raw.metadata).sourceEtag) || null,
          sourceLastModifiedAt: text(record(raw.metadata).sourceLastModifiedAt) || null,
          payloadHash,
          payloadSize: Buffer.byteLength(document),
          replayability: "bounded_evidence",
          immutableStorageRef: null,
          boundedReplayPayload: replayPayload,
          fetchContractVersion: FETCH_CONTRACT_VERSION,
        });
        await d1CaseBackfillRepository.completeItem({
          itemId: item.itemId,
          phase: "fetch",
          authority,
          nextStatus: item.resolutionStatus === "published" ? "published" : "fetched",
          resultMetadata: { artifactId },
        });
        succeeded += 1;
      } catch (error) {
        const isRetryable = retryable(error);
        await d1CaseBackfillRepository.failItem({
          itemId: item.itemId,
          phase: "fetch",
          authority,
          disposition: isRetryable ? "retryable" : "terminal",
          errorCode: boundedErrorCode(error),
          errorSummary: boundedErrorSummary(error),
          retryAt: isRetryable ? new Date(now().getTime() + 5 * 60_000).toISOString() : null,
        });
        if (isRetryable) retryableFailed += 1;
        else terminalFailed += 1;
      }
    }
    const backlogRemaining = await d1CaseBackfillRepository.countBacklog(passInput) > 0;
    await d1CaseBackfillRepository.finishRun({
      runId,
      authority,
      status: retryableFailed > 0 || terminalFailed > 0 ? "degraded" : "succeeded",
      claimed,
      succeeded,
      retryableFailed,
      terminalFailed,
    });
    const transition = await d1AdminCommandRepository.complete(authority.attemptId, authority.fencingToken, {
      snapshotId: input.snapshotId,
      passNumber: input.passNumber,
      claimed,
      succeeded,
      retryableFailed,
      terminalFailed,
      backlogRemaining,
    });
    if (!transition.ok) throw new Error(`case_backfill.command_complete_failed.${transition.error.code}`);
    return { schemaVersion: 1, snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed, backlogRemaining };
  } catch (error) {
    try {
      const remainingClaims = await d1CaseBackfillRepository.countResidualClaims(input.snapshotId);
      if (remainingClaims === 0) {
        await d1CaseBackfillRepository.finishRun({
          runId,
          authority,
          status: "failed",
          claimed,
          succeeded,
          retryableFailed,
          terminalFailed,
          lastErrorCode: boundedErrorCode(error),
          lastErrorSummary: boundedErrorSummary(error),
        });
      }
    } catch {
      // Preserve the original error; stale-fence/lease loss is already durable in the P1 ledger.
    }
    await d1AdminCommandRepository.fail({
      attemptId: authority.attemptId,
      fencingToken: authority.fencingToken,
      disposition: "terminal",
      errorCode: boundedErrorCode(error),
      errorMessage: boundedErrorSummary(error),
      resultSummary: { snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed },
    }).catch(() => undefined);
    throw error;
  }
}

