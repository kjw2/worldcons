import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { approveGlossaryCandidate, generateGlossaryCandidates, ignoreGlossaryCandidate } from "@/lib/glossary/candidates";
import { isAuthorizedRequest } from "@/lib/utils/auth";

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
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const action = stringValue(formData, "action");

  if (action === "refresh") {
    const result = await generateGlossaryCandidates({ persist: true });
    await recordSiteEvent(
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
    await ignoreGlossaryCandidate(candidateId);
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

    const result = await approveGlossaryCandidate({ candidateId, slug, term, koreanTerm, definition, jurisdiction, relatedTags });
    await recordSiteEvent(
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
