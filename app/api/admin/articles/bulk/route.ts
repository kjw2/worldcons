import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import {
  runAdminArticleBulkAction,
  type AdminArticleBulkAction,
  type AdminArticleBulkRef,
} from "@/lib/db/admin-queries";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const BULK_ACTIONS = new Set<AdminArticleBulkAction>(["mark-needs-review", "close-private"]);
const MAX_BULK_ITEMS = 100;
const MAX_ADMIN_NOTE_LENGTH = 1000;
const MAX_ADMIN_REF_LENGTH = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function normalizeRef(ref: AdminArticleBulkRef): AdminArticleBulkRef | null {
  const id = ref.id?.trim();
  const slug = ref.slug?.trim();
  if (!id && !slug) return null;
  if ((id && id.length > MAX_ADMIN_REF_LENGTH) || (slug && slug.length > MAX_ADMIN_REF_LENGTH)) return null;
  return {
    id: id || undefined,
    slug: slug || undefined,
  };
}

function optionalNote(value: unknown) {
  if (typeof value !== "string") return { ok: true as const, value: undefined };
  const text = value.trim();
  if (!text) return { ok: true as const, value: undefined };
  if (text.length > MAX_ADMIN_NOTE_LENGTH) return { ok: false as const };
  return { ok: true as const, value: text };
}

function parseRefs(body: Record<string, unknown>) {
  const refs: AdminArticleBulkRef[] = [];

  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      if (!isRecord(item)) continue;
      const ref = normalizeRef({
        id: typeof item.id === "string" ? item.id : undefined,
        slug: typeof item.slug === "string" ? item.slug : undefined,
      });
      if (ref) refs.push(ref);
    }
  }

  for (const id of stringArray(body.ids ?? body.articleIds)) {
    const ref = normalizeRef({ id });
    if (ref) refs.push(ref);
  }

  for (const slug of stringArray(body.slugs)) {
    const ref = normalizeRef({ slug });
    if (ref) refs.push(ref);
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.id ? `id:${ref.id}` : `slug:${ref.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({}));
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid bulk request body" }, { status: 400 });
  }

  const action = typeof body.action === "string" && BULK_ACTIONS.has(body.action as AdminArticleBulkAction)
    ? (body.action as AdminArticleBulkAction)
    : null;
  if (!action) {
    return NextResponse.json({ error: "Unsupported bulk action" }, { status: 400 });
  }
  if (action === "close-private" && body.confirmation !== "close-private") {
    return NextResponse.json({ error: "close-private requires explicit confirmation" }, { status: 400 });
  }

  const refs = parseRefs(body);
  if (refs.length === 0) {
    return NextResponse.json({ error: "Select explicit article ids or slugs" }, { status: 400 });
  }
  if (refs.length > MAX_BULK_ITEMS) {
    return NextResponse.json({ error: "Bulk actions are limited to 100 explicitly selected articles" }, { status: 400 });
  }

  const note = optionalNote(body.note);
  if (!note.ok) {
    return NextResponse.json({ error: "note is too long" }, { status: 400 });
  }
  const result = await runAdminArticleBulkAction({ action, refs, note: note.value });

  await recordSiteEvent(
    {
      eventType: "admin_review_action",
      path: "/api/admin/articles/bulk",
      metadata: {
        action,
        requestedCount: result.requestedCount,
        matchedCount: result.matchedCount,
        updatedCount: result.updatedCount,
      },
    },
    request.headers,
  );

  return NextResponse.json({ bulk: result });
}
