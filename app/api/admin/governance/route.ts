import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { adminGovernanceUiEnabled } from "@/lib/admin/p4/flags";
import { P5_OWNER_ROLES, type P5OwnerRole } from "@/lib/admin/p5/types";
import { getP5HealthEvidence, recordP5OwnerApproval } from "@/lib/admin/p5/repository";
import { p5GovernanceActorHash, resolveP5OwnerRoleBindings } from "@/lib/admin/p5/owner-bindings";
import { evaluateP5RetirementReadiness, P5_RETIREMENT_FLAG_ORDER } from "@/lib/admin/p5/evaluator";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
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
  const observationStart = body?.observationStart;
  const observationEnd = body?.observationEnd;
  if (body?.action !== "approve" || !P5_OWNER_ROLES.includes(role as P5OwnerRole) || typeof evidenceDigest !== "string" || !/^[0-9a-f]{64}$/.test(evidenceDigest) || typeof observationStart !== "string" || typeof observationEnd !== "string") {
    return NextResponse.json({ error: "Invalid governance action" }, { status: 400 });
  }
  const start = new Date(observationStart);
  const end = new Date(observationEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end || end > new Date()) return NextResponse.json({ error: "Invalid evidence window" }, { status: 400 });
  const bindings = resolveP5OwnerRoleBindings(identity);
  if (!bindings.valid) return NextResponse.json({ error: "Owner binding configuration is invalid" }, { status: 503 });
  if (!bindings.permittedRoles.includes(role as P5OwnerRole)) return NextResponse.json({ error: "Role is not permitted for this session" }, { status: 403 });
  const policy = resolveP5OperationalPolicy();
  const evidence = await getP5HealthEvidence({ observationStart: start.toISOString(), observationEnd: end.toISOString(), policy });
  const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name]) => [name, process.env[name]?.trim().toLowerCase() === "true"]));
  const observationSampleRate = Number(process.env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0");
  const readiness = evaluateP5RetirementReadiness({ evidence, policy, observationStart: start.toISOString(), observationEnd: end.toISOString(), flags, observationSampleRate });
  if (evidenceDigest !== readiness.evidenceDigest) return NextResponse.json({ error: "Evidence digest is stale", code: "stale_evidence_digest" }, { status: 409 });
  const result = await recordP5OwnerApproval({
    role: role as P5OwnerRole,
    actorHash: p5GovernanceActorHash(identity),
    evidenceDigest,
    currentEvidenceDigest: readiness.evidenceDigest,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (!result.ok) return NextResponse.json({ error: "Governance evidence unavailable", code: result.code }, { status: 503 });
  revalidatePath("/admin/governance");
  return NextResponse.json({ ok: true, evidenceId: result.evidenceId });
}
