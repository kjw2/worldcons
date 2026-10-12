import type { D1RuntimeDatabase, D1RuntimePreparedStatement, D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";
import { searchRepairReservation } from "./search-repair-reservation";

export interface SearchRepairMessage { schemaVersion: 1; type: "e2e-search-repair"; outboxId: string }
export interface SearchRepairQueue { send(body: SearchRepairMessage): Promise<unknown> }
export interface SearchRepairDispatchOptions {
  limit?: number;
  workerId?: string;
  clock?: () => string;
  random?: () => number;
}
type Row = Record<string, unknown>;
const LEASE_SECONDS = 300;
const REDISPATCH_SECONDS = 60;
const MAX_TRANSPORT_FAILURES = 8;
const TRANSPORT_BUDGET_MS = 120 * 60 * 1000;

export function isSearchRepairMessage(value: unknown): value is SearchRepairMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Row;
  return body.schemaVersion === 1 && body.type === "e2e-search-repair"
    && typeof body.outboxId === "string" && /^[0-9a-f]{64}$/.test(body.outboxId)
    && Object.keys(body).every((key) => ["schemaVersion", "type", "outboxId"].includes(key));
}

async function rows(db: D1RuntimeDatabase, sql: string, ...values: unknown[]): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...values).all<Row>();
  if (result.success === false || result.error || !Array.isArray(result.results)) throw new Error("e2e.dispatch_read_failed");
  return result.results;
}
async function batch(db: D1RuntimeDatabase, statements: D1RuntimePreparedStatement[]): Promise<D1RuntimeResult[]> {
  if (!db.batch) throw new Error("e2e.dispatch_batch_unavailable");
  const result = await db.batch(statements);
  for (const entry of result) {
    if (entry.error?.includes("e2e_commit_snapshot_match")) throw new Error("e2e_commit_snapshot_match");
    if (entry.success === false || entry.error) throw new Error("e2e.dispatch_batch_failed");
  }
  return result;
}
function iso(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("e2e.invalid_dispatch_clock");
  return new Date(time).toISOString();
}
function after(now: string, seconds: number) { return new Date(Date.parse(now) + seconds * 1000).toISOString(); }
function limit(value = 25) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new Error("e2e.invalid_dispatch_limit");
  return value;
}

// g and h are immutable generation/current-head aliases. Mutable input/quality
// revalidation and Search-side fencing belong to M3/M4, never to Queue ACK.
export const CURRENT_GENERATION_SQL = `h.generation_id=g.generation_id AND h.generation_seq=g.generation_seq
  AND EXISTS (SELECT 1 FROM article_publications_p3 p WHERE p.article_id=g.article_id
    AND p.id=g.expected_publication_id AND p.version_id=g.expected_version_id
    AND CAST(p.revision AS INTEGER)=g.expected_publication_revision AND p.state=g.expected_publication_state)
  AND (g.expected_publication_state<>'published' OR EXISTS (SELECT 1 FROM article_version_heads_p3 vh WHERE vh.article_id=g.article_id
    AND vh.current_version_id=g.expected_version_id AND CAST(vh.current_revision AS INTEGER)=g.expected_version_revision))
  AND (g.expected_publication_state<>'published' OR NOT EXISTS (SELECT 1 FROM article_revision_heads_v4 v4 WHERE v4.article_id=g.article_id)
    OR EXISTS (SELECT 1 FROM article_revision_heads_v4 v4 WHERE v4.article_id=g.article_id
      AND v4.current_version_id=g.expected_version_id AND CAST(v4.current_revision AS INTEGER)=g.expected_version_revision))`;
export const CURRENT_OUTBOX_SQL = `EXISTS (SELECT 1 FROM e2e_generations_v1 g
  JOIN e2e_generation_heads_v1 h ON h.article_id=g.article_id
  WHERE g.generation_id=o.generation_id AND g.article_id=o.article_id AND ${CURRENT_GENERATION_SQL}
    AND g.generation_seq=o.generation_seq AND g.expected_version_id=o.expected_version_id
    AND g.expected_version_revision=o.expected_version_revision AND g.expected_publication_id=o.expected_publication_id
    AND g.expected_publication_revision=o.expected_publication_revision AND g.expected_publication_state=o.expected_publication_state
    AND g.policy_version=o.policy_version AND g.projection_input_hash=o.projection_input_hash)`;
const DUE_SQL = `(o.status IN ('pending','retry_wait') OR (o.status='leased' AND o.lease_expires_at<=?))
  AND o.next_attempt_at<=? AND o.next_dispatch_at<=?
  AND (o.dispatch_token IS NULL OR o.dispatch_lease_expires_at<=?)`;

/** Repairs M1 upgrade holes; never fabricates a new generation or publication. */
export async function reconcileMissingSearchRepairs(db: D1RuntimeDatabase, options: SearchRepairDispatchOptions = {}) {
  const now = iso(options.clock?.() ?? new Date().toISOString());
  const candidates = await rows(db, `SELECT g.* FROM e2e_generations_v1 g
    JOIN e2e_generation_heads_v1 h ON h.article_id=g.article_id
    WHERE ${CURRENT_GENERATION_SQL}
      AND NOT EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE o.generation_id=g.generation_id)
    ORDER BY g.created_at,g.article_id LIMIT ?`, limit(options.limit));
  let reservedCount = 0, conflictCount = 0;
  for (const g of candidates) {
    const reservation = await searchRepairReservation(db, { articleId: String(g.article_id),
      generationId: String(g.generation_id),generationSeq: Number(g.generation_seq),versionId: String(g.expected_version_id),
      versionRevision: Number(g.expected_version_revision),publicationId: String(g.expected_publication_id),
      publicationRevision: Number(g.expected_publication_revision),publicationState: String(g.expected_publication_state),
      policyVersion: String(g.policy_version),projectionInputHash: String(g.projection_input_hash),
      evidenceRef: String(g.approval_evidence_ref) }, now);
    const token = crypto.randomUUID();
    try {
      const results = await batch(db, [db.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion)
        VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM e2e_generations_v1 g
          JOIN e2e_generation_heads_v1 h ON h.article_id=g.article_id
          WHERE g.generation_id=? AND ${CURRENT_GENERATION_SQL}) THEN 1 ELSE 0 END)`).bind(token,g.generation_id),
        reservation.insert, db.prepare("DELETE FROM e2e_commit_guards_v1 WHERE token=?").bind(token)]);
      reservedCount += Number(results[1].meta?.changes ?? 0);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("e2e_commit_snapshot_match")) throw error;
      conflictCount++;
    }
  }
  return { reservedCount, conflictCount };
}

/** Send only durable identity. Accepted-but-unrecorded sends may be repeated. */
export async function dispatchSearchRepairs(db: D1RuntimeDatabase, queue: SearchRepairQueue, options: SearchRepairDispatchOptions = {}) {
  const clock = () => iso(options.clock?.() ?? new Date().toISOString());
  const now = clock();
  const owner = options.workerId ?? `e2e-dispatch:${crypto.randomUUID()}`;
  if (!owner.trim() || owner.length > 160) throw new Error("e2e.invalid_dispatch_owner");
  const verifierReady=(await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='e2e_verification_jobs_v1'")).length>0;
  const verificationDue=verifierReady?`AND NOT EXISTS(SELECT 1 FROM e2e_verification_jobs_v1 j WHERE j.generation_id=o.generation_id AND (j.status IN ('verified','dead_letter','blocked') OR (j.status IN ('pending','retry_wait') AND j.next_attempt_at>?) OR (j.status='leased' AND j.lease_expires_at>?)))`:"";
  const verifierTimes=(at:string)=>verifierReady?[at,at]:[];
  const candidates = await rows(db, `SELECT o.outbox_id FROM e2e_search_repair_outbox_v1 o
    WHERE ${DUE_SQL} AND ${CURRENT_OUTBOX_SQL} ${verificationDue}
    ORDER BY o.next_dispatch_at,o.created_at,o.outbox_id LIMIT ?`, now,now,now,now,...verifierTimes(now),limit(options.limit));
  let claimedCount = 0, sentCount = 0, failedCount = 0, deadLetterCount = 0, fencedCount = 0;
  for (const candidate of candidates) {
    const claimedAt = clock(), token = crypto.randomUUID();
    const claimed = await rows(db, `UPDATE e2e_search_repair_outbox_v1 AS o SET
      dispatch_owner=?,dispatch_token=?,dispatch_lease_expires_at=?,dispatch_fence=dispatch_fence+1,
      dispatch_count=dispatch_count+1,updated_at=? WHERE outbox_id=? AND ${DUE_SQL} AND ${CURRENT_OUTBOX_SQL} ${verificationDue}
      RETURNING *`, owner,token,after(claimedAt,LEASE_SECONDS),claimedAt,candidate.outbox_id,
      claimedAt,claimedAt,claimedAt,claimedAt,...verifierTimes(claimedAt));
    if (claimed.length !== 1) continue;
    claimedCount++;
    const row = claimed[0];
    let sendFailed = false;
    try { await queue.send({ schemaVersion: 1,type: "e2e-search-repair",outboxId: String(row.outbox_id) }); }
    catch { sendFailed = true; } // Provider error text/body is not persisted.
    const settledAt = clock();
    const failures = Number(row.dispatch_failure_count) + Number(sendFailed);
    const firstFailure = row.first_dispatch_failure_at ? String(row.first_dispatch_failure_at) : settledAt;
    const dead = sendFailed && (failures >= MAX_TRANSPORT_FAILURES
      || Date.parse(settledAt) - Date.parse(firstFailure) >= TRANSPORT_BUDGET_MS);
    const jitter = options.random?.() ?? crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("e2e.invalid_dispatch_jitter");
    const delay = Math.floor(Math.min(900,60 * 2 ** Math.min(failures - 1,10) * (0.8 + 0.4 * jitter)));
    const retryAt = after(settledAt,sendFailed ? delay : REDISPATCH_SECONDS);
    const errorCode = sendFailed ? "e2e.queue_send_failed" : null;
    // Every transition checks owner, token, numeric fence, unexpired lease,
    // current Core identity and nonterminal status. A send is never a verify.
    const ownership = `o.outbox_id=? AND o.dispatch_owner=? AND o.dispatch_token=? AND o.dispatch_fence=?
      AND o.dispatch_lease_expires_at>? AND o.status IN ('pending','retry_wait','leased')
      AND (?=0 OR o.status<>'leased' OR o.lease_expires_at<=?) AND ${CURRENT_OUTBOX_SQL}`;
    const ownershipValues = [row.outbox_id,owner,token,row.dispatch_fence,settledAt,Number(sendFailed),settledAt];
    // Both statements assert the original ownership. Update progress before
    // releasing transport ownership inside the same atomic batch, so a stale
    // sender cannot update progress merely because another worker cleared it.
    const results = await batch(db, [
      db.prepare(`UPDATE e2e_generation_progress_v1 SET state=?,last_error_code=?,updated_at=?
        WHERE generation_id=? AND state IN ('publication_committed','search_pending','retry_wait')
          AND EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE ${ownership})`).bind(
        dead ? "dead_letter" : sendFailed ? "retry_wait" : "search_pending",errorCode,settledAt,
        row.generation_id,...ownershipValues),
      db.prepare(`UPDATE e2e_search_repair_outbox_v1 AS o SET
        dispatch_owner=NULL,dispatch_token=NULL,dispatch_lease_expires_at=NULL,
        dispatch_failure_count=?,first_dispatch_failure_at=?,next_dispatch_at=?,
        dispatched_at=CASE WHEN ?=0 THEN ? ELSE dispatched_at END,last_dispatch_error_code=?,
        status=CASE WHEN ?=1 THEN 'dead_letter' ELSE status END,updated_at=?
        WHERE ${ownership} RETURNING outbox_id`).bind(
        sendFailed ? failures : 0,sendFailed ? firstFailure : null,retryAt,Number(sendFailed),settledAt,
        errorCode,Number(dead),settledAt,...ownershipValues)]);
    if (results[1].results?.length !== 1) { fencedCount++; continue; }
    if (sendFailed) { failedCount++; if (dead) deadLetterCount++; } else sentCount++;
  }
  return { claimedCount,sentCount,failedCount,deadLetterCount,fencedCount };
}

export async function readSearchRepairHealth(db: D1RuntimeDatabase, now = new Date().toISOString()) {
  const outstanding = await rows(db, `SELECT COUNT(*) AS pending_count,MIN(o.created_at) AS oldest_at,
      COALESCE(SUM(CASE WHEN o.dispatch_failure_count>=3 THEN 1 ELSE 0 END),0) AS repeated_failure_count,
      COALESCE(SUM(CASE WHEN ${CURRENT_OUTBOX_SQL} THEN 0 ELSE 1 END),0) AS core_drift_count
    FROM e2e_search_repair_outbox_v1 o JOIN e2e_generation_heads_v1 h ON h.generation_id=o.generation_id
    WHERE o.status NOT IN ('verified','superseded','dead_letter')`);
  const dead = await rows(db, "SELECT COUNT(*) AS count FROM e2e_search_repair_outbox_v1 WHERE status='dead_letter'");
  const missing = await rows(db, `SELECT COUNT(*) AS count FROM e2e_generation_heads_v1 h
    WHERE NOT EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE o.generation_id=h.generation_id)`);
  const row = outstanding[0];
  const ageSeconds = row.oldest_at ? Math.max(0,Math.floor((Date.parse(iso(now)) - Date.parse(String(row.oldest_at))) / 1000)) : 0;
  return { pendingCount: Number(row.pending_count),oldestPendingAgeSeconds: ageSeconds,
    repeatedFailureCount: Number(row.repeated_failure_count),coreIdentityDriftCount: Number(row.core_drift_count),
    deadLetterCount: Number(dead[0].count),missingReservationCount: Number(missing[0].count),
    requiresAttention: ageSeconds >= 1800 || Number(row.repeated_failure_count) > 0 || Number(row.core_drift_count) > 0
      || Number(dead[0].count) > 0 || Number(missing[0].count) > 0 };
}
