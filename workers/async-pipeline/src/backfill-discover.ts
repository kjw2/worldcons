import { d1AdminCommandRepository } from "../../../lib/admin/command-control-plane/d1-repository";
import { d1CaseBackfillRepository } from "../../../lib/backfill/d1-repository";
import { germanyBverfgYearScope } from "../../../lib/backfill/germany-scope";
import type { CaseBackfillAttemptAuthority } from "../../../lib/backfill/types";
import {
  BVERFG_DEJURE_INDEX_URL,
  discoverBverfgInventory,
  parseBverfgDejureInventoryPage,
  type BverfgInventoryLoadedPage,
  type BverfgInventoryResult,
} from "../../../lib/crawlee/bverfg-inventory";
import { governedBoundedFetch } from "../../../lib/crawler/request-governor";
import { parseRobotsTxt } from "../../../lib/crawler/robots";
import { crawlerHeaders, crawlerUserAgent } from "../../../lib/crawler/user-agents";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";

const SOURCE_KEY = "de-bverfg";
const DOCUMENT_TYPE = "DECISION";
const DISCOVERY_METHOD = "external_index_dejure_paged_listing";
const PARSER_VERSION = "bverfg-official-normalize-v2";
const POLICY_VERSION_2022 = "bverfg-unattended-canary-v3";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GermanyBackfillDiscoverPayload {
  year: 2022;
  phase: "discover";
  passNumber: 1;
  maxPages?: number;
  requestedBy?: string;
}

export interface GermanyBackfillDiscoverEnv {
  WORLDCONS_OPS: D1RuntimeDatabase;
  WORLDCONS_CORE: D1RuntimeDatabase;
  WORLDCONS_INGEST: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  CASE_CATALOG_GERMANY_HISTORY_ENABLED?: string;
}

interface DiscoverRunContext {
  snapshotId: string;
  runId: string;
  authority: CaseBackfillAttemptAuthority;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function rows<T extends Record<string, unknown>>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "case_backfill.discovery_d1_read_failed");
  }
  return result.results;
}

export function parseGermanyBackfillDiscoverPayload(value: unknown): GermanyBackfillDiscoverPayload | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const payload = candidate as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["year","phase","passNumber","maxPages","requestedBy"].includes(key))) return null;
  if (
    payload.year !== 2022
    || payload.phase !== "discover"
    || payload.passNumber !== 1
    || (payload.maxPages !== undefined && (!Number.isInteger(payload.maxPages) || Number(payload.maxPages) < 1 || Number(payload.maxPages) > 500))
    || (payload.requestedBy !== undefined && (typeof payload.requestedBy !== "string" || payload.requestedBy.trim().length < 1 || payload.requestedBy.length > 160))
  ) return null;
  return payload as unknown as GermanyBackfillDiscoverPayload;
}

function configureBindings(env: GermanyBackfillDiscoverEnv) {
  setRuntimeD1Bindings({
    worldcons_ops: env.WORLDCONS_OPS,
    worldcons_core: env.WORLDCONS_CORE,
    worldcons_ingest: env.WORLDCONS_INGEST,
    worldcons_search: env.WORLDCONS_SEARCH,
  });
}

export async function openGermanyBackfill2022Snapshot(
  env: GermanyBackfillDiscoverEnv,
  input: GermanyBackfillDiscoverPayload,
) {
  if (env.CASE_CATALOG_GERMANY_HISTORY_ENABLED !== "true") throw new Error("case_backfill.germany_history_disabled");
  configureBindings(env);
  const scope = germanyBverfgYearScope(input.year, new Date().getUTCFullYear());
  const existing = await rows<Record<string, unknown>>(env.WORLDCONS_INGEST, `
    SELECT id,status,source_policy_version,parser_version FROM source_inventory_snapshots
    WHERE source_key=? AND document_type=? AND scope_from=? AND scope_to=?
    ORDER BY opened_at DESC LIMIT 3
  `, [SOURCE_KEY,DOCUMENT_TYPE,scope.scopeFrom,scope.scopeTo]);
  const exactClosed = existing.find((row) => row.status === "closed" && row.source_policy_version === POLICY_VERSION_2022 && row.parser_version === PARSER_VERSION);
  if (exactClosed) return { snapshotId: text(exactClosed.id), alreadyClosed: true };
  const open = existing.filter((row) => row.status === "open");
  if (open.length > 1) throw new Error("case_backfill.multiple_open_snapshots");
  if (open[0]) {
    if (open[0].source_policy_version !== POLICY_VERSION_2022 || open[0].parser_version !== PARSER_VERSION) {
      throw new Error("case_backfill.open_snapshot_contract_mismatch");
    }
    return { snapshotId: text(open[0].id), alreadyClosed: false };
  }
  const snapshotId = await d1CaseBackfillRepository.openSnapshot({
    sourceKey: SOURCE_KEY,
    scopeFrom: scope.scopeFrom,
    scopeTo: scope.scopeTo,
    documentType: DOCUMENT_TYPE,
    discoveryMethod: DISCOVERY_METHOD,
    parserVersion: PARSER_VERSION,
    sourcePolicyVersion: POLICY_VERSION_2022,
    coverageAssurance: "external_index_assisted",
    expectedCount: null,
    expectedCountBasis: null,
    coverageEvidence: {},
    exclusions: [],
    createdBy: input.requestedBy?.trim() || "worldcons-backfill-discover-workflow",
  });
  return { snapshotId, alreadyClosed: false };
}

export async function startGermanyBackfill2022DiscoverRun(
  env: GermanyBackfillDiscoverEnv,
  input: GermanyBackfillDiscoverPayload,
  snapshotId: string,
): Promise<DiscoverRunContext> {
  configureBindings(env);
  const requestedBy = input.requestedBy?.trim() || "worldcons-backfill-discover-workflow";
  const payloadRef = { cohort: "catalog-backfill", snapshotId, passNumber: 1, batchLimit: 500 };
  const submitted = await d1AdminCommandRepository.submit({
    commandType: "p1.case-backfill.discover",
    payloadRef,
    idempotencyKey: `backfill-pass:${snapshotId}:discover:1`,
    dedupeKey: `backfill-active:${snapshotId}:discover`,
    requestedBy,
    priority: 100,
    maxAttempts: 2,
    retryBackoffBaseSeconds: 60,
    retryBackoffCapSeconds: 60,
    shadowOnly: false,
  });
  if (!submitted.ok) throw new Error(`case_backfill.command_submit_failed.${submitted.error.code}`);
  let targetRunId = submitted.data.runId;
  if (submitted.data.runStatus === "failed" || submitted.data.runStatus === "aborted") {
    const retried = await d1AdminCommandRepository.retry(submitted.data.runId, requestedBy, "resume Germany 2022 discovery");
    if (!retried.ok) throw new Error(`case_backfill.command_retry_failed.${retried.error.code}`);
    targetRunId = retried.data.runId;
  } else if (submitted.data.runStatus === "succeeded") {
    throw new Error("case_backfill.discovery_command_already_succeeded_on_open_snapshot");
  }
  const claimed = await d1AdminCommandRepository.claim({
    workerId: `cloudflare-backfill-discover:${snapshotId}`,
    commandTypes: ["p1.case-backfill.discover"],
    cohorts: ["catalog-backfill"],
    leaseSeconds: 86_400,
  });
  if (!claimed.ok) throw new Error(`case_backfill.command_claim_failed.${claimed.error.code}`);
  if (!claimed.data || claimed.data.runId !== targetRunId) {
    await d1AdminCommandRepository.abort({ runId: targetRunId, requestedBy, reason: "exact discovery claim failed" });
    throw new Error("case_backfill.command_claim_mismatch");
  }
  const authority: CaseBackfillAttemptAuthority = {
    attemptId: claimed.data.attemptId,
    runId: claimed.data.runId,
    fencingToken: claimed.data.fencingToken,
    leaseExpiresAt: claimed.data.leaseExpiresAt,
  };
  const runId = await d1CaseBackfillRepository.beginRun({
    cohort: "catalog-backfill",snapshotId,phase: "discover",passNumber: 1,batchLimit: 500,
  }, authority);
  return { snapshotId, runId, authority };
}

async function heartbeat(authority: CaseBackfillAttemptAuthority) {
  const result = await d1AdminCommandRepository.heartbeat(authority.attemptId, authority.fencingToken, 86_400);
  if (!result.ok) throw new Error(`case_backfill.command_heartbeat_failed.${result.error.code}`);
}

function discoverGovernor(snapshotId: string, authority: CaseBackfillAttemptAuthority) {
  return {
    async acquire(url: string) {
      const origin = new URL(url).origin.toLowerCase();
      for (;;) {
        await heartbeat(authority);
        const result = await d1CaseBackfillRepository.acquireSourceRequestPermit({
          snapshotId,phase: "discover",authority,requestOrigin: origin,requestedLeaseSeconds: 90,
        });
        if (result.granted) {
          if (!result.permitId) throw new Error("case_backfill.request_permit_missing");
          let released = false;
          return {
            release: async () => {
              if (released) return;
              await d1CaseBackfillRepository.releaseSourceRequestPermit({ permitId: result.permitId!, authority });
              released = true;
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.min(result.retryAfterMs || 1000, 5000))));
      }
    },
  };
}

async function boundedTextResponse(response: Response) {
  if (!response.ok) throw new Error(`case_backfill.discovery_http_${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("crawler.response_too_large");
  const textBody = await response.text();
  if (new TextEncoder().encode(textBody).byteLength > MAX_RESPONSE_BYTES) throw new Error("crawler.response_too_large");
  if (!/<(?:html|!doctype)|user-agent\s*:/i.test(textBody)) throw new Error("case_backfill.discovery_invalid_response");
  return textBody;
}

export async function fetchGermanyBackfillRobots(
  env: GermanyBackfillDiscoverEnv,
  context: DiscoverRunContext,
) {
  configureBindings(env);
  const governor = discoverGovernor(context.snapshotId, context.authority);
  const robotsUrl = "https://dejure.org/robots.txt";
  const response = await governedBoundedFetch(robotsUrl, { headers: crawlerHeaders({ Accept: "text/plain,*/*;q=0.5" }) }, MAX_RESPONSE_BYTES, { requestGovernor: governor });
  const body = await boundedTextResponse(response);
  const parsed = parseRobotsTxt(body, BVERFG_DEJURE_INDEX_URL, crawlerUserAgent());
  if (!parsed.allowed) throw new Error("case_backfill.dejure_robots_disallowed");
  return { status: response.status, allowed: parsed.allowed, crawlDelaySeconds: parsed.crawlDelaySeconds ?? null };
}

export async function fetchGermanyBackfillInventoryPage(
  env: GermanyBackfillDiscoverEnv,
  context: DiscoverRunContext,
  url: string,
  page: number,
): Promise<BverfgInventoryLoadedPage> {
  configureBindings(env);
  await heartbeat(context.authority);
  const governor = discoverGovernor(context.snapshotId, context.authority);
  const response = await governedBoundedFetch(url, {
    headers: crawlerHeaders({ Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "de,en;q=0.8,ko;q=0.5" }),
  }, MAX_RESPONSE_BYTES, { requestGovernor: governor });
  const html = await boundedTextResponse(response);
  const parsed = parseBverfgDejureInventoryPage(html, page);
  const bytes = new TextEncoder().encode(html);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const responseHash = [...digest].map((entry) => entry.toString(16).padStart(2, "0")).join("");
  return { parsed, responseHash };
}

export async function persistGermanyBackfillInventory(
  env: GermanyBackfillDiscoverEnv,
  context: DiscoverRunContext,
  inventory: BverfgInventoryResult,
) {
  configureBindings(env);
  await heartbeat(context.authority);
  let written = 0;
  try {
    for (const artifact of inventory.enumerationArtifacts) {
      await d1CaseBackfillRepository.recordEnumerationArtifact({ snapshotId: context.snapshotId, authority: context.authority, artifact });
    }
    for (const item of inventory.items) {
      await d1CaseBackfillRepository.upsertInventoryItem({
        snapshotId: context.snapshotId,
        stableItemKey: item.stableItemKey,
        sourceRecordId: item.sourceRecordId,
        discoveredUrl: item.discoveredUrl,
        documentType: item.documentType,
        decisionDateHint: item.decisionDateHint,
        inventoryMetadata: item.inventoryMetadata,
      });
      written += 1;
      if (written % 50 === 0) await heartbeat(context.authority);
    }
    await d1CaseBackfillRepository.updateSnapshotEvidence(
      context.snapshotId,inventory.coverageEvidence,inventory.expectedCount,inventory.expectedCountBasis,
    );
    const status = await d1CaseBackfillRepository.closeSnapshot(context.snapshotId);
    await d1CaseBackfillRepository.finishRun({
      runId: context.runId,authority: context.authority,status: "succeeded",claimed: written,succeeded: written,retryableFailed: 0,terminalFailed: 0,
    });
    const completed = await d1AdminCommandRepository.complete(context.authority.attemptId, context.authority.fencingToken, {
      snapshotId: context.snapshotId,phase: "discover",discoveredCount: written,manifestHash: status.manifestHash,
    });
    if (!completed.ok) throw new Error(`case_backfill.command_complete_failed.${completed.error.code}`);
    return { snapshotId: context.snapshotId, discoveredCount: written, manifestHash: status.manifestHash, snapshotStatus: status.snapshotStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await d1CaseBackfillRepository.finishRun({
        runId: context.runId,authority: context.authority,status: "failed",claimed: written,succeeded: written,retryableFailed: 0,terminalFailed: 0,
        lastErrorCode: "case_backfill.discovery_failed",lastErrorSummary: message.slice(0,500),
      });
    } catch { /* preserve the original failure */ }
    try {
      await d1AdminCommandRepository.fail({
        attemptId: context.authority.attemptId,fencingToken: context.authority.fencingToken,disposition: "terminal",
        errorCode: "case_backfill.discovery_failed",errorMessage: message.slice(0,500),resultSummary: { snapshotId: context.snapshotId, written },
      });
    } catch { /* preserve the original failure */ }
    throw error;
  }
}

export async function discoverGermanyBackfillInventoryWithLoader(
  input: GermanyBackfillDiscoverPayload,
  loadPage: (url: string, page: number) => Promise<BverfgInventoryLoadedPage>,
) {
  return discoverBverfgInventory({ year: input.year, currentYear: new Date().getUTCFullYear(), maxPages: input.maxPages ?? 500, loadPage });
}
