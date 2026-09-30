import type { SummaryJson } from "@/lib/db/types";
import { redactAdminAuditEventInput, redactAdminAuditMetadata, redactAdminAuditText } from "@/lib/security/audit-redaction";
import { getClientIp, hashRequestValue, type HeaderLike } from "@/lib/security/request-client";
import { createHash as createStableHash } from "@/lib/utils/hash";
import type { SiteEventInput, SiteEventType } from "@/lib/analytics/events";
import {
  getRuntimeAdminAuditWriteAuthorityConfig,
  shouldWriteAdminAuditToD1,
  writeAdminAuditToRuntimeD1,
} from "@/lib/cloudflare/d1/write-authority/admin-audit";
import {
  getRuntimeAdminArticleEditWriteAuthorityConfig,
  shouldWriteAdminArticleEditToD1,
  writeAdminArticleEditToRuntimeD1,
} from "@/lib/cloudflare/d1/write-authority/admin-article-edit";

type AdminSiteEventInput = SiteEventInput & { eventType: Extract<SiteEventType, "admin_action" | "admin_review_action"> };

interface AdminArticleEditHistoryInput {
  articleId: string;
  articleSlug?: string | null;
  previousSummary?: SummaryJson | null;
  nextSummary: SummaryJson;
  changedFields: string[];
  note?: string;
  actorId?: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function textValue(value: unknown, max = 300) {
  if (typeof value === "string" && value.trim()) return redactAdminAuditText(value, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function metadataText(metadata: Record<string, unknown>, keys: string[], max = 300) {
  for (const key of keys) {
    const value = textValue(metadata[key], max);
    if (value) return value;
  }
  return null;
}

function userAgentFamily(headers?: HeaderLike) {
  const userAgent = headers?.get("user-agent") ?? "";
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome|crios/i.test(userAgent)) return "Chrome";
  if (/firefox|fxios/i.test(userAgent)) return "Firefox";
  if (/safari/i.test(userAgent) && !/chrome|crios|android/i.test(userAgent)) return "Safari";
  if (/node|undici/i.test(userAgent)) return "Server";
  return userAgent ? "Other" : null;
}

function uuidOrNull(value?: string | null) {
  return value && uuidPattern.test(value) ? value : null;
}

function adminAuditTarget(input: AdminSiteEventInput, metadata: Record<string, unknown>) {
  const jobId = metadataText(metadata, ["jobId", "job_id"], 120);
  const explicitTargetType = metadataText(metadata, ["targetType", "target_type"], 80);
  const explicitTargetId = metadataText(metadata, ["targetId", "target_id"], 300);
  const candidateId = metadataText(metadata, ["candidateId", "candidate_id"], 300);

  if (explicitTargetType || explicitTargetId) {
    return {
      targetType: explicitTargetType,
      targetId: explicitTargetId ?? candidateId ?? textValue(input.articleId, 80) ?? textValue(input.articleSlug, 300) ?? textValue(input.sourceKey, 120) ?? jobId,
      jobId,
    };
  }

  if (input.articleId || input.articleSlug) {
    return {
      targetType: "article",
      targetId: textValue(input.articleId, 80) ?? textValue(input.articleSlug, 300),
      jobId,
    };
  }

  if (candidateId) return { targetType: "candidate", targetId: candidateId, jobId };
  if (jobId) return { targetType: "job", targetId: jobId, jobId };
  if (input.sourceKey) return { targetType: "source", targetId: textValue(input.sourceKey, 120), jobId };
  return { targetType: null, targetId: null, jobId };
}

export async function recordAdminAuditLog(input: AdminSiteEventInput, headers?: HeaderLike) {
  const safeInput = redactAdminAuditEventInput(input);
  const metadata = redactAdminAuditMetadata(safeInput.metadata);
  const action = metadataText(metadata, ["action", "resolvedAction", "requestedAction"], 160) ?? safeInput.eventType;
  const result = metadataText(metadata, ["result", "status", "reviewStatus", "mode"], 120);
  const errorClass = metadataText(metadata, ["errorClass", "errorCode", "code"], 160) ?? (result === "error" && metadata.error ? "error" : null);
  const actorId = metadataText(metadata, ["actorId", "actor_id"], 160);
  const actorRole = metadataText(metadata, ["actorRole", "actor_role"], 80) ?? "admin";
  const { targetType, targetId, jobId } = adminAuditTarget(safeInput, metadata);
  const requestIpHash = hashRequestValue(getClientIp(headers));

  const redactedMetadata = redactAdminAuditMetadata({
    ...metadata,
    eventType: safeInput.eventType,
    path: safeInput.path,
    articleId: safeInput.articleId,
    articleSlug: safeInput.articleSlug,
    articleTitle: safeInput.articleTitle,
    sourceKey: safeInput.sourceKey,
  });

  const payload = {
    actor_id: actorId,
    actor_role: actorRole,
    action,
    target_type: targetType,
    target_id: targetId,
    article_id: uuidOrNull(safeInput.articleId),
    article_slug: textValue(safeInput.articleSlug, 300),
    source_key: textValue(safeInput.sourceKey, 120),
    job_id: jobId,
    result,
    error_class: errorClass,
    redacted_metadata: redactedMetadata,
    request_ip_hash: requestIpHash,
    user_agent_family: userAgentFamily(headers),
  };

  const authorityConfig = getRuntimeAdminAuditWriteAuthorityConfig();
  if (shouldWriteAdminAuditToD1(payload, authorityConfig)) {
    try {
      await writeAdminAuditToRuntimeD1(payload);
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_admin_audit_d1_write_failed",
        authority: authorityConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
    }
    return;
  }
}

function summaryHash(summary?: SummaryJson | null) {
  return summary ? createStableHash(JSON.stringify(summary), 64) : null;
}

function summaryPreview(summary?: SummaryJson | null) {
  if (!summary) return null;
  return {
    koreanTitle: summary.koreanTitle,
    coreSummary: summary.summary.coreSummary.slice(0, 3),
    tags: summary.tags.slice(0, 20),
    categories: summary.categories.slice(0, 20),
    riskFlags: summary.riskFlags.slice(0, 20),
  };
}

export async function recordAdminArticleEditHistory(input: AdminArticleEditHistoryInput) {
  const diffRedacted = redactAdminAuditMetadata({
    changedFields: input.changedFields,
    previous: summaryPreview(input.previousSummary),
    next: summaryPreview(input.nextSummary),
    note: input.note,
  });

  const payload = {
    article_id: input.articleId,
    article_slug: textValue(input.articleSlug, 300),
    actor_id: textValue(input.actorId, 160),
    changed_fields: input.changedFields,
    previous_summary_hash: summaryHash(input.previousSummary),
    next_summary_hash: summaryHash(input.nextSummary),
    diff_redacted: diffRedacted,
  };

  const authorityConfig = getRuntimeAdminArticleEditWriteAuthorityConfig();
  if (shouldWriteAdminArticleEditToD1(payload, authorityConfig)) {
    try {
      await writeAdminArticleEditToRuntimeD1(payload);
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_admin_article_edit_d1_write_failed",
        authority: authorityConfig.authority,
        error: error instanceof Error ? error.message : "UnknownError",
      }));
    }
    return;
  }
}
