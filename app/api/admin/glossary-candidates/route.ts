import { NextResponse } from "next/server";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import {
  approveGlossaryCandidate,
  generateGlossaryCandidates,
  glossaryCandidateRefreshSucceeded,
  ignoreGlossaryCandidate,
} from "@/lib/glossary/candidates";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function redirectBack(request: Request, status: string) {
  const url = new URL("/admin/glossary-candidates", request.url);
  url.searchParams.set("status", status);
  return NextResponse.redirect(url, { status: 303 });
}

function stringValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function relatedTagsFromInput(input: string) {
  return input.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const authFailureStatus = adminMutationAuthFailureStatus(request, stringValue(formData, "csrfToken"));
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const action = stringValue(formData, "action");

  if (action === "refresh") {
    const compatibility = await executeAdminCompatibilityCommand(
      { commandType: "admin.glossary.refresh", payloadRef: { persist: true }, request },
      () => generateGlossaryCandidates({ persist: true }),
      { isLegacySuccess: glossaryCandidateRefreshSucceeded },
    );
    const result = compatibility.value;
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/glossary-candidates",
        metadata: { action, persistedCount: result.persistedCount },
      },
      request.headers,
    ).catch(() => null);
    return redirectBack(request, "refreshed");
  }

  if (action === "ignore") {
    const candidateId = stringValue(formData, "candidateId");
    if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
    await executeAdminCompatibilityCommand(
      { commandType: "admin.glossary.ignore", payloadRef: { candidateId }, request },
      () => ignoreGlossaryCandidate(candidateId),
      { isLegacySuccess: (result) => result.mode === "database" && result.status === "ignored" },
    );
    return redirectBack(request, "ignored");
  }

  if (action === "approve") {
    const candidateId = stringValue(formData, "candidateId") || undefined;
    const slug = stringValue(formData, "slug");
    const term = stringValue(formData, "term");
    const koreanTerm = stringValue(formData, "koreanTerm") || null;
    const definition = stringValue(formData, "definition");
    const jurisdiction = stringValue(formData, "jurisdiction") || null;
    const relatedTags = relatedTagsFromInput(stringValue(formData, "relatedTags"));

    if (!slug || !term || !definition) {
      return NextResponse.json({ error: "slug, term, and definition are required" }, { status: 400 });
    }

    const compatibility = await executeAdminCompatibilityCommand(
      {
        commandType: "admin.glossary.approve",
        payloadRef: { candidateId, slug, jurisdiction, relatedTagCount: relatedTags.length },
        request,
      },
      () => approveGlossaryCandidate({ candidateId, slug, term, koreanTerm, definition, jurisdiction, relatedTags }),
      { isLegacySuccess: (result) => result.mode === "database" && result.status === "approved" },
    );
    const result = compatibility.value;
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/glossary-candidates",
        metadata: { action, slug: result.slug },
      },
      request.headers,
    ).catch(() => null);
    return redirectBack(request, "approved");
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
