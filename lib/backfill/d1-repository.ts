import {
  getRuntimeD1Binding,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
  type D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";
import type {
  AcquireSourceRequestPermitInput,
  CaseBackfillOpenRun,
  CaseBackfillRepository,
  RecordFetchArtifactInput,
  RecordNormalizationArtifactInput,
  SourceRequestPermitResult,
} from "@/lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillFetchArtifact,
  CaseBackfillItemPhase,
  CaseBackfillNormalizationArtifact,
  CaseBackfillPassInput,
  CaseBackfillPublicationResult,
  CaseBackfillSnapshot,
  CaseBackfillSnapshotStatus,
  CaseBackfillSourcePolicy,
} from "@/lib/backfill/types";
import type { NormalizedArticle } from "@/lib/sources/types";
import { authoritativeCaseMetadata } from "@/lib/search/case-number";
import { canonicalJson } from "@/lib/backfill/canonical-json";

type Row = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

const SECRET_KEY_PATTERN = /(authorization|cookie|credential|password|private.?key|secret|signature|token)/i;
const SECRET_VALUE_PATTERN = /(^|[^a-z0-9])(bearer\s+[a-z0-9._~-]{12,}|sk-[a-z0-9_-]{16,}|AIza[a-z0-9_-]{20,})/i;

function jsonHasSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonHasSecret);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      SECRET_KEY_PATTERN.test(key) || jsonHasSecret(child)
    ));
  }
  return typeof value === "string" && SECRET_VALUE_PATTERN.test(value);
}

function boundedJsonObject(value: unknown, maxBytes: number, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const serialized = canonicalJson(value);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes || jsonHasSecret(value)) throw new Error(code);
  return serialized;
}

function validHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hostname(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function changes(result: D1RuntimeResult) {
  return numberValue(result.meta?.changes);
}

function requiredBinding(name: "worldcons_core" | "worldcons_ingest" | "worldcons_ops") {
  const binding = getRuntimeD1Binding(name);
  if (!binding) throw new Error(`case_backfill.d1_${name}_unavailable`);
  return binding;
}

async function rows<T extends Row>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "case_backfill.d1_read_failed");
  }
  return result.results;
}

async function run(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = db.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("case_backfill.d1_write_unavailable");
  const result = await statement.run();
  if (!result || result.success === false || result.error) throw new Error(result?.error || "case_backfill.d1_write_failed");
  return result;
}

async function batch(db: D1RuntimeDatabase, statements: D1RuntimePreparedStatement[]) {
  if (!db.batch) {
    for (const statement of statements) {
      if (!statement.run) throw new Error("case_backfill.d1_batch_unavailable");
      const result = await statement.run();
      if (!result || result.success === false || result.error) throw new Error(result?.error || "case_backfill.d1_batch_failed");
    }
    return;
  }
  const results = await db.batch(statements);
  if (results.some((result) => !result || result.success === false || result.error)) {
    throw new Error("case_backfill.d1_batch_failed");
  }
}

async function finalizeCatalogItem(
  db: D1RuntimeDatabase,
  input: {
    itemId: string;
    authority: CaseBackfillAttemptAuthority;
    articleId: string;
    normalizationArtifactId: string;
    versionId: string;
    publicationRevision: number;
    publicationState: "published" | "withdrawn";
    recovered?: boolean;
  },
) {
  const now = new Date().toISOString();
  const eventId = decimalId();
  const details = JSON.stringify({
    articleId: input.articleId,
    versionId: input.versionId,
    publicationRevision: input.publicationRevision,
    publicationState: input.publicationState,
    ...(input.recovered ? { recovered: true } : {}),
  });
  const eventType = input.publicationState === "published" ? "catalog_published" : "item_completed";
  const claimWhere = `id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase='publish' AND lease_expires_at>?`;
  await batch(db, [
    db.prepare(`INSERT INTO source_backfill_item_events(id,item_id,attempt_id,event_type,phase,safe_details,occurred_at)
      SELECT ?,id,?,?,'publish',?,? FROM source_backfill_items WHERE ${claimWhere}`).bind(
      eventId,input.authority.attemptId,eventType,details,now,
      input.itemId,input.authority.attemptId,input.authority.fencingToken,now,
    ),
    db.prepare(`UPDATE source_backfill_items SET article_id=?,status=?,published_normalization_artifact_id=CASE WHEN ?='published' THEN ? ELSE NULL END,
      claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,next_attempt_at=NULL,retry_phase=NULL,
      error_code=NULL,error_summary=NULL,updated_at=? WHERE ${claimWhere}`).bind(
      input.articleId,input.publicationState,input.publicationState,input.normalizationArtifactId,now,
      input.itemId,input.authority.attemptId,input.authority.fencingToken,now,
    ),
  ]);
  const item = (await rows<Row>(db, `SELECT status,article_id,published_normalization_artifact_id,claimed_attempt_id
    FROM source_backfill_items WHERE id=? LIMIT 1`, [input.itemId]))[0];
  const event = (await rows<Row>(db, `SELECT id FROM source_backfill_item_events
    WHERE id=? AND item_id=? AND event_type=? LIMIT 1`, [eventId,input.itemId,eventType]))[0];
  if (
    !item
    || text(item.status) !== input.publicationState
    || text(item.article_id) !== input.articleId
    || (input.publicationState === "published" && text(item.published_normalization_artifact_id) !== input.normalizationArtifactId)
    || (input.publicationState === "withdrawn" && item.published_normalization_artifact_id !== null)
    || item.claimed_attempt_id !== null
    || !event
  ) {
    throw new Error("case_backfill.item_lease_lost_after_catalog_commit");
  }
}

function decimalId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return (BigInt(Date.now()) * 10_000_000n + BigInt(random)).toString();
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

async function deterministicVersionId(articleId: string, contentHash: string) {
  const hash = await sha256Hex(`${articleId}:${contentHash}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function normalizedIdentifier(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function slugPart(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function itemEvent(
  db: D1RuntimeDatabase,
  input: { itemId: string; attemptId: string | null; eventType: string; phase: string | null; details?: Record<string, unknown> },
) {
  return db.prepare(
    "INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(
    decimalId(),
    input.itemId,
    input.attemptId,
    input.eventType,
    input.phase,
    JSON.stringify(input.details ?? {}),
    new Date().toISOString(),
  );
}

interface LiveAttempt {
  leaseExpiresAt: string;
  commandRunId: string;
  payload: Record<string, unknown>;
}

async function assertLiveAttempt(
  authority: CaseBackfillAttemptAuthority,
  snapshotId: string,
  phase: CaseBackfillPassInput["phase"],
): Promise<LiveAttempt> {
  const db = requiredBinding("worldcons_ops");
  const row = (await rows<Row>(db, `
    SELECT
      a.id AS attempt_id,
      a.run_id AS run_id,
      a.status AS attempt_status,
      a.fencing_token AS fencing_token,
      a.lease_expires_at AS lease_expires_at,
      r.status AS run_status,
      r.current_attempt_id AS current_attempt_id,
      r.abort_requested_at AS abort_requested_at,
      c.command_type AS command_type,
      c.payload_ref AS payload_ref
    FROM admin_command_attempts a
    JOIN admin_command_runs r ON r.id = a.run_id
    JOIN admin_commands c ON c.id = r.command_id
    WHERE a.id = ?
    LIMIT 1
  `, [authority.attemptId]))[0];
  if (!row) throw new Error("case_backfill.attempt_not_found");
  if (
    text(row.run_id) !== authority.runId
    || text(row.fencing_token) !== authority.fencingToken
    || text(row.current_attempt_id) !== authority.attemptId
  ) {
    throw new Error("case_backfill.stale_fence");
  }
  if (
    text(row.attempt_status) !== "running"
    || text(row.run_status) !== "running"
    || Date.parse(text(row.lease_expires_at)) <= Date.now()
  ) {
    throw new Error("case_backfill.lease_lost");
  }
  if (row.abort_requested_at) throw new Error("case_backfill.aborted");
  const payload = jsonObject(row.payload_ref);
  if (
    text(row.command_type) !== `p1.case-backfill.${phase}`
    || payload.cohort !== "catalog-backfill"
    || payload.snapshotId !== snapshotId
  ) {
    throw new Error("case_backfill.attempt_scope_mismatch");
  }
  return { leaseExpiresAt: text(row.lease_expires_at), commandRunId: text(row.run_id), payload };
}

async function snapshot(snapshotId: string): Promise<CaseBackfillSnapshot> {
  const db = requiredBinding("worldcons_ingest");
  const row = (await rows<Row>(db, `
    SELECT id,source_key,scope_from,scope_to,document_type,parser_version,source_policy_version,status
    FROM source_inventory_snapshots WHERE id=? LIMIT 1
  `, [snapshotId]))[0];
  if (!row) throw new Error("case_backfill.snapshot_not_found");
  return {
    id: text(row.id),
    sourceKey: text(row.source_key),
    scopeFrom: nullableText(row.scope_from),
    scopeTo: nullableText(row.scope_to),
    documentType: text(row.document_type),
    parserVersion: text(row.parser_version),
    sourcePolicyVersion: text(row.source_policy_version),
    status: text(row.status),
  };
}

interface PolicyRow extends Row {
  source_key: unknown;
  policy_version: unknown;
  normalize_replay_policy: unknown;
  bounded_replay_fields: unknown;
  min_request_delay_ms: unknown;
  max_concurrency: unknown;
  review_due_at: unknown;
  authority_hosts: unknown;
  redirect_hosts: unknown;
  external_index_hosts: unknown;
}

async function sourcePolicyRow(sourceKey: string, policyVersion: string) {
  const db = requiredBinding("worldcons_core");
  const row = (await rows<PolicyRow>(db, `
    SELECT source_key,policy_version,normalize_replay_policy,bounded_replay_fields,
           min_request_delay_ms,max_concurrency,review_due_at,
           authority_hosts,redirect_hosts,external_index_hosts
    FROM source_corpus_policies
    WHERE source_key=? AND policy_version=?
    LIMIT 1
  `, [sourceKey, policyVersion]))[0];
  if (!row) throw new Error("case_backfill.policy_not_found");
  if (Date.parse(text(row.review_due_at)) <= Date.now()) throw new Error("case_backfill.policy_review_expired");
  return row;
}

function mapPolicy(row: PolicyRow): CaseBackfillSourcePolicy {
  const replay = text(row.normalize_replay_policy);
  if (replay !== "full_snapshot" && replay !== "bounded_evidence" && replay !== "non_replayable") {
    throw new Error("case_backfill.policy_invalid");
  }
  return {
    sourceKey: text(row.source_key),
    policyVersion: text(row.policy_version),
    normalizeReplayPolicy: replay,
    boundedReplayFields: jsonArray(row.bounded_replay_fields),
    minRequestDelayMs: numberValue(row.min_request_delay_ms),
    maxConcurrency: numberValue(row.max_concurrency),
    reviewDueAt: text(row.review_due_at),
  };
}

function targetVersion(input: CaseBackfillPassInput) {
  if (input.phase === "fetch") return input.fetchContractVersion ?? "spain-hj-fetch-v1";
  if (input.phase === "normalize") {
    return `${input.parserVersion ?? "spain-hj-normalize-v1"}:${input.normalizationContractVersion ?? "case-normalized-v1"}`;
  }
  return null;
}

function assertSupportedD1Phase(phase: string) {
  if (phase !== "fetch" && phase !== "normalize" && phase !== "verify" && phase !== "publish") {
    throw new Error("case_backfill.d1_phase_unsupported");
  }
}

function assertSupportedD1RunPhase(phase: string) {
  if (phase !== "discover") assertSupportedD1Phase(phase);
}

async function claimOne(
  input: CaseBackfillPassInput,
  authority: CaseBackfillAttemptAuthority,
): Promise<CaseBackfillClaimedItem | null> {
  assertSupportedD1Phase(input.phase);
  const live = await assertLiveAttempt(authority, input.snapshotId, input.phase);
  const payloadBatchLimit = numberValue(live.payload.batchLimit ?? 50);
  if (input.batchLimit > payloadBatchLimit) throw new Error("case_backfill.item_scope_mismatch");
  const version = targetVersion(input);
  const liveVersion = input.phase === "fetch"
    ? (live.payload.fetchContractVersion ?? "spain-hj-fetch-v1")
    : input.phase === "normalize"
      ? `${live.payload.parserVersion ?? "spain-hj-normalize-v1"}:${live.payload.normalizationContractVersion ?? "case-normalized-v1"}`
      : null;
  if (liveVersion !== version) {
    throw new Error("case_backfill.item_scope_mismatch");
  }
  const db = requiredBinding("worldcons_ingest");
  const currentSnapshot = await snapshot(input.snapshotId);
  if (currentSnapshot.status !== "closed") throw new Error("case_backfill.snapshot_not_closed");
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(Math.min(
    Date.parse(live.leaseExpiresAt),
    now.getTime() + 180_000,
  )).toISOString();

  for (let scan = 0; scan < 8; scan += 1) {
    const candidate = (await rows<Row>(db, `
      SELECT i.*,f.fetch_contract_version,n.fetch_artifact_id AS normalization_fetch_artifact_id,
             n.parser_version AS normalization_parser_version,n.normalization_contract_version AS normalization_contract_version
      FROM source_backfill_items i
      LEFT JOIN source_fetch_artifacts f ON f.id=i.current_fetch_artifact_id
      LEFT JOIN source_normalization_artifacts n ON n.id=i.current_normalization_artifact_id
      WHERE i.snapshot_id=?
        AND (i.claimed_attempt_id IS NULL OR i.lease_expires_at<=?)
        AND (i.next_attempt_at IS NULL OR i.next_attempt_at<=?)
        AND (
          (?='fetch' AND (
            i.status IN ('discovered','queued')
            OR (i.status='retry_wait' AND i.retry_phase='fetch')
            OR (i.status='published' AND ? IS NOT NULL AND COALESCE(f.fetch_contract_version,'')<>?)
          ))
          OR (?='normalize' AND (
            i.status='fetched'
            OR (i.status='retry_wait' AND i.retry_phase='normalize')
            OR (i.status='published' AND i.current_fetch_artifact_id IS NOT NULL AND (
              n.fetch_artifact_id IS NULL OR n.fetch_artifact_id<>i.current_fetch_artifact_id
              OR (? IS NOT NULL AND COALESCE(n.parser_version || ':' || n.normalization_contract_version,'')<>?)
            ))
          ))
          OR (?='verify' AND (
            i.status='normalized'
            OR (i.status='retry_wait' AND i.retry_phase='verify')
            OR (i.status='published' AND i.current_normalization_artifact_id IS NOT NULL
              AND i.current_normalization_artifact_id IS NOT i.verified_normalization_artifact_id)
          ))
          OR (?='publish' AND (
            i.status='verified'
            OR (i.status='retry_wait' AND i.retry_phase='publish')
            OR (i.status='published' AND i.verified_normalization_artifact_id IS NOT NULL
              AND i.verified_normalization_artifact_id IS NOT i.published_normalization_artifact_id)
          ))
        )
      ORDER BY i.first_seen_at,i.id
      LIMIT 1
    `, [input.snapshotId, nowIso, nowIso, input.phase, version, version, input.phase, version, version, input.phase, input.phase]))[0];
    if (!candidate) return null;
    const result = await run(db, `
      UPDATE source_backfill_items
      SET status=CASE WHEN ?='fetch' AND status<>'published' THEN 'fetching' ELSE status END,
          attempt_count=attempt_count+1,
          claimed_attempt_id=?,claimed_fencing_token=?,claimed_phase=?,lease_expires_at=?,
          retry_phase=NULL,error_code=NULL,error_summary=NULL,updated_at=?
      WHERE id=? AND snapshot_id=?
        AND (claimed_attempt_id IS NULL OR lease_expires_at<=?)
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        AND (
          (?='fetch' AND (status IN ('discovered','queued') OR (status='retry_wait' AND retry_phase='fetch') OR status='published'))
          OR (?='normalize' AND (status='fetched' OR (status='retry_wait' AND retry_phase='normalize') OR status='published'))
          OR (?='verify' AND (status='normalized' OR (status='retry_wait' AND retry_phase='verify') OR status='published'))
          OR (?='publish' AND (status='verified' OR (status='retry_wait' AND retry_phase='publish') OR status='published'))
        )
    `, [input.phase, authority.attemptId, authority.fencingToken, input.phase, leaseExpiresAt, nowIso, candidate.id, input.snapshotId, nowIso, nowIso, input.phase, input.phase, input.phase, input.phase]);
    if (changes(result) !== 1) continue;
    await run(db, `
      INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at)
      VALUES (?,?,?,?,?,?,?)
    `, [decimalId(), candidate.id, authority.attemptId, "item_claimed", input.phase, JSON.stringify({ leaseExpiresAt, fencingToken: authority.fencingToken }), nowIso]);
    return {
      itemId: text(candidate.id),
      stableItemKey: text(candidate.stable_item_key),
      sourceRecordId: nullableText(candidate.source_record_id),
      discoveredUrl: text(candidate.discovered_url),
      authorityUrl: nullableText(candidate.authority_url),
      documentType: nullableText(candidate.document_type),
      decisionDateHint: nullableText(candidate.discovered_decision_date_hint),
      inventoryMetadata: jsonObject(candidate.inventory_metadata),
      resolutionStatus: text(candidate.status) === "published" ? "published" : (input.phase === "fetch" ? "fetching" : text(candidate.status)),
      currentFetchArtifactId: nullableText(candidate.current_fetch_artifact_id),
      currentNormalizationArtifactId: nullableText(candidate.current_normalization_artifact_id),
      verifiedNormalizationArtifactId: nullableText(candidate.verified_normalization_artifact_id),
      publishedNormalizationArtifactId: nullableText(candidate.published_normalization_artifact_id),
      itemLeaseExpiresAt: leaseExpiresAt,
    };
  }
  throw new Error("case_backfill.claim_contention");
}

async function itemForMutation(itemId: string, phase: CaseBackfillItemPhase, authority: CaseBackfillAttemptAuthority) {
  const db = requiredBinding("worldcons_ingest");
  const row = (await rows<Row>(db, "SELECT * FROM source_backfill_items WHERE id=? LIMIT 1", [itemId]))[0];
  if (!row) throw new Error("case_backfill.item_not_found");
  await assertLiveAttempt(authority, text(row.snapshot_id), phase);
  if (
    text(row.claimed_attempt_id) !== authority.attemptId
    || text(row.claimed_fencing_token) !== authority.fencingToken
    || text(row.claimed_phase) !== phase
    || Date.parse(text(row.lease_expires_at)) <= Date.now()
  ) {
    throw new Error("case_backfill.item_lease_lost");
  }
  return row;
}

async function unsupported(): Promise<never> {
  throw new Error("case_backfill.d1_phase_unsupported");
}

export const d1CaseBackfillRepository: CaseBackfillRepository = {
  async openSnapshot(input) {
    if (
      !/^[a-z][a-z0-9._-]{0,79}$/.test(input.sourceKey)
      || input.documentType.trim().length < 1 || input.documentType.trim().length > 80
      || input.discoveryMethod.trim().length < 1 || input.discoveryMethod.trim().length > 120
      || input.parserVersion.trim().length < 1 || input.parserVersion.trim().length > 120
      || input.createdBy.trim().length < 1 || input.createdBy.trim().length > 160
      || !["authoritative_enumerated","authoritative_counted","authoritative_crosschecked","external_index_assisted","best_effort"].includes(input.coverageAssurance)
      || (input.expectedCount !== null && (!Number.isInteger(input.expectedCount) || input.expectedCount < 0))
      || ((input.expectedCount === null) !== (input.expectedCountBasis === null))
    ) throw new Error("case_backfill.invalid_snapshot");
    await sourcePolicyRow(input.sourceKey, input.sourcePolicyVersion);
    const coverageEvidence = boundedJsonObject(input.coverageEvidence ?? {}, 16_384, "case_backfill.invalid_coverage_evidence");
    const exclusions = canonicalJson(input.exclusions ?? []);
    if (new TextEncoder().encode(exclusions).byteLength > 16_384) throw new Error("case_backfill.invalid_snapshot");
    const db = requiredBinding("worldcons_ingest");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(db, `INSERT INTO source_inventory_snapshots(
      id,source_key,scope_from,scope_to,document_type,discovery_method,parser_version,source_policy_version,
      coverage_assurance,expected_count,expected_count_basis,coverage_evidence,discovered_count,manifest_hash,status,
      exclusions,opened_at,closed_at,created_by,enumeration_manifest_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'open',?,?,NULL,?,NULL)`, [
      id,input.sourceKey,input.scopeFrom,input.scopeTo,input.documentType.trim(),input.discoveryMethod.trim(),
      input.parserVersion.trim(),input.sourcePolicyVersion,input.coverageAssurance,input.expectedCount,
      input.expectedCountBasis?.trim() || null,coverageEvidence,exclusions,now,input.createdBy.trim(),
    ]);
    return id;
  },

  async upsertInventoryItem(input) {
    const db = requiredBinding("worldcons_ingest");
    const current = await snapshot(input.snapshotId);
    if (current.status !== "open") throw new Error("case_backfill.manifest_closed");
    if (
      input.stableItemKey.trim().length < 1 || input.stableItemKey.trim().length > 300
      || !validHttpsUrl(input.discoveredUrl)
      || input.documentType.trim().length < 1 || input.documentType.trim().length > 80
    ) throw new Error("case_backfill.invalid_item");
    const metadata = boundedJsonObject(input.inventoryMetadata ?? {}, 32_768, "case_backfill.invalid_inventory_metadata");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await run(db, `INSERT INTO source_backfill_items(
      id,snapshot_id,source_key,stable_item_key,source_record_id,discovered_url,document_type,discovered_decision_date_hint,
      status,attempt_count,first_seen_at,last_seen_at,updated_at,inventory_metadata
    ) VALUES (?,?,?,?,?,?,?,?, 'discovered',0,?,?,?,?)
    ON CONFLICT(snapshot_id,stable_item_key) DO UPDATE SET
      source_record_id=excluded.source_record_id,discovered_url=excluded.discovered_url,document_type=excluded.document_type,
      discovered_decision_date_hint=excluded.discovered_decision_date_hint,last_seen_at=excluded.last_seen_at,
      updated_at=excluded.updated_at,inventory_metadata=excluded.inventory_metadata`, [
      id,input.snapshotId,current.sourceKey,input.stableItemKey.trim(),input.sourceRecordId?.trim() || null,input.discoveredUrl,
      input.documentType.trim(),input.decisionDateHint,now,now,now,metadata,
    ]);
    const item = (await rows<Row>(db, `SELECT id FROM source_backfill_items WHERE snapshot_id=? AND stable_item_key=? LIMIT 1`, [
      input.snapshotId,input.stableItemKey.trim(),
    ]))[0];
    if (!item) throw new Error("case_backfill.inventory_write_failed");
    await run(db, `INSERT INTO source_backfill_item_events(id,item_id,attempt_id,event_type,phase,safe_details,occurred_at)
      VALUES (?,?,NULL,'item_discovered','discover',?,?)`, [
      decimalId(),text(item.id),JSON.stringify({ snapshotId: input.snapshotId }),now,
    ]);
    return text(item.id);
  },

  async recordEnumerationArtifact(input) {
    await assertLiveAttempt(input.authority, input.snapshotId, "discover");
    const db = requiredBinding("worldcons_ingest");
    const current = await snapshot(input.snapshotId);
    if (current.status !== "open") throw new Error("case_backfill.manifest_closed");
    const policy = await sourcePolicyRow(current.sourceKey, current.sourcePolicyVersion);
    const artifact = input.artifact;
    const provider = artifact.providerKey.trim().toLowerCase();
    const requestHost = hostname(artifact.requestUrl);
    const allowedHosts = new Set([
      ...jsonArray(policy.authority_hosts),...jsonArray(policy.redirect_hosts),...jsonArray(policy.external_index_hosts),
    ].map((entry) => entry.toLowerCase()));
    if (
      provider !== requestHost || !allowedHosts.has(requestHost) || !validHttpsUrl(artifact.requestUrl)
      || !["page","boundary_probe","crosscheck"].includes(artifact.artifactKind)
      || !Number.isInteger(artifact.sequenceNumber) || artifact.sequenceNumber < 1
      || !/^[0-9a-f]{64}$/.test(artifact.responseHash) || !/^[0-9a-f]{64}$/.test(artifact.recordManifestHash)
      || !Number.isInteger(artifact.recordCount) || artifact.recordCount < 0 || artifact.recordCount > 100_000
      || (artifact.observedLastPage !== null && (!Number.isInteger(artifact.observedLastPage) || artifact.observedLastPage < 1 || artifact.observedLastPage > 100_000))
    ) throw new Error("case_backfill.invalid_enumeration_artifact");
    const details = boundedJsonObject(artifact.safeDetails ?? {}, 16_384, "case_backfill.invalid_enumeration_artifact");
    const existing = (await rows<Row>(db, `SELECT * FROM source_inventory_enumeration_artifacts
      WHERE snapshot_id=? AND provider_key=? AND artifact_kind=? AND sequence_no=? LIMIT 1`, [
      input.snapshotId,provider,artifact.artifactKind,artifact.sequenceNumber,
    ]))[0];
    const comparable = {
      request_url: artifact.requestUrl,response_hash: artifact.responseHash,record_manifest_hash: artifact.recordManifestHash,
      record_count: artifact.recordCount,newest_decision_date: artifact.newestDecisionDate,oldest_decision_date: artifact.oldestDecisionDate,
      observed_last_page: artifact.observedLastPage,safe_details: details,
    };
    if (existing) {
      for (const [key, value] of Object.entries(comparable)) {
        if ((existing[key] ?? null) !== (value ?? null)) throw new Error("case_backfill.enumeration_artifact_conflict");
      }
      return text(existing.id);
    }
    const id = crypto.randomUUID();
    await run(db, `INSERT INTO source_inventory_enumeration_artifacts(
      id,snapshot_id,source_key,provider_key,artifact_kind,sequence_no,request_url,response_hash,record_manifest_hash,
      record_count,newest_decision_date,oldest_decision_date,observed_last_page,safe_details,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id,input.snapshotId,current.sourceKey,provider,artifact.artifactKind,artifact.sequenceNumber,artifact.requestUrl,
      artifact.responseHash,artifact.recordManifestHash,artifact.recordCount,artifact.newestDecisionDate,artifact.oldestDecisionDate,
      artifact.observedLastPage,details,new Date().toISOString(),
    ]);
    return id;
  },

  async updateSnapshotEvidence(snapshotId, coverageEvidence, expectedCount = null, expectedCountBasis = null) {
    if (
      (expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 0))
      || ((expectedCount === null) !== (expectedCountBasis === null))
      || (expectedCountBasis !== null && (expectedCountBasis.trim().length < 1 || expectedCountBasis.trim().length > 200))
    ) throw new Error("case_backfill.invalid_coverage_evidence");
    const evidence = boundedJsonObject(coverageEvidence ?? {}, 16_384, "case_backfill.invalid_coverage_evidence");
    const db = requiredBinding("worldcons_ingest");
    const result = await run(db, `UPDATE source_inventory_snapshots
      SET coverage_evidence=?,expected_count=?,expected_count_basis=? WHERE id=? AND status='open'`, [
      evidence,expectedCount,expectedCountBasis?.trim() || null,snapshotId,
    ]);
    if (changes(result) !== 1) throw new Error("case_backfill.snapshot_not_open");
  },

  async closeSnapshot(snapshotId) {
    const db = requiredBinding("worldcons_ingest");
    const snap = (await rows<Row>(db, `SELECT * FROM source_inventory_snapshots WHERE id=? LIMIT 1`, [snapshotId]))[0];
    if (!snap) throw new Error("case_backfill.snapshot_not_found");
    if (text(snap.status) === "closed") return this.getSnapshotStatus(snapshotId);
    if (text(snap.status) !== "open") throw new Error("case_backfill.snapshot_not_open");
    const items = await rows<Row>(db, `SELECT stable_item_key,source_record_id,discovered_url,document_type,
      discovered_decision_date_hint,inventory_metadata FROM source_backfill_items WHERE snapshot_id=? ORDER BY stable_item_key`, [snapshotId]);
    const artifacts = await rows<Row>(db, `SELECT provider_key,artifact_kind,sequence_no,request_url,response_hash,record_manifest_hash,
      record_count,newest_decision_date,oldest_decision_date,observed_last_page,safe_details
      FROM source_inventory_enumeration_artifacts WHERE snapshot_id=? ORDER BY provider_key,artifact_kind,sequence_no`, [snapshotId]);
    const expectedCount = snap.expected_count === null || snap.expected_count === undefined ? null : numberValue(snap.expected_count);
    if (expectedCount !== null && expectedCount !== items.length) throw new Error("case_backfill.expected_count_mismatch");
    if (text(snap.coverage_assurance) === "external_index_assisted" && artifacts.length === 0) {
      throw new Error("case_backfill.enumeration_evidence_required");
    }
    const itemManifestHash = await sha256Hex(canonicalJson(items.map((item) => [
      item.stable_item_key,item.source_record_id,item.discovered_url,item.document_type,item.discovered_decision_date_hint,jsonObject(item.inventory_metadata),
    ])));
    const enumerationManifestHash = artifacts.length === 0 ? null : await sha256Hex(canonicalJson(artifacts.map((artifact) => [
      artifact.provider_key,artifact.artifact_kind,artifact.sequence_no,artifact.request_url,artifact.response_hash,
      artifact.record_manifest_hash,artifact.record_count,artifact.newest_decision_date,artifact.oldest_decision_date,
      artifact.observed_last_page,jsonObject(artifact.safe_details),
    ])));
    const manifestHash = await sha256Hex(canonicalJson({ itemManifestHash, enumerationManifestHash }));
    const result = await run(db, `UPDATE source_inventory_snapshots SET discovered_count=?,manifest_hash=?,enumeration_manifest_hash=?,
      status='closed',closed_at=? WHERE id=? AND status='open'`, [
      items.length,manifestHash,enumerationManifestHash,new Date().toISOString(),snapshotId,
    ]);
    if (changes(result) !== 1) throw new Error("case_backfill.snapshot_close_failed");
    return this.getSnapshotStatus(snapshotId);
  },

  async getSnapshot(snapshotId) {
    return snapshot(snapshotId);
  },

  async getSourcePolicy(sourceKey, policyVersion) {
    return mapPolicy(await sourcePolicyRow(sourceKey, policyVersion));
  },

  async getSnapshotStatus(snapshotId): Promise<CaseBackfillSnapshotStatus> {
    const db = requiredBinding("worldcons_ingest");
    const snap = (await rows<Row>(db, `
      SELECT id,source_key,status,expected_count,coverage_assurance,manifest_hash,parser_version,source_policy_version
      FROM source_inventory_snapshots WHERE id=? LIMIT 1
    `, [snapshotId]))[0];
    if (!snap) throw new Error("case_backfill.snapshot_not_found");
    const items = await rows<Row>(db, `
      SELECT i.*,
             cf.fetch_contract_version AS current_fetch_contract_version,
             cn.fetch_artifact_id AS current_normalization_fetch_id,
             pn.parser_version AS published_parser_version,
             pf.source_policy_version AS published_source_policy_version
      FROM source_backfill_items i
      LEFT JOIN source_fetch_artifacts cf ON cf.id=i.current_fetch_artifact_id
      LEFT JOIN source_normalization_artifacts cn ON cn.id=i.current_normalization_artifact_id
      LEFT JOIN source_normalization_artifacts pn ON pn.id=i.published_normalization_artifact_id
      LEFT JOIN source_fetch_artifacts pf ON pf.id=pn.fetch_artifact_id
      WHERE i.snapshot_id=?
    `, [snapshotId]);
    const now = Date.now();
    const terminalStatuses = new Set(["published", "excluded", "duplicate", "withdrawn", "waived_failure"]);
    let terminalTotal = 0;
    let claimed = 0;
    let retryWait = 0;
    let needsNormalize = 0;
    let needsReverify = 0;
    let needsRepublish = 0;
    let failed = 0;
    let currentConformant = 0;
    for (const item of items) {
      const status = text(item.status);
      const terminal = terminalStatuses.has(status);
      if (terminal) terminalTotal += 1;
      const isClaimed = Boolean(item.claimed_attempt_id) && Date.parse(text(item.lease_expires_at)) > now;
      const retry = status === "retry_wait" || (item.retry_phase && item.next_attempt_at);
      const normalize = Boolean(item.current_fetch_artifact_id)
        && (!item.current_normalization_artifact_id || item.current_normalization_fetch_id !== item.current_fetch_artifact_id);
      const reverify = Boolean(item.current_normalization_artifact_id)
        && item.current_normalization_artifact_id !== item.verified_normalization_artifact_id;
      const republish = status === "published" && Boolean(item.verified_normalization_artifact_id)
        && item.verified_normalization_artifact_id !== item.published_normalization_artifact_id;
      if (isClaimed) claimed += 1;
      else if (retry) retryWait += 1;
      else if (normalize) needsNormalize += 1;
      else if (reverify) needsReverify += 1;
      else if (republish) needsRepublish += 1;
      else if (status === "terminal_failure" || status === "waived_failure") failed += 1;
      if (
        terminal && !normalize && !reverify && !republish
        && (status !== "published" || (
          text(item.published_parser_version) === text(snap.parser_version)
          && text(item.published_source_policy_version) === text(snap.source_policy_version)
        ))
      ) currentConformant += 1;
    }
    const discoveredTotal = items.length;
    const expectedCount = snap.expected_count === null || snap.expected_count === undefined ? null : numberValue(snap.expected_count);
    return {
      snapshotId: text(snap.id),
      sourceKey: text(snap.source_key),
      snapshotStatus: text(snap.status),
      discoveredTotal,
      terminalTotal,
      processingCompletion: discoveredTotal === 0 ? 0 : Number((terminalTotal / discoveredTotal).toFixed(6)),
      expectedCount,
      coverageAssurance: text(snap.coverage_assurance) as CaseBackfillSnapshotStatus["coverageAssurance"],
      corpusCoverage: expectedCount && expectedCount > 0 ? Number((discoveredTotal / expectedCount).toFixed(6)) : null,
      claimed,
      retryWait,
      needsNormalize,
      needsReverify,
      needsRepublish,
      failed,
      currentConformant,
      currentConformance: terminalTotal === 0 ? 0 : Number((currentConformant / terminalTotal).toFixed(6)),
      manifestHash: nullableText(snap.manifest_hash),
    };
  },

  async acquireSourceRequestPermit(input: AcquireSourceRequestPermitInput): Promise<SourceRequestPermitResult> {
    if (input.phase !== "discover" && input.phase !== "fetch") throw new Error("case_backfill.d1_phase_unsupported");
    const live = await assertLiveAttempt(input.authority, input.snapshotId, input.phase);
    const currentSnapshot = await snapshot(input.snapshotId);
    const policyRow = await sourcePolicyRow(currentSnapshot.sourceKey, currentSnapshot.sourcePolicyVersion);
    const policy = mapPolicy(policyRow);
    let origin: URL;
    try { origin = new URL(input.requestOrigin); } catch { throw new Error("case_backfill.request_origin_invalid"); }
    if (origin.protocol !== "https:" || origin.origin.toLowerCase() !== input.requestOrigin.toLowerCase()) {
      throw new Error("case_backfill.request_origin_invalid");
    }
    const allowedHosts = new Set([
      ...jsonArray(policyRow.authority_hosts),
      ...jsonArray(policyRow.redirect_hosts),
      ...(input.phase === "discover" ? jsonArray(policyRow.external_index_hosts) : []),
    ]);
    if (!allowedHosts.has(origin.hostname.toLowerCase())) throw new Error("case_backfill.request_host_not_allowed");
    const db = requiredBinding("worldcons_ingest");
    const now = new Date();
    const nowIso = now.toISOString();
    await run(db, `
      INSERT OR IGNORE INTO source_request_governor_states
        (source_key,last_request_started_at,next_request_not_before,updated_at)
      VALUES (?,NULL,'1970-01-01T00:00:00.000Z',?)
    `, [currentSnapshot.sourceKey, nowIso]);
    const nextNotBefore = new Date(now.getTime() + Math.max(0, policy.minRequestDelayMs)).toISOString();
    const lock = await run(db, `
      UPDATE source_request_governor_states
      SET last_request_started_at=?,next_request_not_before=?,updated_at=?
      WHERE source_key=? AND next_request_not_before<=?
        AND (
          SELECT COUNT(*) FROM source_request_permits p
          WHERE p.source_key=? AND p.released_at IS NULL AND p.lease_expires_at>?
        ) < ?
    `, [nowIso, nextNotBefore, nowIso, currentSnapshot.sourceKey, nowIso, currentSnapshot.sourceKey, nowIso, policy.maxConcurrency]);
    if (changes(lock) !== 1) {
      const state = (await rows<Row>(db, "SELECT next_request_not_before FROM source_request_governor_states WHERE source_key=? LIMIT 1", [currentSnapshot.sourceKey]))[0];
      const active = await rows<Row>(db, `
        SELECT lease_expires_at FROM source_request_permits
        WHERE source_key=? AND released_at IS NULL AND lease_expires_at>?
        ORDER BY lease_expires_at ASC LIMIT 1
      `, [currentSnapshot.sourceKey, nowIso]);
      const candidates = [
        state ? Date.parse(text(state.next_request_not_before)) - now.getTime() : null,
        active[0] ? Date.parse(text(active[0].lease_expires_at)) - now.getTime() : null,
      ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
      const retryAfterMs = candidates.length > 0
        ? Math.max(25, Math.min(Math.max(...candidates), 5_000))
        : 250;
      return { granted: false, permitId: null, retryAfterMs, permitLeaseExpiresAt: null };
    }
    const permitId = crypto.randomUUID();
    const permitLeaseExpiresAt = new Date(Math.min(
      Date.parse(live.leaseExpiresAt),
      now.getTime() + Math.max(1, Math.min(input.requestedLeaseSeconds, 86_400)) * 1000,
    )).toISOString();
    await run(db, `
      INSERT INTO source_request_permits
        (id,source_key,source_policy_version,snapshot_id,phase,p1_attempt_id,p1_fencing_token,request_origin,acquired_at,lease_expires_at,released_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
    `, [permitId, currentSnapshot.sourceKey, currentSnapshot.sourcePolicyVersion, input.snapshotId, input.phase, input.authority.attemptId, input.authority.fencingToken, input.requestOrigin, nowIso, permitLeaseExpiresAt]);
    return { granted: true, permitId, retryAfterMs: 0, permitLeaseExpiresAt };
  },

  async releaseSourceRequestPermit(input) {
    const db = requiredBinding("worldcons_ingest");
    const permit = (await rows<Row>(db, "SELECT * FROM source_request_permits WHERE id=? LIMIT 1", [input.permitId]))[0];
    if (!permit) throw new Error("case_backfill.request_permit_not_found");
    await assertLiveAttempt(input.authority, text(permit.snapshot_id), text(permit.phase) as CaseBackfillPassInput["phase"]);
    const result = await run(db, `
      UPDATE source_request_permits SET released_at=?
      WHERE id=? AND released_at IS NULL AND p1_attempt_id=? AND p1_fencing_token=?
    `, [new Date().toISOString(), input.permitId, input.authority.attemptId, input.authority.fencingToken]);
    if (changes(result) !== 1) throw new Error("case_backfill.request_permit_release_failed");
  },

  async beginRun(input, authority) {
    assertSupportedD1RunPhase(input.phase);
    const live = await assertLiveAttempt(authority, input.snapshotId, input.phase);
    if (numberValue(live.payload.passNumber) !== input.passNumber) throw new Error("case_backfill.pass_scope_mismatch");
    const db = requiredBinding("worldcons_ingest");
    const currentSnapshot = await snapshot(input.snapshotId);
    if (
      (input.phase === "discover" && currentSnapshot.status !== "open")
      || (input.phase !== "discover" && currentSnapshot.status !== "closed")
    ) throw new Error("case_backfill.snapshot_phase_mismatch");
    const existing = await rows<Row>(db, `
      SELECT id FROM source_backfill_runs WHERE snapshot_id=? AND phase=? AND pass_number=? ORDER BY started_at LIMIT 2
    `, [input.snapshotId, input.phase, input.passNumber]);
    if (existing.length > 1) throw new Error("case_backfill.run_duplicate");
    const now = new Date().toISOString();
    if (existing[0]) {
      await run(db, `
        UPDATE source_backfill_runs
        SET command_run_id=?,p1_attempt_id=?,p1_fencing_token=?,status='running',
            claimed_count=0,succeeded_count=0,retryable_failed_count=0,terminal_failed_count=0,
            heartbeat_at=?,completed_at=NULL,last_error_code=NULL,last_error_summary=NULL
        WHERE id=?
      `, [live.commandRunId, authority.attemptId, authority.fencingToken, now, existing[0].id]);
      return text(existing[0].id);
    }
    const id = crypto.randomUUID();
    await run(db, `
      INSERT INTO source_backfill_runs
        (id,snapshot_id,command_run_id,p1_attempt_id,p1_fencing_token,phase,pass_number,status,
         claimed_count,succeeded_count,retryable_failed_count,terminal_failed_count,heartbeat_at,started_at)
      VALUES (?,?,?,?,?,?,?,'running',0,0,0,0,?,?)
    `, [id, input.snapshotId, live.commandRunId, authority.attemptId, authority.fencingToken, input.phase, input.passNumber, now, now]);
    return id;
  },

  async allocatePass(snapshotId, phase) {
    assertSupportedD1RunPhase(phase);
    const db = requiredBinding("worldcons_ingest");
    const currentSnapshot = await snapshot(snapshotId);
    if (
      (phase === "discover" && currentSnapshot.status !== "open")
      || (phase !== "discover" && currentSnapshot.status !== "closed")
    ) throw new Error("case_backfill.snapshot_phase_mismatch");
    const row = (await rows<Row>(db, "SELECT COALESCE(MAX(pass_number),0)+1 AS next_pass FROM source_backfill_runs WHERE snapshot_id=? AND phase=?", [snapshotId, phase]))[0];
    return Math.max(1, numberValue(row?.next_pass));
  },

  async finishRun(input) {
    const runRow = (await rows<Row>(requiredBinding("worldcons_ingest"), "SELECT snapshot_id,phase FROM source_backfill_runs WHERE id=? LIMIT 1", [input.runId]))[0];
    if (!runRow) throw new Error("case_backfill.run_not_found");
    assertSupportedD1RunPhase(text(runRow.phase));
    await assertLiveAttempt(input.authority, text(runRow.snapshot_id), text(runRow.phase) as CaseBackfillPassInput["phase"]);
    if (input.claimed !== input.succeeded + input.retryableFailed + input.terminalFailed) throw new Error("case_backfill.invalid_run_result");
    const db = requiredBinding("worldcons_ingest");
    const active = (await rows<Row>(db, "SELECT COUNT(*) AS count FROM source_backfill_items WHERE claimed_attempt_id=?", [input.authority.attemptId]))[0];
    if (numberValue(active?.count) !== 0) throw new Error("case_backfill.active_item_claims");
    const now = new Date().toISOString();
    const result = await run(db, `
      UPDATE source_backfill_runs SET status=?,claimed_count=?,succeeded_count=?,retryable_failed_count=?,terminal_failed_count=?,
        heartbeat_at=?,completed_at=?,last_error_code=?,last_error_summary=?
      WHERE id=? AND p1_attempt_id=? AND p1_fencing_token=? AND status='running'
    `, [input.status, input.claimed, input.succeeded, input.retryableFailed, input.terminalFailed, now, now, input.lastErrorCode ?? null, input.lastErrorSummary ?? null, input.runId, input.authority.attemptId, input.authority.fencingToken]);
    if (changes(result) !== 1) throw new Error("case_backfill.run_fence_lost");
  },

  async countBacklog(input) {
    assertSupportedD1Phase(input.phase);
    const db = requiredBinding("worldcons_ingest");
    const now = new Date().toISOString();
    const version = targetVersion(input);
    const row = (await rows<Row>(db, `
      SELECT COUNT(*) AS count
      FROM source_backfill_items i
      LEFT JOIN source_fetch_artifacts f ON f.id=i.current_fetch_artifact_id
      LEFT JOIN source_normalization_artifacts n ON n.id=i.current_normalization_artifact_id
      WHERE i.snapshot_id=? AND (i.next_attempt_at IS NULL OR i.next_attempt_at<=?)
        AND (
          (?='fetch' AND (i.status IN ('discovered','queued') OR (i.status='retry_wait' AND i.retry_phase='fetch')
            OR (i.status='published' AND ? IS NOT NULL AND COALESCE(f.fetch_contract_version,'')<>?)))
          OR (?='normalize' AND (i.status='fetched' OR (i.status='retry_wait' AND i.retry_phase='normalize')
            OR (i.status='published' AND i.current_fetch_artifact_id IS NOT NULL AND (
              n.fetch_artifact_id IS NULL OR n.fetch_artifact_id<>i.current_fetch_artifact_id
              OR (? IS NOT NULL AND COALESCE(n.parser_version || ':' || n.normalization_contract_version,'')<>?)
            ))))
          OR (?='verify' AND (i.status='normalized' OR (i.status='retry_wait' AND i.retry_phase='verify')
            OR (i.status='published' AND i.current_normalization_artifact_id IS NOT NULL
              AND i.current_normalization_artifact_id IS NOT i.verified_normalization_artifact_id)))
          OR (?='publish' AND (i.status='verified' OR (i.status='retry_wait' AND i.retry_phase='publish')
            OR (i.status='published' AND i.verified_normalization_artifact_id IS NOT NULL
              AND i.verified_normalization_artifact_id IS NOT i.published_normalization_artifact_id)))
        )
    `, [input.snapshotId, now, input.phase, version, version, input.phase, version, version, input.phase, input.phase]))[0];
    return numberValue(row?.count);
  },

  async countResidualClaims(snapshotId) {
    const db = requiredBinding("worldcons_ingest");
    const row = (await rows<Row>(db, "SELECT COUNT(*) AS count FROM source_backfill_items WHERE snapshot_id=? AND claimed_attempt_id IS NOT NULL", [snapshotId]))[0];
    return numberValue(row?.count);
  },

  async listNonTerminalRuns(snapshotId, phase): Promise<CaseBackfillOpenRun[]> {
    const ingest = requiredBinding("worldcons_ingest");
    const ops = requiredBinding("worldcons_ops");
    const runRows = await rows<Row>(ingest, `
      SELECT id,pass_number,status,p1_attempt_id,p1_fencing_token,command_run_id
      FROM source_backfill_runs
      WHERE snapshot_id=? AND phase=? AND status IN ('queued','running','deferred')
      ORDER BY pass_number
    `, [snapshotId, phase]);
    const output: CaseBackfillOpenRun[] = [];
    for (const row of runRows) {
      const attemptId = nullableText(row.p1_attempt_id);
      const attempt = attemptId
        ? (await rows<Row>(ops, "SELECT status,lease_expires_at FROM admin_command_attempts WHERE id=? LIMIT 1", [attemptId]))[0]
        : null;
      output.push({
        runId: text(row.id), passNumber: numberValue(row.pass_number), status: text(row.status),
        p1AttemptId: attemptId, p1FencingToken: nullableText(row.p1_fencing_token), commandRunId: nullableText(row.command_run_id),
        attemptStatus: attempt ? text(attempt.status) : null,
        attemptLeaseExpiresAt: attempt ? nullableText(attempt.lease_expires_at) : null,
      });
    }
    return output;
  },

  async claimItems(input, authority) {
    assertSupportedD1Phase(input.phase);
    const result: CaseBackfillClaimedItem[] = [];
    for (let index = 0; index < input.batchLimit; index += 1) {
      const item = await claimOne({ ...input, batchLimit: 1 }, authority);
      if (!item) break;
      result.push(item);
    }
    return result;
  },

  async extendItems(itemIds, phase, authority) {
    assertSupportedD1Phase(phase);
    if (itemIds.length < 1 || itemIds.length > 100) throw new Error("case_backfill.invalid_extend");
    const db = requiredBinding("worldcons_ingest");
    const placeholders = itemIds.map(() => "?").join(",");
    const scope = await rows<Row>(db, `SELECT DISTINCT snapshot_id FROM source_backfill_items WHERE id IN (${placeholders})`, itemIds);
    if (scope.length !== 1) throw new Error("case_backfill.item_scope_mismatch");
    const live = await assertLiveAttempt(authority, text(scope[0].snapshot_id), phase);
    const now = new Date();
    const lease = new Date(Math.min(Date.parse(live.leaseExpiresAt), now.getTime() + 180_000)).toISOString();
    let updated = 0;
    for (const itemId of itemIds) {
      const result = await run(db, `
        UPDATE source_backfill_items SET lease_expires_at=?,updated_at=?
        WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase=? AND lease_expires_at>?
      `, [lease, now.toISOString(), itemId, authority.attemptId, authority.fencingToken, phase, now.toISOString()]);
      if (changes(result) !== 1) throw new Error("case_backfill.item_lease_lost");
      updated += 1;
      await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
        [decimalId(), itemId, authority.attemptId, "item_lease_extended", phase, JSON.stringify({ leaseExpiresAt: lease }), now.toISOString()]);
    }
    return updated;
  },

  async recordFetchArtifact(input: RecordFetchArtifactInput) {
    const item = await itemForMutation(input.itemId, "fetch", input.authority);
    const currentSnapshot = await snapshot(text(item.snapshot_id));
    if (input.sourcePolicyVersion !== currentSnapshot.sourcePolicyVersion) throw new Error("case_backfill.fetch_policy_mismatch");
    if (input.httpStatus < 100 || input.httpStatus > 599) throw new Error("case_backfill.invalid_fetch_artifact");
    if (input.replayability === "bounded_evidence" && !input.boundedReplayPayload && !input.boundedReplayStorageRef) {
      throw new Error("case_backfill.invalid_fetch_artifact");
    }
    const db = requiredBinding("worldcons_ingest");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await batch(db, [
      db.prepare(`
        INSERT INTO source_fetch_artifacts
          (id,item_id,source_policy_version,authority_url,http_status,response_headers_allowlist,source_etag,source_last_modified_at,
           payload_hash,payload_size,replayability,immutable_storage_ref,bounded_replay_payload,fetched_at,fetch_contract_version,created_at,
           bounded_replay_storage_ref,externalization_contract_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id,input.itemId,input.sourcePolicyVersion,input.authorityUrl,input.httpStatus,JSON.stringify(input.responseHeaders),input.sourceEtag,
        input.sourceLastModifiedAt,input.payloadHash,String(input.payloadSize),input.replayability,input.immutableStorageRef,
        input.boundedReplayPayload ? JSON.stringify(input.boundedReplayPayload) : null,now,input.fetchContractVersion,now,
        input.boundedReplayStorageRef ?? null,input.externalizationContractVersion ?? null,
      ),
      itemEvent(db,{ itemId: input.itemId, attemptId: input.authority.attemptId, eventType: "fetch_recorded", phase: "fetch", details: { artifactId: id, payloadHash: input.payloadHash } }),
    ]);
    return id;
  },

  async getFetchArtifact(artifactId): Promise<CaseBackfillFetchArtifact> {
    const db = requiredBinding("worldcons_ingest");
    const row = (await rows<Row>(db, "SELECT * FROM source_fetch_artifacts WHERE id=? LIMIT 1", [artifactId]))[0];
    if (!row) throw new Error("case_backfill.fetch_artifact_not_found");
    const replayability = text(row.replayability);
    if (replayability !== "full_snapshot" && replayability !== "bounded_evidence" && replayability !== "non_replayable") {
      throw new Error("case_backfill.fetch_artifact_invalid");
    }
    return {
      id: text(row.id), itemId: text(row.item_id), sourcePolicyVersion: text(row.source_policy_version), authorityUrl: text(row.authority_url),
      payloadHash: text(row.payload_hash), payloadSize: row.payload_size === null ? null : numberValue(row.payload_size), replayability,
      immutableStorageRef: nullableText(row.immutable_storage_ref), boundedReplayPayload: row.bounded_replay_payload ? jsonObject(row.bounded_replay_payload) : null,
      boundedReplayStorageRef: nullableText(row.bounded_replay_storage_ref), externalizationContractVersion: nullableText(row.externalization_contract_version),
      fetchContractVersion: text(row.fetch_contract_version),
    };
  },

  async getNormalizationArtifact(artifactId, itemId): Promise<CaseBackfillNormalizationArtifact> {
    const db = requiredBinding("worldcons_ingest");
    const values: unknown[] = [artifactId];
    let sql = "SELECT * FROM source_normalization_artifacts WHERE id=?";
    if (itemId) {
      sql += " AND item_id=?";
      values.push(itemId);
    }
    sql += " LIMIT 1";
    const row = (await rows<Row>(db, sql, values))[0];
    if (!row) throw new Error("case_backfill.normalization_artifact_not_found");
    const validationStatus = text(row.validation_status);
    if (validationStatus !== "valid" && validationStatus !== "invalid") throw new Error("case_backfill.normalization_artifact_invalid");
    return {
      id: text(row.id), itemId: text(row.item_id), fetchArtifactId: text(row.fetch_artifact_id),
      parserVersion: text(row.parser_version), normalizationContractVersion: text(row.normalization_contract_version),
      normalizedOutput: row.normalized_output ? jsonObject(row.normalized_output) as unknown as NormalizedArticle : null,
      normalizedOutputHash: text(row.normalized_output_hash),
      normalizedOutputStorageRef: nullableText(row.normalized_output_storage_ref),
      normalizedOutputSize: row.normalized_output_size === null ? null : numberValue(row.normalized_output_size),
      externalizationContractVersion: nullableText(row.externalization_contract_version),
      validationStatus,
    };
  },

  async recordNormalizationArtifact(input: RecordNormalizationArtifactInput) {
    const item = await itemForMutation(input.itemId, "normalize", input.authority);
    if (text(item.current_fetch_artifact_id) !== input.fetchArtifactId) throw new Error("case_backfill.item_lease_lost");
    if (!input.normalizedOutput && !input.normalizedOutputStorageRef) throw new Error("case_backfill.invalid_normalization_artifact");
    const db = requiredBinding("worldcons_ingest");
    const existing = (await rows<Row>(db, `
      SELECT id FROM source_normalization_artifacts
      WHERE fetch_artifact_id=? AND parser_version=? AND normalization_contract_version=?
      LIMIT 1
    `, [input.fetchArtifactId, input.parserVersion, input.normalizationContractVersion]))[0];
    const id = existing ? text(existing.id) : crypto.randomUUID();
    const now = new Date().toISOString();
    if (!existing) {
      await run(db, `
        INSERT INTO source_normalization_artifacts
          (id,item_id,fetch_artifact_id,parser_version,normalization_contract_version,normalized_output,
           normalized_output_hash,validation_status,validation_errors,created_at,normalized_output_storage_ref,
           normalized_output_size,externalization_contract_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [id,input.itemId,input.fetchArtifactId,input.parserVersion,input.normalizationContractVersion,
        input.normalizedOutput ? JSON.stringify(input.normalizedOutput) : null,input.normalizedOutputHash,input.validationStatus,
        JSON.stringify(input.validationErrors ?? []),now,input.normalizedOutputStorageRef ?? null,
        input.normalizedOutputSize === undefined || input.normalizedOutputSize === null ? null : String(input.normalizedOutputSize),
        input.externalizationContractVersion ?? null]);
    }
    await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
      [decimalId(), input.itemId, input.authority.attemptId, "normalization_recorded", "normalize",
        JSON.stringify({ artifactId: id, normalizedOutputHash: input.normalizedOutputHash, validationStatus: input.validationStatus }), now]);
    return id;
  },
  async publishItem(input): Promise<CaseBackfillPublicationResult> {
    const item = await itemForMutation(input.itemId, "publish", input.authority);
    const normalizationArtifactId = text(item.verified_normalization_artifact_id);
    if (!normalizationArtifactId || normalizationArtifactId !== text(item.current_normalization_artifact_id)) {
      throw new Error("case_backfill.catalog_verified_normalization_required");
    }
    const normalized = input.normalizedOutput;
    if (!normalized || !normalized.sourceKey || !normalized.canonicalUrl || !normalized.originalUrl
      || !normalized.jurisdiction || !normalized.institutionName || !normalized.originalLanguage || !normalized.originalTitle) {
      throw new Error("case_backfill.catalog_normalized_output_invalid");
    }

    const ingest = requiredBinding("worldcons_ingest");
    const core = requiredBinding("worldcons_core");
    const normalization = (await rows<Row>(ingest, `
      SELECT id,item_id,normalized_output_hash,validation_status
      FROM source_normalization_artifacts WHERE id=? AND item_id=? LIMIT 1
    `, [normalizationArtifactId, input.itemId]))[0];
    if (!normalization || text(normalization.validation_status) !== "valid") {
      throw new Error("case_backfill.catalog_verified_normalization_required");
    }
    const snapshotRow = (await rows<Row>(ingest, `
      SELECT id,source_key,source_policy_version,status,manifest_hash,discovery_method
      FROM source_inventory_snapshots WHERE id=? LIMIT 1
    `, [text(item.snapshot_id)]))[0];
    if (!snapshotRow || text(snapshotRow.status) !== "closed" || !text(snapshotRow.manifest_hash)) {
      throw new Error("case_backfill.catalog_closed_manifest_required");
    }
    if (normalized.sourceKey !== text(snapshotRow.source_key)) throw new Error("case_backfill.catalog_normalized_output_invalid");
    const policy = (await rows<Row>(core, `
      SELECT default_text_access_policy,review_due_at
      FROM source_corpus_policies WHERE source_key=? AND policy_version=? LIMIT 1
    `, [text(snapshotRow.source_key), text(snapshotRow.source_policy_version)]))[0];
    if (!policy || Date.parse(text(policy.review_due_at)) <= Date.now()) throw new Error("case_backfill.policy_review_expired");

    const idempotencyKey = `case-backfill:${input.itemId}:${normalizationArtifactId}`;
    const priorEvent = (await rows<Row>(core, `
      SELECT e.publication_id,e.publication_revision,e.next_source_anchor_version_id,e.to_state,p.article_id,a.slug,v.revision AS version_revision
      FROM case_catalog_publication_events_v1 e
      JOIN case_catalog_publications_v1 p ON p.id=e.publication_id
      JOIN articles a ON a.id=p.article_id
      JOIN article_content_versions_p3 v ON v.id=e.next_source_anchor_version_id AND v.article_id=p.article_id
      WHERE e.idempotency_key=? LIMIT 1
    `, [idempotencyKey]))[0];
    if (priorEvent) {
      const priorState = text(priorEvent.to_state) === "published" ? "published" : "withdrawn";
      await finalizeCatalogItem(ingest, {
        itemId: input.itemId,
        authority: input.authority,
        articleId: text(priorEvent.article_id),
        normalizationArtifactId,
        versionId: text(priorEvent.next_source_anchor_version_id),
        publicationRevision: numberValue(priorEvent.publication_revision),
        publicationState: priorState,
        recovered: true,
      });
      return {
        articleId: text(priorEvent.article_id),
        versionId: text(priorEvent.next_source_anchor_version_id),
        versionRevision: numberValue(priorEvent.version_revision),
        publicationRevision: numberValue(priorEvent.publication_revision),
        articleSlug: text(priorEvent.slug),
      };
    }

    const recordId = text(item.source_record_id) || text(item.stable_item_key);
    const normalizedRecordId = normalizedIdentifier(recordId);
    if (!normalizedRecordId) throw new Error("case_backfill.catalog_identifier_invalid");
    const byIdentifier = (await rows<Row>(core, `
      SELECT a.id,a.slug,a.source_key,a.status,a.summary_json FROM case_identifiers_v1 ci JOIN articles a ON a.id=ci.article_id
      WHERE ci.source_key=? AND ci.identifier_type='source_record_id' AND ci.normalized_value=? LIMIT 2
    `, [normalized.sourceKey, normalizedRecordId]));
    if (byIdentifier.length > 1) throw new Error("case_backfill.catalog_identity_conflict");
    const byCanonical = await rows<Row>(core, "SELECT id,slug,source_key,status,summary_json FROM articles WHERE canonical_url=? LIMIT 2", [normalized.canonicalUrl]);
    if (byCanonical.length > 1) throw new Error("case_backfill.catalog_identity_conflict");
    if (byIdentifier[0] && byCanonical[0] && text(byIdentifier[0].id) !== text(byCanonical[0].id)) {
      throw new Error("case_backfill.catalog_identity_conflict");
    }
    const existingArticle = byIdentifier[0] ?? byCanonical[0] ?? null;
    if (existingArticle && text(existingArticle.source_key) !== normalized.sourceKey) throw new Error("case_backfill.catalog_identity_conflict");
    const articleId = existingArticle ? text(existingArticle.id) : crypto.randomUUID();
    const articleSlug = existingArticle
      ? text(existingArticle.slug)
      : `${slugPart(normalized.sourceKey)}-${slugPart(recordId)}`;
    if (!articleSlug) throw new Error("case_backfill.catalog_identifier_invalid");
    const summaryReady = Boolean(
      existingArticle
      && text(existingArticle.status) === "summarized"
      && existingArticle.summary_json !== null
      && existingArticle.summary_json !== undefined,
    );
    const publicationState = summaryReady ? "published" as const : "withdrawn" as const;
    const publicationReason = summaryReady
      ? "Verified constitutional case publication with completed summary."
      : "Authoritative case staged; public publication awaits completed summary.";
    if (!existingArticle) {
      const slugConflict = (await rows<Row>(core, "SELECT id FROM articles WHERE slug=? LIMIT 1", [articleSlug]))[0];
      if (slugConflict) throw new Error("case_backfill.catalog_identity_conflict");
    }
    const source = (await rows<Row>(core, "SELECT id FROM sources WHERE source_key=? LIMIT 1", [normalized.sourceKey]))[0];
    if (!source) throw new Error("case_backfill.catalog_source_missing");
    const identifierConflict = (await rows<Row>(core, `
      SELECT article_id FROM case_identifiers_v1
      WHERE source_key=? AND identifier_type='source_record_id' AND normalized_value=? AND article_id<>? LIMIT 1
    `, [normalized.sourceKey, normalizedRecordId, articleId]))[0];
    if (identifierConflict) throw new Error("case_backfill.catalog_identifier_conflict");

    const now = new Date().toISOString();
    const authorityEvidence = {
      authorityUrl: normalized.canonicalUrl,
      snapshotId: text(snapshotRow.id),
      manifestHash: text(snapshotRow.manifest_hash),
      normalizationArtifactId,
    };
    const authorityHash = await sha256Hex(JSON.stringify(authorityEvidence));
    const existingIdentifiers = await rows<Row>(core, `
      SELECT identifier_type,identifier_scope,raw_value,normalized_value,normalization_version,is_primary
      FROM case_identifiers_v1 WHERE article_id=? ORDER BY identifier_type,normalized_value
    `, [articleId]);
    const hasSourceRecordIdentifier = existingIdentifiers.some(
      (entry) => text(entry.identifier_type) === "source_record_id" && text(entry.normalized_value) === normalizedRecordId,
    );
    const sourceRecordPrimary = !existingIdentifiers.some((entry) => numberValue(entry.is_primary) === 1);
    // Future authoritative_source publications persist the canonical docket
    // identifier and version case_key from the sealed authoritative metadata, so
    // source-only Catalog rows match primaryCaseReference without a backfill.
    const authoritativeCase = normalized.sourceKey === "de-bverfg"
      ? authoritativeCaseMetadata(normalized.sourceKey, normalized.metadata)
      : undefined;
    const derivedCaseKey = authoritativeCase?.caseKey ?? null;
    const hasDocketIdentifier = authoritativeCase
      ? existingIdentifiers.some(
          (entry) => text(entry.identifier_type) === "docket" && text(entry.normalized_value) === authoritativeCase.caseKey,
        )
      : false;
    const identifierSnapshot = [
      ...existingIdentifiers.map((entry) => ({
        type: entry.identifier_type, scope: entry.identifier_scope, value: entry.raw_value,
        normalizedValue: entry.normalized_value, normalizationVersion: numberValue(entry.normalization_version), primary: numberValue(entry.is_primary) === 1,
      })),
      ...(!hasSourceRecordIdentifier ? [{
        type: "source_record_id", scope: "decision", value: recordId, normalizedValue: normalizedRecordId,
        normalizationVersion: 1, primary: sourceRecordPrimary,
      }] : []),
      ...(authoritativeCase && !hasDocketIdentifier ? [{
        type: "docket", scope: "decision", value: authoritativeCase.caseNumber,
        normalizedValue: authoritativeCase.caseKey, normalizationVersion: 1, primary: false,
      }] : []),
    ].sort((left, right) => `${left.type}:${left.normalizedValue}`.localeCompare(`${right.type}:${right.normalizedValue}`));
    const caseSnapshot = {
      authorityStatus: "verified",
      constitutionalRelevanceStatus: "verified",
      textAccessPolicy: text(policy.default_text_access_policy),
      sourcePolicyVersion: text(snapshotRow.source_policy_version),
      sourceMetadata: normalized.metadata ?? {},
    };
    const currentHead = (await rows<Row>(core, "SELECT current_version_id,current_revision FROM article_revision_heads_v4 WHERE article_id=? LIMIT 1", [articleId]))[0];
    const currentRevision = numberValue(currentHead?.current_revision);
    const versionDocument = {
      schema: "v4.article-case.v1", articleId, role: "authoritative_source", sourceAnchorVersionId: "SELF",
      sourceContentHash: text(normalization.normalized_output_hash), enrichmentSourceContentHash: null,
      slug: articleSlug, sourceKey: normalized.sourceKey, jurisdiction: normalized.jurisdiction,
      institutionName: normalized.institutionName, contentType: normalized.contentType,
      originalUrl: normalized.originalUrl, canonicalUrl: normalized.canonicalUrl,
      originalLanguage: normalized.originalLanguage, originalTitle: normalized.originalTitle,
      koreanTitle: null, originalPublishedAt: normalized.originalPublishedAt ?? null,
      cleanedText: normalized.cleanedText ?? null, summary: null,
      ...(derivedCaseKey ? { caseKey: derivedCaseKey } : {}),
      caseMetadata: caseSnapshot, caseIdentifiers: identifierSnapshot,
      authorityEvidenceHash: authorityHash, sourceSnapshotId: text(snapshotRow.id), sourceSnapshotHash: text(snapshotRow.manifest_hash),
    };
    const contentHash = await sha256Hex(JSON.stringify(versionDocument));
    const version = (await rows<Row>(core, "SELECT id,revision FROM article_content_versions_p3 WHERE article_id=? AND content_hash=? LIMIT 1", [articleId, contentHash]))[0];
    const versionCreated = !version;
    const versionId = version ? text(version.id) : await deterministicVersionId(articleId, contentHash);
    const versionRevision = version ? numberValue(version.revision) : currentRevision + 1;
    const publication = (await rows<Row>(core, "SELECT * FROM case_catalog_publications_v1 WHERE article_id=? LIMIT 1", [articleId]))[0];
    const publicationId = publication ? text(publication.id) : crypto.randomUUID();
    const publicationRevision = publication ? numberValue(publication.revision) + 1 : 1;
    const statements: D1RuntimePreparedStatement[] = [];
    if (!existingArticle) {
      statements.push(core.prepare(`INSERT INTO articles
        (id,source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,
         original_published_at,discovered_at,fetched_at,status,slug,raw_text,cleaned_text,summary_json,source_metadata,error_metadata,created_at,updated_at,catalog_ai_stale_v4)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        articleId,text(source.id),normalized.sourceKey,normalized.jurisdiction,normalized.institutionName,normalized.contentType,
        normalized.originalUrl,normalized.canonicalUrl,normalized.originalLanguage,normalized.originalTitle,normalized.originalPublishedAt ?? null,
        now,now,normalized.cleanedText?.trim() ? "cleaned" : "metadata_only",articleSlug,null,normalized.cleanedText ?? null,null,
        JSON.stringify({ ...(normalized.metadata ?? {}), catalog: { sourceOnly: true }, case: normalized.metadata ?? {} }),null,now,now,0,
      ));
    }
    if (!hasSourceRecordIdentifier) {
      statements.push(core.prepare(`INSERT INTO case_identifiers_v1
        (id,article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,normalization_version,is_primary,provenance_url,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(),articleId,normalized.sourceKey,"source_record_id","decision",recordId,normalizedRecordId,1,
        sourceRecordPrimary ? 1 : 0,normalized.canonicalUrl,now,
      ));
    }
    if (authoritativeCase && !hasDocketIdentifier) {
      statements.push(core.prepare(`INSERT INTO case_identifiers_v1
        (id,article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,normalization_version,is_primary,provenance_url,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(),articleId,normalized.sourceKey,"docket","decision",authoritativeCase.caseNumber,
        authoritativeCase.caseKey,1,0,normalized.canonicalUrl,now,
      ));
    }
    statements.push(core.prepare(`INSERT INTO case_metadata_v1
      (article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,enrichment_status,enrichment_freshness,freshness_basis,
       text_access_policy,source_policy_version,discovery_source,authority_source,source_last_modified_at,source_etag,source_snapshot_hash,ai_priority,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(article_id) DO UPDATE SET source_key=excluded.source_key,authority_status=excluded.authority_status,
       authority_evidence=excluded.authority_evidence,constitutional_relevance_status=excluded.constitutional_relevance_status,
       enrichment_status=excluded.enrichment_status,enrichment_freshness=NULL,freshness_basis=NULL,text_access_policy=excluded.text_access_policy,
       source_policy_version=excluded.source_policy_version,discovery_source=excluded.discovery_source,authority_source=excluded.authority_source,
       source_last_modified_at=excluded.source_last_modified_at,source_etag=excluded.source_etag,source_snapshot_hash=excluded.source_snapshot_hash,updated_at=excluded.updated_at`).bind(
      articleId,normalized.sourceKey,"verified",JSON.stringify(authorityEvidence),"verified","source_only",null,null,
      text(policy.default_text_access_policy),text(snapshotRow.source_policy_version),text(snapshotRow.discovery_method),normalized.canonicalUrl,
      nullableText(item.source_last_modified_at),nullableText(item.source_etag),text(snapshotRow.manifest_hash),0,now,now,
    ));
    if (versionCreated) {
      statements.push(core.prepare(`INSERT INTO article_content_versions_p3
        (id,article_id,revision,parent_version_id,content_hash,provenance_actor_type,provenance_actor_id,slug,source_key,jurisdiction,institution_name,
         content_type,original_url,canonical_url,original_language,original_title,original_published_at,discovered_at,fetched_at,cleaned_text,summary_json,
         source_metadata,error_metadata,created_at,case_key,version_document_schema,version_role,case_metadata_snapshot,case_identifiers_snapshot,authority_evidence_hash,
         source_snapshot_id,source_snapshot_hash,source_content_hash,source_anchor_version_id,enrichment_source_content_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        versionId,articleId,String(versionRevision),currentHead?.current_version_id ?? null,contentHash,"import",input.actorId ?? "case-backfill-worker",
        articleSlug,normalized.sourceKey,normalized.jurisdiction,normalized.institutionName,normalized.contentType,normalized.originalUrl,normalized.canonicalUrl,
        normalized.originalLanguage,normalized.originalTitle,normalized.originalPublishedAt ?? null,now,now,normalized.cleanedText ?? null,null,
        JSON.stringify(normalized.metadata ?? {}),null,now,derivedCaseKey,"v4.article-case.v1","authoritative_source",JSON.stringify(caseSnapshot),JSON.stringify(identifierSnapshot),
        authorityHash,text(snapshotRow.id),text(snapshotRow.manifest_hash),text(normalization.normalized_output_hash),versionId,null,
      ));
      statements.push(core.prepare(`INSERT INTO article_revision_heads_v4(article_id,current_version_id,current_revision,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(article_id) DO UPDATE SET current_version_id=excluded.current_version_id,current_revision=excluded.current_revision,updated_at=excluded.updated_at`).bind(
        articleId,versionId,String(versionRevision),now,
      ));
    }
    if (!publication) {
      statements.push(core.prepare(`INSERT INTO case_catalog_publications_v1
        (id,article_id,state,source_anchor_version_id,revision,source_policy_version,decided_by_type,decided_by_id,reason,published_at,withdrawn_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        publicationId,articleId,publicationState,versionId,String(publicationRevision),text(snapshotRow.source_policy_version),"backfill",
        input.actorId ?? "case-backfill-worker",publicationReason,publicationState === "published" ? now : null,publicationState === "withdrawn" ? now : null,now,now,
      ));
    } else {
      statements.push(core.prepare(`UPDATE case_catalog_publications_v1 SET state=?,source_anchor_version_id=?,revision=?,source_policy_version=?,
        decided_by_type='backfill',decided_by_id=?,reason=?,
        published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END,
        withdrawn_at=CASE WHEN ?='withdrawn' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND CAST(revision AS INTEGER)=?`).bind(
        publicationState,versionId,String(publicationRevision),text(snapshotRow.source_policy_version),input.actorId ?? "case-backfill-worker",
        publicationReason,publicationState,now,publicationState,now,now,publicationId,numberValue(publication.revision),
      ));
    }
    statements.push(core.prepare(`INSERT INTO case_catalog_publication_events_v1
      (id,publication_id,article_id,publication_revision,from_state,to_state,previous_source_anchor_version_id,next_source_anchor_version_id,idempotency_key,actor_type,actor_id,reason,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      decimalId(),publicationId,articleId,String(publicationRevision),publication ? nullableText(publication.state) : null,publicationState,
      publication ? nullableText(publication.source_anchor_version_id) : null,versionId,idempotencyKey,"backfill",input.actorId ?? "case-backfill-worker",
      publicationReason,now,
    ));
    statements.push(core.prepare(`INSERT INTO case_catalog_cache_outbox_v1
      (id,event_key,article_id,publication_id,publication_revision,source_anchor_version_id,article_slug,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(),`case-catalog:${publicationId}:${publicationRevision}`,articleId,publicationId,String(publicationRevision),versionId,articleSlug,now,
    ));
    await batch(core, statements);
    await finalizeCatalogItem(ingest, {
      itemId: input.itemId,
      authority: input.authority,
      articleId,
      normalizationArtifactId,
      versionId,
      publicationRevision,
      publicationState,
    });
    return { articleId,versionId,versionRevision,publicationRevision,articleSlug };
  },

  async completeItem(input) {
    assertSupportedD1Phase(input.phase);
    const item = await itemForMutation(input.itemId, input.phase, input.authority);
    const artifactId = typeof input.resultMetadata.artifactId === "string" ? input.resultMetadata.artifactId : "";
    if (!artifactId) throw new Error("case_backfill.invalid_artifact");
    const db = requiredBinding("worldcons_ingest");
    const now = new Date().toISOString();
    let result: D1RuntimeResult;
    let workState: string;
    if (input.phase === "fetch") {
      const artifact = (await rows<Row>(db, "SELECT * FROM source_fetch_artifacts WHERE id=? AND item_id=? LIMIT 1", [artifactId, input.itemId]))[0];
      if (!artifact) throw new Error("case_backfill.invalid_fetch_transition");
      const expectedStatus = text(item.status) === "published" ? "published" : "fetched";
      if (input.nextStatus !== expectedStatus) throw new Error("case_backfill.invalid_fetch_transition");
      result = await run(db, `
        UPDATE source_backfill_items
        SET status=?,current_fetch_artifact_id=?,http_status=?,source_etag=?,source_last_modified_at=?,payload_hash=?,authority_url=?,
            claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,
            next_attempt_at=NULL,retry_phase=NULL,error_code=NULL,error_summary=NULL,updated_at=?
        WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase='fetch' AND lease_expires_at>?
      `, [input.nextStatus, artifactId, artifact.http_status, artifact.source_etag, artifact.source_last_modified_at, artifact.payload_hash, artifact.authority_url,
        now, input.itemId, input.authority.attemptId, input.authority.fencingToken, now]);
      workState = "needs_normalize";
    } else if (input.phase === "normalize") {
      const artifact = (await rows<Row>(db, `
        SELECT * FROM source_normalization_artifacts WHERE id=? AND item_id=? AND validation_status='valid' LIMIT 1
      `, [artifactId, input.itemId]))[0];
      if (!artifact) throw new Error("case_backfill.invalid_normalize_transition");
      const expectedStatus = text(item.status) === "published" ? "published" : "normalized";
      if (input.nextStatus !== expectedStatus) throw new Error("case_backfill.invalid_normalize_transition");
      result = await run(db, `
        UPDATE source_backfill_items
        SET status=?,current_normalization_artifact_id=?,parser_version=?,
            claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,
            next_attempt_at=NULL,retry_phase=NULL,error_code=NULL,error_summary=NULL,updated_at=?
        WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase='normalize' AND lease_expires_at>?
      `, [input.nextStatus, artifactId, artifact.parser_version, now, input.itemId, input.authority.attemptId, input.authority.fencingToken, now]);
      workState = "needs_reverify";
    } else if (input.phase === "verify") {
      if (artifactId !== text(item.current_normalization_artifact_id)) throw new Error("case_backfill.invalid_verify_transition");
      const expectedStatus = text(item.status) === "published" ? "published" : "verified";
      if (input.nextStatus !== expectedStatus) throw new Error("case_backfill.invalid_verify_transition");
      const noop = input.resultMetadata.noop === true;
      if (noop) {
        if (text(item.status) !== "published" || !item.published_normalization_artifact_id) {
          throw new Error("case_backfill.invalid_verification_noop");
        }
        const currentArtifact = (await rows<Row>(db, "SELECT normalized_output_hash FROM source_normalization_artifacts WHERE id=? AND item_id=? LIMIT 1", [artifactId, input.itemId]))[0];
        const publishedArtifact = (await rows<Row>(db, "SELECT normalized_output_hash FROM source_normalization_artifacts WHERE id=? AND item_id=? LIMIT 1", [item.published_normalization_artifact_id, input.itemId]))[0];
        if (!currentArtifact || !publishedArtifact || text(currentArtifact.normalized_output_hash) !== text(publishedArtifact.normalized_output_hash)) {
          throw new Error("case_backfill.invalid_verification_noop");
        }
      }
      result = await run(db, `
        UPDATE source_backfill_items
        SET status=?,verified_normalization_artifact_id=?,
            published_normalization_artifact_id=CASE WHEN ?=1 THEN ? ELSE published_normalization_artifact_id END,
            claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,
            next_attempt_at=NULL,retry_phase=NULL,error_code=NULL,error_summary=NULL,updated_at=?
        WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase='verify' AND lease_expires_at>?
      `, [input.nextStatus,artifactId,noop ? 1 : 0,artifactId,now,input.itemId,input.authority.attemptId,input.authority.fencingToken,now]);
      workState = text(item.status) === "published" && !noop ? "needs_republish" : "idle";
      if (noop) {
        await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
          [decimalId(), input.itemId, input.authority.attemptId, "verification_noop", "verify", JSON.stringify({ artifactId }), now]);
      }
    } else {
      throw new Error("case_backfill.publish_completion_requires_catalog_commit");
    }
    if (changes(result) !== 1) throw new Error("case_backfill.item_lease_lost");
    await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
      [decimalId(), input.itemId, input.authority.attemptId, "item_completed", input.phase, JSON.stringify({ status: input.nextStatus, workState }), now]);
  },

  async excludeItem(input) {
    if (input.phase !== "normalize" && input.phase !== "verify") throw new Error("case_backfill.d1_phase_unsupported");
    if (!/^[a-z][a-z0-9._-]{2,79}$/.test(input.exclusionCode)) throw new Error("case_backfill.invalid_exclusion_code");
    const item = await itemForMutation(input.itemId, input.phase, input.authority);
    if (!["fetched","normalized","retry_wait"].includes(text(item.status)) || !item.current_fetch_artifact_id) {
      throw new Error("case_backfill.invalid_exclusion_transition");
    }
    const db = requiredBinding("worldcons_ingest");
    const now = new Date().toISOString();
    const result = await run(db, `
      UPDATE source_backfill_items
      SET status='excluded',exclusion_code=?,claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,
          next_attempt_at=NULL,retry_phase=NULL,error_code=NULL,error_summary=NULL,updated_at=?
      WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase=? AND lease_expires_at>?
    `, [input.exclusionCode.trim().slice(0,80),now,input.itemId,input.authority.attemptId,input.authority.fencingToken,input.phase,now]);
    if (changes(result) !== 1) throw new Error("case_backfill.item_lease_lost");
    await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
      [decimalId(), input.itemId, input.authority.attemptId, "item_excluded", input.phase,
        JSON.stringify({ status: "excluded", exclusionCode: input.exclusionCode, fetchArtifactId: item.current_fetch_artifact_id }), now]);
  },

  async failItem(input) {
    assertSupportedD1Phase(input.phase);
    const item = await itemForMutation(input.itemId, input.phase, input.authority);
    if (input.disposition !== "retryable" && input.disposition !== "terminal") throw new Error("case_backfill.invalid_failure");
    if (input.disposition === "retryable" && !input.retryAt) throw new Error("case_backfill.invalid_failure");
    const db = requiredBinding("worldcons_ingest");
    const now = new Date().toISOString();
    const nextStatus = text(item.status) === "published" ? "published" : input.disposition === "retryable" ? "retry_wait" : "terminal_failure";
    const result = await run(db, `
      UPDATE source_backfill_items
      SET status=?,next_attempt_at=?,retry_phase=?,error_code=?,error_summary=?,
          claimed_attempt_id=NULL,claimed_fencing_token=NULL,claimed_phase=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND claimed_attempt_id=? AND claimed_fencing_token=? AND claimed_phase=? AND lease_expires_at>?
    `, [nextStatus, input.disposition === "retryable" ? input.retryAt : null, input.disposition === "retryable" ? input.phase : null,
      input.errorCode.trim().slice(0,160), input.errorSummary.trim().slice(0,500) || null, now,
      input.itemId, input.authority.attemptId, input.authority.fencingToken, input.phase, now]);
    if (changes(result) !== 1) throw new Error("case_backfill.item_lease_lost");
    await run(db, `INSERT INTO source_backfill_item_events (id,item_id,attempt_id,event_type,phase,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?)`,
      [decimalId(), input.itemId, input.authority.attemptId, "item_failed", input.phase, JSON.stringify({ disposition: input.disposition, errorCode: input.errorCode }), now]);
  },

  listArtifactExternalizationCandidates: unsupported,
  attachArtifactExternalization: unsupported,
  listArtifactInlineClearCandidates: unsupported,
  clearArtifactInline: unsupported,
  listArtifactInlineRestoreCandidates: unsupported,
  restoreArtifactInline: unsupported,
  listArtifactReadinessRows: unsupported,
};

