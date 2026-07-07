import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import {
  listSourceUrlCandidates,
  parseSourceUrlCandidateStatus,
  updateSourceUrlCandidateStatus,
  type SourceUrlCandidateStatus,
} from "@/lib/db/source-url-candidates";
import { adminMutationAuthFailureStatus, isAuthorizedRequest, safeAdminNextPath } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_CANDIDATE_ID_LENGTH = 120;
const MAX_CANDIDATE_STATUS_LENGTH = 40;
const MAX_ADMIN_RETURN_TO_LENGTH = 300;

const ACTION_TO_STATUS = {
  ignore: "ignored",
  retrying: "retrying",
} as const satisfies Record<string, SourceUrlCandidateStatus>;

function isCandidateAction(value?: string | null): value is keyof typeof ACTION_TO_STATUS {
  return value === "ignore" || value === "retrying";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function tooLong(value: string, maxLength: number) {
  return value.length > maxLength;
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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    isForm: false,
    csrfToken: stringValue(body.csrfToken),
    candidateId: stringValue(body.candidateId || body.id),
    action: stringValue(body.action),
    status: stringValue(body.status),
    returnTo: stringValue(body.returnTo),
  };
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status")?.trim();
  if (status && !parseSourceUrlCandidateStatus(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const result = await listSourceUrlCandidates({
    sourceKey: searchParams.get("source") ?? undefined,
    status: status ?? undefined,
    candidateType: searchParams.get("type") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    page: searchParams.get("page"),
    pageSize: searchParams.get("pageSize"),
  });
  return NextResponse.json(result);
}

async function mutateCandidate(request: Request) {
  const input = await readMutationBody(request);
  const authFailureStatus = adminMutationAuthFailureStatus(request, input.csrfToken || undefined);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const hasAction = Boolean(input.action);
  const hasStatus = Boolean(input.status);
  if (!hasAction && !hasStatus) {
    return NextResponse.json({ error: "action or status is required" }, { status: 400 });
  }
  if (tooLong(input.candidateId, MAX_CANDIDATE_ID_LENGTH) || tooLong(input.action, MAX_CANDIDATE_STATUS_LENGTH) || tooLong(input.status, MAX_CANDIDATE_STATUS_LENGTH) || tooLong(input.returnTo, MAX_ADMIN_RETURN_TO_LENGTH)) {
    return NextResponse.json({ error: "candidate request fields are too long" }, { status: 400 });
  }
  if (hasAction && !isCandidateAction(input.action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const statusFromAction = isCandidateAction(input.action) ? ACTION_TO_STATUS[input.action] : null;
  const status = hasStatus ? parseSourceUrlCandidateStatus(input.status) : statusFromAction;
  if (hasStatus && !status) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (statusFromAction && status && status !== statusFromAction) {
    return NextResponse.json({ error: "action and status do not match" }, { status: 400 });
  }
  const targetStatus = status ?? statusFromAction;
  if (!targetStatus) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (!input.candidateId) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }

  const result = await updateSourceUrlCandidateStatus(input.candidateId, targetStatus);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "Candidate not found." ? 404 : 500 });
  }
  const item = result.item;
  if (!item) {
    return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
  }

  await recordSiteEvent(
    {
      eventType: "admin_action",
      path: "/api/admin/candidates",
      sourceKey: item.sourceKey,
      metadata: {
        action: input.action || null,
        status: targetStatus,
        candidateId: item.id,
        sourceKey: item.sourceKey,
        candidateType: item.candidateType,
        candidateUrl: item.url,
      },
    },
    request.headers,
  ).catch(() => null);

  if (input.isForm) {
    return redirectBack(request, input.returnTo, input.action === "ignore" || status === "ignored" ? "ignored" : "retrying");
  }
  return NextResponse.json({ item });
}

export async function PATCH(request: Request) {
  return mutateCandidate(request);
}

export async function POST(request: Request) {
  return mutateCandidate(request);
}
