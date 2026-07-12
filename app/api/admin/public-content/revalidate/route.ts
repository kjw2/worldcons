import { NextResponse } from "next/server";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const compatibility = await executeAdminCompatibilityCommand(
    { commandType: "admin.public-cache.revalidate", payloadRef: { scope: "all" }, request },
    () => invalidatePublicContentCaches(),
    { isLegacySuccess: (result) => result.revalidated === true },
  );
  const result = compatibility.value;
  await recordAdminSiteEvent(
    {
      eventType: "admin_action",
      path: "/api/admin/public-content/revalidate",
      metadata: {
        action: "public_cache_revalidate",
        tagCount: result.tags.length,
        pathCount: result.paths.length,
      },
    },
    request.headers,
  );

  return NextResponse.json(result);
}
