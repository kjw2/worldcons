import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { runAdminReviewAction, type AdminReviewAction } from "@/lib/ingest/review";
import { LLM_PROVIDER_IDS } from "@/lib/ai/llm-settings-types";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_ADMIN_NOTE_LENGTH = 1000;
const MAX_ADMIN_MODEL_LENGTH = 120;
const MAX_ADMIN_REF_LENGTH = 240;

const REVIEW_ACTIONS = new Set<AdminReviewAction>([
  "approve-and-summarize",
  "retry-summary",
  "resummarize-with-model",
  "publish-reviewed",
  "close-private",
  "retry-source-ingest",
]);

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return { ok: true as const, value: undefined };
  const text = value.trim();
  if (!text) return { ok: true as const, value: undefined };
  if (text.length > maxLength) return { ok: false as const };
  return { ok: true as const, value: text };
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body.action === "string" && REVIEW_ACTIONS.has(body.action as AdminReviewAction)
    ? (body.action as AdminReviewAction)
    : null;
  const articleIdInput = optionalText(body.articleId, MAX_ADMIN_REF_LENGTH);
  const slugInput = optionalText(body.slug, MAX_ADMIN_REF_LENGTH);
  const noteInput = optionalText(body.note, MAX_ADMIN_NOTE_LENGTH);
  const modelInput = optionalText(body.model, MAX_ADMIN_MODEL_LENGTH);
  if (!articleIdInput.ok || !slugInput.ok) {
    return NextResponse.json({ error: "articleId or slug is too long" }, { status: 400 });
  }
  if (!noteInput.ok) {
    return NextResponse.json({ error: "note is too long" }, { status: 400 });
  }
  if (!modelInput.ok) {
    return NextResponse.json({ error: "model is too long" }, { status: 400 });
  }

  const articleId = articleIdInput.value;
  const slug = slugInput.value;
  const note = noteInput.value;
  const provider = typeof body.provider === "string" && (LLM_PROVIDER_IDS as readonly string[]).includes(body.provider) ? body.provider as typeof LLM_PROVIDER_IDS[number] : undefined;
  const model = modelInput.value;

  if (!action) {
    return NextResponse.json({ error: "Unsupported review action" }, { status: 400 });
  }
  if (action === "close-private" && body.confirmation !== "close-private") {
    return NextResponse.json({ error: "close-private requires explicit confirmation" }, { status: 400 });
  }
  if (!articleId && !slug) {
    return NextResponse.json({ error: "articleId or slug is required" }, { status: 400 });
  }

  const result = await runAdminReviewAction({ action, articleId, slug, note, provider, model });
  await recordSiteEvent(
    {
      eventType: "admin_review_action",
      path: "/api/admin/review",
      articleId,
      articleSlug: slug,
      metadata: {
        action,
        provider,
        model,
        status: "status" in result ? result.status : undefined,
      },
    },
    request.headers,
  );
  return NextResponse.json({ review: result });
}
