import assert from "node:assert/strict";
import test from "node:test";

const PROBE_KEYS = ["caseId", "decisionDate", "koreanTitle", "holdingKo", "statute", "topics"] as const;

const OBSERVED_PROBE = {
  caseId: "P0-SYNTH-001",
  decisionDate: "2024-01-15",
  koreanTitle: "정보공개 거부처분 취소소송",
  holdingKo: "행정청이 거부 사유를 제시하지 않고 정보공개 청구를 거부한 처분은 위법하다.",
  statute: "공공기관의 정보공개에 관한 법률 제9조",
  topics: ["정보공개"],
};

type Probe = {
  caseId: string;
  decisionDate: string;
  koreanTitle: string;
  holdingKo: string;
  statute: string;
  topics: string[];
};

type ProbeResult = { ok: true; value: Probe } | { ok: false; errors: string[] };

export function validateP0Probe(value: unknown): ProbeResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["root must be an object"] };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PROBE_KEYS.length || PROBE_KEYS.some((key) => !keys.includes(key))) {
    errors.push("keys must be exactly caseId, decisionDate, koreanTitle, holdingKo, statute, topics");
  }
  if (record.caseId !== "P0-SYNTH-001") errors.push("caseId must be P0-SYNTH-001");
  if (record.decisionDate !== "2024-01-15") errors.push("decisionDate must be 2024-01-15");
  if (record.statute !== "공공기관의 정보공개에 관한 법률 제9조") errors.push("statute must match the synthetic source");
  if (typeof record.koreanTitle !== "string" || [...record.koreanTitle].length < 8 || [...record.koreanTitle].length > 40) {
    errors.push("koreanTitle must be 8 to 40 characters");
  }
  if (typeof record.holdingKo !== "string" || [...record.holdingKo].length < 20 || [...record.holdingKo].length > 80) {
    errors.push("holdingKo must be 20 to 80 characters");
  }
  if (!Array.isArray(record.topics) || record.topics.length !== 1 || record.topics[0] !== "정보공개") {
    errors.push("topics must be exactly [정보공개]");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as Probe };
}

const OMITTED_LOG_KEY = /(head|prompt|content|message|authorization|secret|token|cookie|api|payload|preview|request|response)/i;

export function redactGatewayLog(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return { truncated: true };
  if (typeof value === "string") {
    if (OMITTED_LOG_KEY.test(key) || value.length > 180) return { omitted: true, length: value.length };
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    if (typeof value === "number" && OMITTED_LOG_KEY.test(key)) return { omitted: true, type: "number" };
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => redactGatewayLog(entry, key, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactGatewayLog(childValue, childKey, depth + 1);
    }
    return out;
  }
  return { type: typeof value };
}

type P0Receipt = {
  httpStatus: number;
  schemaValid: boolean;
  authentication: boolean | null;
  byokAlias: string | null;
  wholesale: boolean | null;
  gatewayByokOnlyFromApi: boolean | null;
  routeDefinitionRead: boolean;
  step: number | null;
  fallbackStepsObserved: number;
  timeoutProbeRan: boolean;
  model: string | null;
  logId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

export function assessP0Receipt(receipt: P0Receipt) {
  const authenticatedCall = receipt.httpStatus >= 200 && receipt.httpStatus < 300 && receipt.authentication === true;
  const requestUsedDefaultByok = receipt.byokAlias === "default" && receipt.wholesale === false;
  const byokOnlySettingRead = receipt.gatewayByokOnlyFromApi === true;
  const fallbackObserved = receipt.fallbackStepsObserved > 0 || (receipt.step !== null && receipt.step > 0);
  const guards = {
    authenticatedCall,
    schemaValid: receipt.schemaValid,
    byokOnlySettingRead,
    requestUsedDefaultByok,
    routeDefinitionRead: receipt.routeDefinitionRead,
    fallbackObserved,
    timeoutProbeRan: receipt.timeoutProbeRan,
    modelRecorded: Boolean(receipt.model),
    logIdRecorded: Boolean(receipt.logId),
    usageRecorded: receipt.promptTokens !== null && receipt.completionTokens !== null,
  };
  const cutoverAllowed = Object.values(guards).every(Boolean);
  return { guards, cutoverAllowed };
}

const OBSERVED_RECEIPT: P0Receipt = {
  httpStatus: 200,
  schemaValid: true,
  authentication: true,
  byokAlias: "default",
  wholesale: false,
  gatewayByokOnlyFromApi: null,
  routeDefinitionRead: false,
  step: 0,
  fallbackStepsObserved: 0,
  timeoutProbeRan: false,
  model: "gemini-3.5-flash-lite",
  logId: "01a1c42a-b81c-7157-ac14-74bdfef2f8a3",
  promptTokens: 198,
  completionTokens: 130,
};

test("observed P0 probe JSON matches the strict identity and length contract", () => {
  const parsed = JSON.parse(JSON.stringify(OBSERVED_PROBE));
  const result = validateP0Probe(parsed);
  assert.equal(result.ok, true);
  assert.equal([...OBSERVED_PROBE.koreanTitle].length, 14);
  assert.equal([...OBSERVED_PROBE.holdingKo].length, 42);
});

test("probe contract rejects identity drift, length misses, extra keys, and non-JSON", () => {
  assert.equal(validateP0Probe({ ...OBSERVED_PROBE, caseId: "OTHER" }).ok, false);
  assert.equal(validateP0Probe({ ...OBSERVED_PROBE, decisionDate: "2024-01-16" }).ok, false);
  assert.equal(validateP0Probe({ ...OBSERVED_PROBE, holdingKo: "짧다" }).ok, false);
  assert.equal(validateP0Probe({ ...OBSERVED_PROBE, extra: true }).ok, false);
  assert.equal(validateP0Probe(JSON.parse("\"not-an-object\"")).ok, false);
  assert.throws(() => JSON.parse("```json\n{}\n```"));
});

test("log redaction drops payloads, previews, and token-like fields", () => {
  const redacted = redactGatewayLog({
    provider: "unknown",
    model: "gemini-3.5-flash-lite",
    byok: "default",
    authentication: true,
    wholesale: false,
    request: "synthetic prompt must not be stored",
    response: "synthetic completion must not be stored",
    secret_preview: "abcd",
    tokens_in: 198,
    metadata: { worldcons_p0: "20261110", route: "gemini-flash-fallback" },
  }) as Record<string, unknown>;
  assert.equal(redacted.provider, "unknown");
  assert.equal(redacted.byok, "default");
  assert.equal(redacted.wholesale, false);
  assert.deepEqual(redacted.request, { omitted: true, length: "synthetic prompt must not be stored".length });
  assert.deepEqual(redacted.secret_preview, { omitted: true, length: 4 });
  assert.deepEqual(redacted.tokens_in, { omitted: true, type: "number" });
  assert.equal(JSON.stringify(redacted).includes("abcd"), false);
  assert.equal(JSON.stringify(redacted).includes("synthetic prompt"), false);
});

test("observed receipt does not authorize production cutover", () => {
  const assessment = assessP0Receipt(OBSERVED_RECEIPT);
  assert.equal(assessment.guards.authenticatedCall, true);
  assert.equal(assessment.guards.schemaValid, true);
  assert.equal(assessment.guards.requestUsedDefaultByok, true);
  assert.equal(assessment.guards.byokOnlySettingRead, false);
  assert.equal(assessment.guards.routeDefinitionRead, false);
  assert.equal(assessment.guards.fallbackObserved, false);
  assert.equal(assessment.guards.timeoutProbeRan, false);
  assert.equal(assessment.cutoverAllowed, false);
});
