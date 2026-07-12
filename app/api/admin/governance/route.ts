import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { adminGovernanceUiEnabled } from "@/lib/admin/p4/flags";
import { P5_OWNER_ROLES, type P5OwnerRole } from "@/lib/admin/p5/types";
import { recordP5OwnerApproval } from "@/lib/admin/p5/repository";
import { createHash } from "@/lib/utils/hash";
import { adminSessionIdentityFromRequest, adminSessionMutationAuthFailureStatus } from "@/lib/utils/auth";

export async function POST(request: Request) {
  if (!adminGovernanceUiEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const authFailure = adminSessionMutationAuthFailureStatus(request);
  if (authFailure) return NextResponse.json({ error: "Unauthorized" }, { status: authFailure });
  const identity = adminSessionIdentityFromRequest(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const role = body?.role;
  const evidenceDigest = body?.evidenceDigest;
  if (body?.action !== "approve" || !P5_OWNER_ROLES.includes(role as P5OwnerRole) || typeof evidenceDigest !== "string" || !/^[0-9a-f]{64}$/.test(evidenceDigest)) {
    return NextResponse.json({ error: "Invalid governance action" }, { status: 400 });
  }
  const result = await recordP5OwnerApproval({
    role: role as P5OwnerRole,
    actorHash: createHash(`p5-governance:${identity}`, 64),
    evidenceDigest,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (!result.ok) return NextResponse.json({ error: "Governance evidence unavailable", code: result.code }, { status: 503 });
  revalidatePath("/admin/governance");
  return NextResponse.json({ ok: true, evidenceId: result.evidenceId });
}
