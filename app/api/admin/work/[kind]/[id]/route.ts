import { NextResponse } from "next/server";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import { articlePublicationService } from "@/lib/article-publication/service";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { actionAllowedForKind, parseAdminWorkActionBody } from "@/lib/admin/p4/actions";
import { assessP3RefreshCandidate, P3_DRIFT_REFRESH_CANARY_IDS, type P3RefreshCandidate } from "@/lib/admin/p4/p3-drift-refresh";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { createHash } from "@/lib/utils/hash";
import { adminSessionIdentityFromRequest, adminSessionMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SAFE_ID = /^[A-Za-z0-9-]{1,120}$/;

function errorStatus(code: string) {
  if (code === "not_found") return 404;
  if (["active_duplicate", "not_retryable", "conflict", "stale_revision", "ineligible", "illegal_transition", "aborted"].includes(code)) return 409;
  if (code === "invalid_input") return 400;
  if (code === "forbidden") return 403;
  if (code === "unavailable") return 503;
  return 500;
}

async function audit(request: Request, input: { kind: string; id: string; action: string; result: string; code?: string }) {
  await recordAdminSiteEvent({
    eventType: "admin_action",
    path: `/api/admin/work/${input.kind}/${input.id}`,
    metadata: {
      action: `p4.${input.action}`,
      workType: input.kind,
      workId: input.id,
      result: input.result,
      errorCode: input.code ?? null,
    },
  }, request.headers).catch(() => null);
}

async function candidateRetry(id: string, idempotencyKey: string, operatorIdentity: string) {
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (!ingest) return { ok: false as const, code: "unavailable" };
  const lookup = await ingest.prepare("SELECT id,status FROM source_url_candidates WHERE id=? LIMIT 1").bind(id).all<{ id: string; status: string }>();
  if (lookup.success === false || lookup.error) return { ok: false as const, code: "unavailable" };
  const candidate = lookup.results?.[0];
  if (!candidate) return { ok: false as const, code: "not_found" };
  if (!["pending", "failed"].includes(String(candidate.status))) return { ok: false as const, code: "conflict" };

  const result = await adminCommandService.submit({
    commandType: "p1.candidate.retry",
    payloadRef: { cohort: "candidate-retry", candidateId: id },
    idempotencyKey: `p4:${createHash(`candidate:${id}:${idempotencyKey}`, 64)}`,
    dedupeKey: `p1.candidate.retry:${id}`,
    requestedBy: operatorIdentity,
    priority: 25,
    maxAttempts: 3,
  });
  return result.ok
    ? { ok: true as const, data: result.data }
    : { ok: false as const, code: result.error.code };
}

async function publicationAction(
  id: string,
  action: "publish" | "withdraw",
  reason: string,
  idempotencyKey: string,
  request: Request,
  operatorIdentity: string,
) {
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return { ok: false as const, code: "unavailable" };
  const lookup = await core.prepare([
    "SELECT p.state,p.revision,p.version_id,h.current_version_id,h.current_revision",
    "FROM article_publications_p3 p",
    "JOIN article_version_heads_p3 h ON h.article_id=p.article_id",
    "WHERE p.article_id=? LIMIT 1",
  ].join(" ")).bind(id).all<{ state: string; revision: number | string; version_id: string; current_version_id: string; current_revision: number | string }>();
  if (lookup.success === false || lookup.error) return { ok: false as const, code: "unavailable" };
  const row = lookup.results?.[0];
  if (!row) return { ok: false as const, code: "not_found" };
  const currentState = String(row.state);
  if (action === "publish" && !["in_review", "withdrawn"].includes(currentState)) return { ok: false as const, code: "illegal_transition" };
  if (action === "withdraw" && currentState !== "published") return { ok: false as const, code: "illegal_transition" };

  const requestId = request.headers.get("x-request-id")?.trim().slice(0, 160) || null;
  const result = await articlePublicationService.transition({
    articleId: id,
    expectedVersionRevision: Number(row.current_revision),
    expectedPublicationRevision: Number(row.revision),
    idempotencyKey: `p4:${createHash(`publication:${id}:${action}:${idempotencyKey}`, 64)}`,
    targetState: action === "publish" ? "published" : "withdrawn",
    versionId: action === "withdraw" ? String(row.version_id) : String(row.current_version_id),
    actorType: "human",
    actorId: operatorIdentity,
    reason,
    requestId,
    correlationId: idempotencyKey,
  });
  return result.ok
    ? { ok: true as const, data: result.data }
    : { ok: false as const, code: result.error.code };
}

/** Authenticated human-only, four-ID P3 repair. Never changes Core or overwrites a P3 version. */
async function refreshP3Snapshot(id: string, reason: string, idempotencyKey: string, operatorIdentity: string) {
  if (!P3_DRIFT_REFRESH_CANARY_IDS.has(id)) return { ok: false as const, code: "forbidden" };
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return { ok: false as const, code: "unavailable" };
  const lookup = await core.prepare(`
    SELECT a.id,a.source_key,a.updated_at,a.status,a.original_language,a.translation_status,
      a.lifecycle_collection_state,a.lifecycle_processing_state,a.lifecycle_review_state,a.lifecycle_attention_state,
      a.source_metadata,a.canonical_url,a.cleaned_text,a.summary_json,a.korean_title,
      p.state AS publication_state,p.version_id,p.revision AS publication_revision,
      v.cleaned_text AS version_cleaned_text,v.summary_json AS version_summary_json,
      v.korean_title AS version_korean_title,v.canonical_url AS version_canonical_url
    FROM articles a JOIN article_publications_p3 p ON p.article_id=a.id
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id
    WHERE a.id=? LIMIT 1
  `).bind(id).all<P3RefreshCandidate>();
  if (lookup.success === false || lookup.error) return { ok: false as const, code: "unavailable" };
  const candidate = lookup.results?.[0];
  if (!candidate) return { ok: false as const, code: "not_found" };
  const decision = assessP3RefreshCandidate(candidate);
  if (!decision.eligible) return { ok: false as const, code: "ineligible" };
  // Use authoritative v4/P3 head revision and optimistic legacy timestamp guard.
  const snapshot = await articlePublicationService.getSnapshot(id);
  if (!snapshot.ok) return { ok: false as const, code: snapshot.error.code };
  if (snapshot.data.publicationState !== "published"
    || snapshot.data.publicationRevision !== Number(candidate.publication_revision)
    || snapshot.data.legacyUpdatedAt !== candidate.updated_at) {
    return { ok: false as const, code: "stale_revision" };
  }
  const result = await articlePublicationService.transition({
    articleId: id,
    expectedVersionRevision: snapshot.data.versionRevision,
    expectedPublicationRevision: snapshot.data.publicationRevision,
    expectedLegacyUpdatedAt: candidate.updated_at,
    idempotencyKey: `p4:refresh-p3:${createHash([id, candidate.updated_at, candidate.version_id, idempotencyKey].join(":"), 64)}`,
    targetState: "published",
    captureLegacy: true,
    actorType: "human",
    actorId: operatorIdentity,
    provenanceActorType: "human",
    provenanceActorId: operatorIdentity,
    reason,
    correlationId: idempotencyKey,
    safeMetadata: { action: "bounded_p3_snapshot_refresh", priorVersionId: candidate.version_id },
  });
  return result.ok ? { ok: true as const, data: result.data } : { ok: false as const, code: result.error.code };
}

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const authFailure = adminSessionMutationAuthFailureStatus(request);
  if (authFailure) {
    return NextResponse.json({ error: authFailure === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailure });
  }
  const operatorIdentity = adminSessionIdentityFromRequest(request);
  if (!operatorIdentity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { kind, id: rawId } = await params;
  const id = rawId.trim();
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "Invalid work item id" }, { status: 400 });
  const parsed = parseAdminWorkActionBody(await request.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: "Invalid work action", detail: parsed.error }, { status: 400 });
  if (!actionAllowedForKind(kind, parsed.data.action)) {
    return NextResponse.json({ error: "Action is not supported by this work item authority" }, { status: 409 });
  }

  const { action, reason, idempotencyKey } = parsed.data;
  let result:
    | Awaited<ReturnType<typeof candidateRetry>>
    | Awaited<ReturnType<typeof publicationAction>>
    | Awaited<ReturnType<typeof refreshP3Snapshot>>
    | Awaited<ReturnType<typeof adminCommandService.abort>>
    | Awaited<ReturnType<typeof adminCommandService.retry>>;
  if (kind === "execution" && action === "abort") {
    result = await adminCommandService.abort({ runId: id, requestedBy: operatorIdentity, reason });
  } else if (kind === "execution" && action === "retry") {
    result = await adminCommandService.retry(id, operatorIdentity, reason);
  } else if (kind === "candidate" && action === "candidate-retry") {
    result = await candidateRetry(id, idempotencyKey, operatorIdentity);
  } else if (kind === "article" && (action === "publish" || action === "withdraw")) {
    result = await publicationAction(id, action, reason, idempotencyKey, request, operatorIdentity);
  } else if (kind === "article" && action === "refresh-p3") {
    result = await refreshP3Snapshot(id, reason, idempotencyKey, operatorIdentity);
  } else {
    return NextResponse.json({ error: "Unsupported action" }, { status: 409 });
  }

  if (!result.ok) {
    const code = "error" in result && isCommandError(result.error) ? result.error.code : "code" in result ? result.code : "internal";
    await audit(request, { kind, id, action, result: "conflict", code });
    return NextResponse.json({ error: code }, { status: errorStatus(code) });
  }
  await audit(request, { kind, id, action, result: "accepted" });
  return NextResponse.json({ action, result: result.data }, { status: action === "retry" || action === "candidate-retry" ? 202 : 200 });
}

function isCommandError(value: unknown): value is { code: string } {
  return Boolean(value && typeof value === "object" && "code" in value && typeof (value as { code?: unknown }).code === "string");
}
