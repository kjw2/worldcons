import { NextResponse } from "next/server";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import { articlePublicationService } from "@/lib/article-publication/service";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { actionAllowedForKind, parseAdminWorkActionBody } from "@/lib/admin/p4/actions";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { createHash } from "@/lib/utils/hash";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SAFE_ID = /^[A-Za-z0-9-]{1,120}$/;

function operatorIdentity() {
  return process.env.ADMIN_USERNAME?.trim() || "administrator";
}

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

async function candidateRetry(id: string, idempotencyKey: string) {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) return { ok: false as const, code: "unavailable" };
  const { data, error } = await supabase
    .from("source_url_candidates")
    .select("id,status")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false as const, code: "unavailable" };
  if (!data) return { ok: false as const, code: "not_found" };
  if (!["pending", "failed"].includes(String(data.status))) return { ok: false as const, code: "conflict" };

  const result = await adminCommandService.submit({
    commandType: "p1.candidate.retry",
    payloadRef: { cohort: "candidate-retry", candidateId: id },
    idempotencyKey: `p4:${createHash(`candidate:${id}:${idempotencyKey}`, 64)}`,
    dedupeKey: `p1.candidate.retry:${id}`,
    requestedBy: operatorIdentity(),
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
) {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) return { ok: false as const, code: "unavailable" };
  const [{ data: publication, error: publicationError }, { data: head, error: headError }] = await Promise.all([
    supabase
      .from("article_publications_p3")
      .select("article_id,state,revision,version_id")
      .eq("article_id", id)
      .maybeSingle(),
    supabase
      .from("article_version_heads_p3")
      .select("article_id,current_version_id,current_revision")
      .eq("article_id", id)
      .maybeSingle(),
  ]);
  if (publicationError || headError) return { ok: false as const, code: "unavailable" };
  if (!publication || !head) return { ok: false as const, code: "not_found" };
  const currentState = String(publication.state);
  if (action === "publish" && !["in_review", "withdrawn"].includes(currentState)) return { ok: false as const, code: "illegal_transition" };
  if (action === "withdraw" && currentState !== "published") return { ok: false as const, code: "illegal_transition" };

  const requestId = request.headers.get("x-request-id")?.trim().slice(0, 160) || null;
  const result = await articlePublicationService.transition({
    articleId: id,
    expectedVersionRevision: Number(head.current_revision),
    expectedPublicationRevision: Number(publication.revision),
    idempotencyKey: `p4:${createHash(`publication:${id}:${action}:${idempotencyKey}`, 64)}`,
    targetState: action === "publish" ? "published" : "withdrawn",
    versionId: String(head.current_version_id),
    actorType: "human",
    actorId: operatorIdentity(),
    reason,
    requestId,
    correlationId: idempotencyKey,
  });
  return result.ok
    ? { ok: true as const, data: result.data }
    : { ok: false as const, code: result.error.code };
}

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const authFailure = adminMutationAuthFailureStatus(request);
  if (authFailure) {
    return NextResponse.json({ error: authFailure === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailure });
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
    | Awaited<ReturnType<typeof adminCommandService.abort>>
    | Awaited<ReturnType<typeof adminCommandService.retry>>;
  if (kind === "execution" && action === "abort") {
    result = await adminCommandService.abort({ runId: id, requestedBy: operatorIdentity(), reason });
  } else if (kind === "execution" && action === "retry") {
    result = await adminCommandService.retry(id, operatorIdentity(), reason);
  } else if (kind === "candidate" && action === "candidate-retry") {
    result = await candidateRetry(id, idempotencyKey);
  } else if (kind === "article" && (action === "publish" || action === "withdraw")) {
    result = await publicationAction(id, action, reason, idempotencyKey, request);
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
