/**
 * A strict, Cloudflare-IAM-invoked one-case Spain date-repair command.
 * There is no public HTTP route or bearer-token fallback for this operation.
 * The Cloudflare account audit trail owns workflow creation/triggering.
 */
export interface SpainDateOperatorCommand {
  schemaVersion: 1;
  mode: "preview" | "apply";
  articleId: string;
  expectedVersionId?: string;
  confirmPlanHash?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

export function parseSpainDateOperatorCommand(value: unknown):
  { ok: true; command: SpainDateOperatorCommand } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "spain_date_operator.invalid_payload" };
  }
  const v = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "mode", "articleId", "expectedVersionId", "confirmPlanHash"]);
  if (Object.keys(v).some(key => !allowed.has(key))) {
    return { ok: false, reason: "spain_date_operator.unknown_field" };
  }
  if (v.schemaVersion !== 1 || !["preview", "apply"].includes(String(v.mode))) {
    return { ok: false, reason: "spain_date_operator.invalid_contract" };
  }
  if (typeof v.articleId !== "string" || !UUID.test(v.articleId)) {
    return { ok: false, reason: "spain_date_operator.invalid_article_id" };
  }
  const mode = v.mode as "preview" | "apply";
  if (mode === "apply") {
    if (typeof v.expectedVersionId !== "string" || !UUID.test(v.expectedVersionId)) {
      return { ok: false, reason: "spain_date_operator.expected_version_required" };
    }
    if (typeof v.confirmPlanHash !== "string" || !HASH.test(v.confirmPlanHash)) {
      return { ok: false, reason: "spain_date_operator.plan_hash_required" };
    }
  } else if (v.expectedVersionId !== undefined || v.confirmPlanHash !== undefined) {
    return { ok: false, reason: "spain_date_operator.preview_must_be_read_only" };
  }
  return {
    ok: true,
    command: {
      schemaVersion: 1,
      mode,
      articleId: v.articleId,
      ...(mode === "apply" ? {
        expectedVersionId: v.expectedVersionId as string,
        confirmPlanHash: (v.confirmPlanHash as string).toLowerCase(),
      } : {}),
    },
  };
}
