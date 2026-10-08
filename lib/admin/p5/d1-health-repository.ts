import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { resolveP5OperationalPolicy, type P5OperationalPolicy } from "@/lib/admin/p5/policy";
import type { P5HealthEvidence } from "@/lib/admin/p5/types";

export function unavailableP5HealthEvidenceFromD1(start: string, end: string): P5HealthEvidence {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    available: false,
    observationWindow: { start, end },
    queue: { states: {}, oldestQueuedAgeSeconds: null, staleLeaseCount: 0, oldestHeartbeatAgeSeconds: null, abortPendingCount: 0, oldestAbortAgeSeconds: null, retryWaitingCount: 0, oldestRetryAgeSeconds: null },
    lifecycle: { backlogCount: 0, oldestReviewAgeSeconds: null, unresolvedAnomalyCount: 0 },
    publication: { legacyPublicCount: 0, explicitPublicCount: 0, parityMismatchCount: 0, quarantineCount: 0, legacyIdentityDigest: "", explicitIdentityDigest: "" },
    outbox: { pendingCount: 0, processingCount: 0, deadLetterCount: 0, oldestUndeliveredAgeSeconds: null },
    sources: [],
    compatibility: { totalCount: 0, legacyReadCount: 0, legacyWriteCount: 0, newReadCount: 0, newWriteCount: 0, fallbackCount: 0, unexplainedLegacyCount: 0, firstObservedAt: null, lastObservedAt: null, bucketCount: 0, legacyReadObserved: false, legacyWriteObserved: false, newReadObserved: false, newWriteObserved: false, fallbackObserved: false, unexplainedLegacyObserved: false, legacyLastSeenAt: null, newLastSeenAt: null },
    inFlight: { legacyCount: 0, newCount: 0, conflict: false },
    governance: { backupRestoreAt: null, backupRestoreExpiresAt: null, approvalSets: [] },
    retention: { commandAttemptsDue: 0, commandEventsDue: 0, lifecycleEventsDue: 0, publicationHistoryDue: 0, contentVersionsDue: 0, compatibilityObservationsDue: 0, deliveredOutboxDue: 0, deadLetterOutboxDue: 0, legalHoldActive: false },
  };
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

async function query(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (typeof statement.all !== "function") throw new Error("p5_health_d1.read_unavailable");
  const result = await statement.all<Record<string, unknown>>();
  if (!result || result.success === false || !Array.isArray(result.results)) {
    throw new Error(result?.error || "p5_health_d1.read_failed");
  }
  return result.results;
}

function countAge(row: Record<string, unknown>, key: string) {
  return nullableNumber(row[key]);
}

export async function getP5HealthEvidenceFromD1(input: {
  observationStart: string;
  observationEnd: string;
  now?: Date;
  policy?: P5OperationalPolicy;
}): Promise<P5HealthEvidence> {
  const fallback = unavailableP5HealthEvidenceFromD1(input.observationStart, input.observationEnd);
  const ops = getRuntimeD1Binding("worldcons_ops");
  const core = getRuntimeD1Binding("worldcons_core");
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (!ops || !core || !ingest) return fallback;

  const now = input.now ?? new Date();
  const policy = input.policy ?? resolveP5OperationalPolicy();
  const nowIso = now.toISOString();
  const observationStart = new Date(input.observationStart);
  const observationEnd = new Date(input.observationEnd);
  if (!Number.isFinite(observationStart.getTime()) || !Number.isFinite(observationEnd.getTime()) || observationStart >= observationEnd || observationEnd.getTime() > now.getTime() + 300_000 || observationEnd.getTime() - observationStart.getTime() > 90 * 86_400_000) return fallback;

  try {
    const commandBefore = new Date(now.getTime() - policy.retention.commandTerminalDays * 86_400_000).toISOString();
    const lifecycleBefore = new Date(now.getTime() - policy.retention.lifecycleAuditDays * 86_400_000).toISOString();
    const publicationBefore = new Date(now.getTime() - policy.retention.publicationAuditDays * 86_400_000).toISOString();
    const observationBefore = new Date(now.getTime() - policy.retention.compatibilityObservationDays * 86_400_000).toISOString();
    const deliveredOutboxBefore = new Date(now.getTime() - policy.retention.deliveredOutboxDays * 86_400_000).toISOString();
    const deadLetterOutboxBefore = new Date(now.getTime() - policy.retention.deadLetterOutboxDays * 86_400_000).toISOString();
    const observationBucketStart = new Date(Date.UTC(observationStart.getUTCFullYear(), observationStart.getUTCMonth(), observationStart.getUTCDate(), observationStart.getUTCHours())).toISOString();
    const observationBucketEnd = new Date(Date.UTC(observationEnd.getUTCFullYear(), observationEnd.getUTCMonth(), observationEnd.getUTCDate(), observationEnd.getUTCHours())).toISOString();
    const [opsRows, lifecycleRows, publicationRows, outboxRows, sourceRows, runSources] = await Promise.all([
      query(ops, `SELECT
        (SELECT COALESCE(json_group_object(status, state_count), '{}') FROM (SELECT status, COUNT(*) AS state_count FROM admin_command_runs GROUP BY status)) AS queue_states,
        (SELECT (julianday(?) - julianday(MIN(created_at))) * 86400 FROM admin_command_runs WHERE status = 'queued') AS oldest_queued_age,
        (SELECT COUNT(*) FROM admin_command_attempts WHERE status = 'running' AND lease_expires_at < ?) AS stale_lease_count,
        (SELECT (julianday(?) - julianday(MIN(heartbeat_at))) * 86400 FROM admin_command_attempts WHERE status = 'running') AS oldest_heartbeat_age,
        (SELECT COUNT(*) FROM admin_command_runs WHERE abort_requested_at IS NOT NULL AND finished_at IS NULL) AS abort_pending_count,
        (SELECT (julianday(?) - julianday(MIN(abort_requested_at))) * 86400 FROM admin_command_runs WHERE abort_requested_at IS NOT NULL AND finished_at IS NULL) AS oldest_abort_age,
        (SELECT COUNT(*) FROM admin_command_runs WHERE status = 'retry_wait') AS retry_waiting_count,
        (SELECT (julianday(?) - julianday(MIN(created_at))) * 86400 FROM admin_command_runs WHERE status = 'retry_wait') AS oldest_retry_age,
        (SELECT COUNT(*) FROM admin_jobs WHERE status IN ('queued', 'running', 'cancel_requested')) AS legacy_in_flight,
        (SELECT COUNT(*) FROM admin_command_runs WHERE status IN ('queued', 'running', 'retry_wait')) AS new_in_flight`, [nowIso, nowIso, nowIso, nowIso, nowIso]),
      query(core, `SELECT
        COUNT(*) AS backlog_count,
        (julianday(?) - julianday(MIN(COALESCE(lifecycle_attention_raised_at, lifecycle_review_changed_at)))) * 86400 AS oldest_review_age,
        (SELECT COUNT(*) FROM article_lifecycle_anomalies_p2 WHERE resolved_at IS NULL) AS unresolved_anomaly_count
        FROM articles WHERE lifecycle_attention_state IN ('active', 'anomaly') OR lifecycle_review_state = 'needs_review'`, [nowIso]),
      query(core, `WITH legacy_public AS (
        SELECT id AS article_id FROM articles
        WHERE status = 'summarized' AND COALESCE(catalog_ai_stale_v4,0)=0
          AND json_extract(source_metadata, '$.collection.publishable') = 1
          AND NOT EXISTS (
            SELECT 1 FROM case_catalog_publications_v1 c
            JOIN article_publications_p3 p ON p.article_id=articles.id AND p.state='published'
            JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
            LEFT JOIN article_content_versions_p3 anchor ON anchor.id=c.source_anchor_version_id
            WHERE c.article_id=articles.id AND c.state='published'
              AND NOT (COALESCE(v.version_role,'')='enrichment_full'
                AND COALESCE(v.source_anchor_version_id,'')=c.source_anchor_version_id
                AND COALESCE(anchor.source_content_hash,'')<>''
                AND anchor.source_content_hash=v.enrichment_source_content_hash)
          )
      ), explicit_public AS (
        SELECT p.article_id FROM article_publications_p3 p
        JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id
        WHERE p.state = 'published' AND (
          (v.version_role IS NULL
            AND EXISTS (SELECT 1 FROM legacy_version_freshness_classifications_v4 f WHERE f.version_id = v.id AND f.freshness = 'current')
            AND NOT EXISTS (SELECT 1 FROM case_catalog_publications_v1 c WHERE c.article_id = v.article_id AND c.state = 'published'))
          OR (v.version_role = 'enrichment_full'
            AND EXISTS (SELECT 1 FROM case_catalog_publications_v1 c
              JOIN article_content_versions_p3 anchor ON anchor.id = c.source_anchor_version_id
              WHERE c.article_id = v.article_id AND c.state = 'published'
                AND c.source_anchor_version_id = v.source_anchor_version_id
                AND anchor.source_content_hash = v.enrichment_source_content_hash))
        )
      ), mismatch AS (
        SELECT article_id FROM (SELECT article_id FROM legacy_public EXCEPT SELECT article_id FROM explicit_public)
        UNION ALL
        SELECT article_id FROM (SELECT article_id FROM explicit_public EXCEPT SELECT article_id FROM legacy_public)
      )
      SELECT
        (SELECT COUNT(*) FROM legacy_public) AS legacy_public_count,
        (SELECT COUNT(*) FROM explicit_public) AS explicit_public_count,
        (SELECT COUNT(*) FROM mismatch) AS parity_mismatch_count,
        (SELECT COUNT(*) FROM article_publication_quarantine_p3 q
          WHERE NOT EXISTS (
            SELECT 1 FROM article_publication_quarantine_resolutions_p3 r
            WHERE r.article_id = q.article_id AND r.anomaly_code = q.anomaly_code
          )) AS quarantine_count,
        (SELECT COUNT(*) || ':' || COALESCE((SELECT group_concat(article_id, ',') FROM (SELECT article_id FROM legacy_public ORDER BY article_id)), '') FROM legacy_public) AS legacy_digest,
        (SELECT COUNT(*) || ':' || COALESCE((SELECT group_concat(article_id, ',') FROM (SELECT article_id FROM explicit_public ORDER BY article_id)), '') FROM explicit_public) AS explicit_digest`),
      query(core, `SELECT
        (SELECT COUNT(*) FROM article_cache_outbox_p3 WHERE status = 'pending') AS pending_count,
        (SELECT COUNT(*) FROM article_cache_outbox_p3 WHERE status = 'processing') AS processing_count,
        (SELECT COUNT(*) FROM article_cache_outbox_p3 WHERE status = 'dead_letter') AS dead_letter_count,
        (julianday(?) - julianday(MIN(CASE WHEN status IN ('pending', 'processing') THEN created_at END))) * 86400 AS oldest_undelivered_age
        FROM article_cache_outbox_p3`, [nowIso]),
      query(core, "SELECT source_key, is_active FROM sources ORDER BY source_key"),
      query(ingest, "SELECT source_key, MAX(started_at) AS started_at FROM ingestion_runs GROUP BY source_key ORDER BY source_key"),
    ]);
    const [opsRow] = opsRows;
    const [lifecycleRow] = lifecycleRows;
    const [publicationRow] = publicationRows;
    const [outboxRow] = outboxRows;
    if (!opsRow || !lifecycleRow || !publicationRow || !outboxRow) return fallback;

    const compatibilityRows = await query(ops, `SELECT
      COALESCE(SUM(observation_count), 0) AS total_count,
      COALESCE(SUM(CASE WHEN authority = 'legacy' AND direction = 'read' THEN observation_count ELSE 0 END), 0) AS legacy_read_count,
      COALESCE(SUM(CASE WHEN authority = 'legacy' AND direction = 'write' THEN observation_count ELSE 0 END), 0) AS legacy_write_count,
      COALESCE(SUM(CASE WHEN authority = 'new' AND direction = 'read' THEN observation_count ELSE 0 END), 0) AS new_read_count,
      COALESCE(SUM(CASE WHEN authority = 'new' AND direction = 'write' THEN observation_count ELSE 0 END), 0) AS new_write_count,
      COALESCE(SUM(CASE WHEN authority = 'fallback' THEN observation_count ELSE 0 END), 0) AS fallback_count,
      COALESCE(SUM(unexplained_count), 0) AS unexplained_count,
      MAX(CASE WHEN authority = 'legacy' AND direction = 'read' THEN 1 ELSE 0 END) AS legacy_read_observed,
      MAX(CASE WHEN authority = 'legacy' AND direction = 'write' THEN 1 ELSE 0 END) AS legacy_write_observed,
      MAX(CASE WHEN authority = 'new' AND direction = 'read' THEN 1 ELSE 0 END) AS new_read_observed,
      MAX(CASE WHEN authority = 'new' AND direction = 'write' THEN 1 ELSE 0 END) AS new_write_observed,
      MAX(CASE WHEN authority = 'fallback' THEN 1 ELSE 0 END) AS fallback_observed,
      MAX(CASE WHEN unexplained_count > 0 THEN 1 ELSE 0 END) AS unexplained_observed,
      MAX(CASE WHEN authority IN ('legacy', 'fallback') THEN last_observed_at END) AS legacy_last_seen_at,
      MAX(CASE WHEN authority = 'new' THEN last_observed_at END) AS new_last_seen_at,
      MIN(first_observed_at) AS first_observed_at, MAX(last_observed_at) AS last_observed_at,
      COUNT(*) AS bucket_count
      FROM admin_compatibility_observations_p5 WHERE bucket_started_at >= ? AND bucket_started_at <= ?`, [observationBucketStart, observationBucketEnd]);
    const [compatibilityRow] = compatibilityRows;
    if (!compatibilityRow) return fallback;

    const [retentionOps, retentionCore, retentionLifecycle, backupRows] = await Promise.all([
      query(ops, `SELECT
        (SELECT COUNT(*) FROM admin_command_attempts WHERE status <> 'running' AND finished_at < ?) AS command_attempts_due,
        (SELECT COUNT(*) FROM admin_command_events e JOIN admin_command_runs r ON r.id = e.run_id WHERE r.finished_at < ?) AS command_events_due,
        (SELECT COUNT(*) FROM admin_compatibility_observations_p5 WHERE bucket_started_at < ?) AS compatibility_due,
        EXISTS(SELECT 1 FROM admin_retention_holds_p5 WHERE released_at IS NULL AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)) AS legal_hold_active`, [commandBefore, commandBefore, observationBefore, nowIso, nowIso]),
      query(core, `SELECT
        (SELECT COUNT(*) FROM article_publication_history_p3 WHERE occurred_at < ?) AS publication_history_due,
        (SELECT COUNT(*) FROM article_content_versions_p3 WHERE created_at < ?) AS content_versions_due,
        (SELECT COUNT(*) FROM article_cache_outbox_p3 WHERE status = 'delivered' AND delivered_at < ?) AS delivered_outbox_due,
        (SELECT COUNT(*) FROM article_cache_outbox_p3 WHERE status = 'dead_letter' AND dead_lettered_at < ?) AS dead_letter_outbox_due`, [publicationBefore, publicationBefore, deliveredOutboxBefore, deadLetterOutboxBefore]),
      query(core, "SELECT COUNT(*) AS lifecycle_events_due FROM article_lifecycle_events_p2 WHERE occurred_at < ?", [lifecycleBefore]),
      query(ops, "SELECT evidence_at, expires_at FROM admin_governance_evidence_p5 WHERE evidence_type = 'backup_restore' AND outcome = 'successful' ORDER BY evidence_at DESC LIMIT 1"),
    ]);
    const [retentionOpsRow] = retentionOps;
    const [retentionCoreRow] = retentionCore;
    const [retentionLifecycleRow] = retentionLifecycle;
    const [backup] = backupRows;
    if (!retentionOpsRow || !retentionCoreRow || !retentionLifecycleRow) return fallback;

    const approvalRows = await query(ops, "SELECT evidence_digest, role_key, actor_hash, expires_at FROM admin_governance_evidence_p5 WHERE evidence_type = 'owner_approval' AND outcome = 'approved' AND note_code = 'retirement.readiness.v2' AND expires_at > ? ORDER BY evidence_at DESC", [nowIso]);
    const approvalGroups = new Map<string, { roles: Set<string>; actors: Set<string>; expiresAt: string | null }>();
    for (const row of approvalRows) {
      const digest = String(row.evidence_digest ?? "");
      const group = approvalGroups.get(digest) ?? { roles: new Set<string>(), actors: new Set<string>(), expiresAt: null };
      if (typeof row.role_key === "string") group.roles.add(row.role_key);
      if (typeof row.actor_hash === "string") group.actors.add(row.actor_hash);
      if (typeof row.expires_at === "string" && (!group.expiresAt || row.expires_at < group.expiresAt)) group.expiresAt = row.expires_at;
      approvalGroups.set(digest, group);
    }
    const approvalSets = [...approvalGroups].map(([evidenceDigest, group]) => ({
      evidenceDigest,
      roles: [...group.roles].filter((role): role is "operations" | "data" | "security" => role === "operations" || role === "data" || role === "security"),
      distinctActorCount: group.actors.size,
      expiresAt: group.expiresAt,
      status: "active" as const,
    })).filter((set) => /^[0-9a-f]{64}$/.test(set.evidenceDigest));
    const latestRunBySource = new Map(runSources.map((row) => [String(row.source_key ?? ""), row.started_at]));
    const sources = sourceRows.map((row) => {
      const sourceKey = String(row.source_key ?? "");
      const latestValue = latestRunBySource.get(sourceKey);
      const latestRunAt = typeof latestValue === "string" ? latestValue : null;
      return {
        sourceKey,
        active: numberValue(row.is_active) === 1,
        latestRunAt,
        freshnessAgeSeconds: latestRunAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(latestRunAt)) / 1000)) : null,
      };
    }).filter((source) => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(source.sourceKey));
    const states = typeof opsRow.queue_states === "string" ? JSON.parse(opsRow.queue_states) as Record<string, number> : {};
    const legacyInFlight = numberValue(opsRow.legacy_in_flight);
    const newInFlight = numberValue(opsRow.new_in_flight);

    return {
      schemaVersion: 1,
      generatedAt: nowIso,
      available: true,
      observationWindow: { start: input.observationStart, end: input.observationEnd },
      queue: {
        states,
        oldestQueuedAgeSeconds: countAge(opsRow, "oldest_queued_age"),
        staleLeaseCount: numberValue(opsRow.stale_lease_count),
        oldestHeartbeatAgeSeconds: countAge(opsRow, "oldest_heartbeat_age"),
        abortPendingCount: numberValue(opsRow.abort_pending_count),
        oldestAbortAgeSeconds: countAge(opsRow, "oldest_abort_age"),
        retryWaitingCount: numberValue(opsRow.retry_waiting_count),
        oldestRetryAgeSeconds: countAge(opsRow, "oldest_retry_age"),
      },
      lifecycle: { backlogCount: numberValue(lifecycleRow.backlog_count), oldestReviewAgeSeconds: countAge(lifecycleRow, "oldest_review_age"), unresolvedAnomalyCount: numberValue(lifecycleRow.unresolved_anomaly_count) },
      publication: {
        legacyPublicCount: numberValue(publicationRow.legacy_public_count),
        explicitPublicCount: numberValue(publicationRow.explicit_public_count),
        parityMismatchCount: numberValue(publicationRow.parity_mismatch_count),
        quarantineCount: numberValue(publicationRow.quarantine_count),
        legacyIdentityDigest: String(publicationRow.legacy_digest ?? ""),
        explicitIdentityDigest: String(publicationRow.explicit_digest ?? ""),
      },
      outbox: { pendingCount: numberValue(outboxRow.pending_count), processingCount: numberValue(outboxRow.processing_count), deadLetterCount: numberValue(outboxRow.dead_letter_count), oldestUndeliveredAgeSeconds: countAge(outboxRow, "oldest_undelivered_age") },
      sources,
      compatibility: {
        totalCount: numberValue(compatibilityRow.total_count), legacyReadCount: numberValue(compatibilityRow.legacy_read_count), legacyWriteCount: numberValue(compatibilityRow.legacy_write_count), newReadCount: numberValue(compatibilityRow.new_read_count), newWriteCount: numberValue(compatibilityRow.new_write_count), fallbackCount: numberValue(compatibilityRow.fallback_count), unexplainedLegacyCount: numberValue(compatibilityRow.unexplained_count), firstObservedAt: typeof compatibilityRow.first_observed_at === "string" ? compatibilityRow.first_observed_at : null, lastObservedAt: typeof compatibilityRow.last_observed_at === "string" ? compatibilityRow.last_observed_at : null, bucketCount: numberValue(compatibilityRow.bucket_count),
        legacyReadObserved: numberValue(compatibilityRow.legacy_read_observed) > 0, legacyWriteObserved: numberValue(compatibilityRow.legacy_write_observed) > 0, newReadObserved: numberValue(compatibilityRow.new_read_observed) > 0, newWriteObserved: numberValue(compatibilityRow.new_write_observed) > 0, fallbackObserved: numberValue(compatibilityRow.fallback_observed) > 0, unexplainedLegacyObserved: numberValue(compatibilityRow.unexplained_observed) > 0, legacyLastSeenAt: typeof compatibilityRow.legacy_last_seen_at === "string" ? compatibilityRow.legacy_last_seen_at : null, newLastSeenAt: typeof compatibilityRow.new_last_seen_at === "string" ? compatibilityRow.new_last_seen_at : null,
      },
      inFlight: { legacyCount: legacyInFlight, newCount: newInFlight, conflict: legacyInFlight > 0 && newInFlight > 0 },
      governance: { backupRestoreAt: typeof backup?.evidence_at === "string" ? backup.evidence_at : null, backupRestoreExpiresAt: typeof backup?.expires_at === "string" ? backup.expires_at : null, approvalSets },
      retention: {
        commandAttemptsDue: numberValue(retentionOpsRow.command_attempts_due),
        commandEventsDue: numberValue(retentionOpsRow.command_events_due),
        lifecycleEventsDue: numberValue(retentionLifecycleRow.lifecycle_events_due),
        publicationHistoryDue: numberValue(retentionCoreRow.publication_history_due),
        contentVersionsDue: numberValue(retentionCoreRow.content_versions_due),
        compatibilityObservationsDue: numberValue(retentionOpsRow.compatibility_due),
        deliveredOutboxDue: numberValue(retentionCoreRow.delivered_outbox_due),
        deadLetterOutboxDue: numberValue(retentionCoreRow.dead_letter_outbox_due),
        legalHoldActive: numberValue(retentionOpsRow.legal_hold_active) === 1,
      },
    };
  } catch {
    return fallback;
  }
}
