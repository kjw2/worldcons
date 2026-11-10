import { NextResponse } from "next/server";
import { applySpainDateOnlyRepublication } from "@/lib/ingest/spain-date-only-apply";
import { fetchSpainOfficialDateEvidence } from "@/lib/ingest/spain-decision-date-recovery";
import type { SpainDateOnlyOperatorAuthorization } from "@/lib/ingest/spain-date-only-republication";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { allow: "POST" } });
}

function operatorAuthorization(value: unknown): SpainDateOnlyOperatorAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (key: string) => typeof row[key] === "string" ? String(row[key]).trim() : "";
  const candidate = {
    actorId: text("actorId"),
    approvedAt: text("approvedAt"),
    articleId: text("articleId"),
    currentVersionId: text("currentVersionId"),
    correctedOriginalPublishedAt: text("correctedOriginalPublishedAt"),
    evidenceSha256: text("evidenceSha256"),
    correlationId: text("correlationId") || null,
  };
  return candidate.actorId ? candidate : undefined;
}

/**
 * Authenticated one-item canary. Dry-run unless `apply: true`; there is no
 * public/unauthenticated path. Deploy is controlled by the release controller.
 */
export async function POST(request: Request) {
  const authFailure = adminMutationAuthFailureStatus(request);
  if (authFailure) {
    return NextResponse.json({ error: authFailure === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailure });
  }
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const articleId = typeof input.articleId === "string" ? input.articleId.trim() : "";
  if (!articleId) return NextResponse.json({ error: "articleId is required" }, { status: 400 });
  const actorId = typeof input.actorId === "string" && input.actorId.trim()
    ? input.actorId.trim()
    : "admin:spain-date-only";
  const correlationId = typeof input.correlationId === "string" && input.correlationId.trim()
    ? input.correlationId.trim()
    : `spain-date-only:${articleId}:${crypto.randomUUID()}`;
  const apply = input.apply === true;
  const confirmPlanHash = typeof input.confirmPlanHash === "string" ? input.confirmPlanHash.trim() : "";
  if (apply && !confirmPlanHash) {
    return NextResponse.json({ error: "confirmPlanHash is required for apply" }, { status: 400 });
  }
  const result = await applySpainDateOnlyRepublication({
    core,
    articleId,
    actorId,
    correlationId,
    apply,
    confirmPlanHash,
    operatorAuthorization: operatorAuthorization(input.operatorAuthorization),
    fetchEvidence: (hjId, canonicalUrl) => fetchSpainOfficialDateEvidence(hjId, canonicalUrl, { delayMs: 500 }),
  });
  return NextResponse.json(result, { status: result.status === "failed" ? 409 : 200 });
}
