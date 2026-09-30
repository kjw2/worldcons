import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import type { P5OwnerRole } from "@/lib/admin/p5/types";

export async function recordP5OwnerApprovalD1(options: {
  role: P5OwnerRole;
  actorHash: string;
  evidenceDigest: string;
  currentEvidenceDigest: string;
  expiresAt: string;
}) {
  if (options.evidenceDigest !== options.currentEvidenceDigest) {
    return { ok: false as const, code: "stale_evidence_digest" };
  }
  const ops = getRuntimeD1Binding("worldcons_ops");
  if (!ops) return { ok: false as const, code: "unavailable" };
  const evidenceAt = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    const statement = ops.prepare([
      "INSERT INTO admin_governance_evidence_p5",
      "(id,evidence_type,role_key,outcome,actor_hash,evidence_at,expires_at,evidence_digest,note_code)",
      "VALUES (?,'owner_approval',?,'approved',?,?,?,?, 'retirement.readiness.v2')",
    ].join(" ")).bind(id, options.role, options.actorHash, evidenceAt, options.expiresAt, options.evidenceDigest);
    if (!statement.run) throw new Error("p5_governance.d1_write_unavailable");
    const result = await statement.run();
    if (result.success === false || result.error) throw new Error(result.error || "p5_governance.d1_write_failed");
    return { ok: true as const, evidenceId: id };
  } catch (error) {
    return { ok: false as const, code: error instanceof Error ? error.message : "database_error" };
  }
}
