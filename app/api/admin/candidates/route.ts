import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { listSourceUrlCandidates, updateSourceUrlCandidateStatus } from "@/lib/db/source-url-candidates";
import { parseAdminCandidateMutationBody, parseAdminCandidateQuery } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus, isAuthorizedRequest, safeAdminNextPath } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redirectBack(request: Request, returnTo: string | undefined, status: string) {
  const url = new URL(safeAdminNextPath(returnTo || "/admin/candidates"), request.url);
  url.searchParams.set("updated", status);
  return NextResponse.redirect(url, { status: 303 });
}

async function readMutationBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      isForm: true,
      csrfToken: stringValue(formData.get("csrfToken")),
      candidateId: stringValue(formData.get("candidateId") || formData.get("id")),
      action: stringValue(formData.get("action")),
      status: stringValue(formData.get("status")),
      returnTo: stringValue(formData.get("returnTo")),
    };
  }

  const body = await request.json().catch(() => ({}));
  if (!isRecord(body)) {
    return {
      isForm: false,
      csrfToken: "",
      candidateId: undefined,
      action: undefined,
      status: undefined,
      returnTo: undefined,
    };
  }

  return {
    isForm: false,
    csrfToken: stringValue(body.csrfToken),
    candidateId: body.candidateId || body.id,
    action: body.action,
    status: body.status,
    returnTo: body.returnTo,
  };
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseAdminCandidateQuery(searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin candidate query", detail: parsed.error }, { status: 400 });
  }

  const result = await listSourceUrlCandidates({
    sourceKey: parsed.data.source,
    status: parsed.data.status,
    candidateType: parsed.data.type,
    q: parsed.data.q,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
  return NextResponse.json(result);
}

async function mutateCandidate(request: Request) {
  const input = await readMutationBody(request);
  const authFailureStatus = adminMutationAuthFailureStatus(request, input.csrfToken || undefined);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const parsed = parseAdminCandidateMutationBody(input);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin candidate request", detail: parsed.error }, { status: 400 });
  }
  const { action, candidateId, returnTo, isForm, status, targetStatus } = parsed.data;

  const result = await updateSourceUrlCandidateStatus(candidateId, targetStatus);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "Candidate not found." ? 404 : 500 });
  }
  const item = result.item;
  if (!item) {
    return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
  }

  await recordAdminSiteEvent(
    {
      eventType: "admin_action",
      path: "/api/admin/candidates",
      sourceKey: item.sourceKey,
      metadata: {
        action: action || null,
        status: targetStatus,
        candidateId: item.id,
        sourceKey: item.sourceKey,
        candidateType: item.candidateType,
        candidateUrl: item.url,
      },
    },
    request.headers,
  ).catch(() => null);

  if (isForm) {
    return redirectBack(request, returnTo, action === "ignore" || status === "ignored" ? "ignored" : "retrying");
  }
  return NextResponse.json({ item });
}

export async function PATCH(request: Request) {
  return mutateCandidate(request);
}

export async function POST(request: Request) {
  return mutateCandidate(request);
}
