/**
 * A strict, Cloudflare-IAM-invoked one-case Spain date-repair command.
 * There is no public HTTP route or bearer-token fallback for this operation.
 * The Cloudflare account audit trail owns workflow creation/triggering.
 */
export const LEGACY_APPROVAL_STATEMENT = "authorize official-date-only correction of this verified published Spanish court decision";
export const CLOUD_IAM_OPERATOR_ACTOR = "operator:cloudflare-iam-spain-date";

export interface SpainDateOperatorReceipt {
  actorId: string;
  approvedAt: string;
  articleId: string;
  currentVersionId: string;
  correctedOriginalPublishedAt: string;
  evidenceSha256: string;
}

export interface SpainDateOperatorCommand {
  schemaVersion: 1;
  mode: "preview" | "apply" | "apply-legacy";
  articleId: string;
  expectedVersionId?: string;
  confirmPlanHash?: string;
  approvalStatement?: string;
  operatorAuthorization?: SpainDateOperatorReceipt;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

export function parseSpainDateOperatorCommand(value: unknown):
  { ok: true; command: SpainDateOperatorCommand } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "spain_date_operator.invalid_payload" };
  }
  const v = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "mode", "articleId", "expectedVersionId", "confirmPlanHash", "approvalStatement", "operatorAuthorization"]);
  if (Object.keys(v).some(key => !allowed.has(key))) {
    return { ok: false, reason: "spain_date_operator.unknown_field" };
  }
  if (v.schemaVersion !== 1 || !["preview", "apply", "apply-legacy"].includes(String(v.mode))) {
    return { ok: false, reason: "spain_date_operator.invalid_contract" };
  }
  if (typeof v.articleId !== "string" || !UUID.test(v.articleId)) {
    return { ok: false, reason: "spain_date_operator.invalid_article_id" };
  }
  const mode = v.mode as SpainDateOperatorCommand["mode"];
  if (mode !== "preview") {
    if (typeof v.expectedVersionId !== "string" || !UUID.test(v.expectedVersionId)) {
      return { ok: false, reason: "spain_date_operator.expected_version_required" };
    }
    if (typeof v.confirmPlanHash !== "string" || !HASH.test(v.confirmPlanHash)) {
      return { ok: false, reason: "spain_date_operator.plan_hash_required" };
    }
  } else if (v.expectedVersionId !== undefined || v.confirmPlanHash !== undefined) {
    return { ok: false, reason: "spain_date_operator.preview_must_be_read_only" };
  }
  let operatorAuthorization: SpainDateOperatorReceipt | undefined;
  if (mode === "apply-legacy") {
    if (v.approvalStatement !== LEGACY_APPROVAL_STATEMENT) {
      return { ok: false, reason: "spain_date_operator.explicit_legacy_approval_required" };
    }
    if (!v.operatorAuthorization || typeof v.operatorAuthorization !== "object" || Array.isArray(v.operatorAuthorization)) {
      return { ok: false, reason: "spain_date_operator.legacy_receipt_required" };
    }
    const a = v.operatorAuthorization as Record<string, unknown>;
    const keys = ["actorId", "approvedAt", "articleId", "currentVersionId", "correctedOriginalPublishedAt", "evidenceSha256"];
    if (Object.keys(a).length !== keys.length || Object.keys(a).some(key => !keys.includes(key))
      || a.actorId !== CLOUD_IAM_OPERATOR_ACTOR || a.articleId !== v.articleId
      || a.currentVersionId !== v.expectedVersionId
      || typeof a.evidenceSha256 !== "string" || !HASH.test(a.evidenceSha256)
      || typeof a.correctedOriginalPublishedAt !== "string"
      || !/^20\d{2}-\d{2}-\d{2}T00:00:00\.000Z$/.test(a.correctedOriginalPublishedAt)
      || typeof a.approvedAt !== "string"
      || !Number.isFinite(Date.parse(a.approvedAt))
      || Math.abs(Date.now() - Date.parse(a.approvedAt)) > 15 * 60 * 1000) {
      return { ok: false, reason: "spain_date_operator.legacy_receipt_invalid" };
    }
    operatorAuthorization = a as unknown as SpainDateOperatorReceipt;
  } else if (v.approvalStatement !== undefined || v.operatorAuthorization !== undefined) {
    return { ok: false, reason: "spain_date_operator.legacy_approval_not_allowed" };
  }
  return {
    ok: true,
    command: {
      schemaVersion: 1,
      mode,
      articleId: v.articleId,
      ...(mode !== "preview" ? {
        expectedVersionId: v.expectedVersionId as string,
        confirmPlanHash: (v.confirmPlanHash as string).toLowerCase(),
      } : {}),
      ...(mode === "apply-legacy" ? {
        approvalStatement: LEGACY_APPROVAL_STATEMENT,
        operatorAuthorization,
      } : {}),
    },
  };
}
