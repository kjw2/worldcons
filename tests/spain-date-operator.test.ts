import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_IAM_OPERATOR_ACTOR, LEGACY_APPROVAL_STATEMENT, parseSpainDateOperatorCommand } from "../workers/async-pipeline/src/spain-date-operator";

const articleId = "c10d71c6-4ac8-4602-804a-721289ecaa03";
const expectedVersionId = "9fe67ff1-6e7b-52cc-ab34-d5e5e3c5e57a";
const hash = "a".repeat(64);

test("Cloudflare operator preview is narrowly scoped and read-only", () => {
  const v = parseSpainDateOperatorCommand({ schemaVersion: 1, mode: "preview", articleId });
  assert.deepEqual(v, { ok: true, command: { schemaVersion: 1, mode: "preview", articleId } });
  for (const change of [
    { confirmPlanHash: hash }, { expectedVersionId }, { arbitrary: "ignore" },
    { articleId: "other-source" }, { mode: "unknown" },
  ]) {
    assert.equal(parseSpainDateOperatorCommand({ schemaVersion: 1, mode: "preview", articleId, ...change }).ok, false);
  }
});
test("Cloudflare operator apply requires the exact version UUID and SHA256 preview hash", () => {
  const input = { schemaVersion: 1, mode: "apply", articleId, expectedVersionId, confirmPlanHash: hash };
  assert.equal(parseSpainDateOperatorCommand(input).ok, true);
  assert.equal(parseSpainDateOperatorCommand({ ...input, expectedVersionId: "latest" }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...input, confirmPlanHash: "wrong" }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...input, confirmPlanHash: undefined }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...input, actorId: "fake-admin" }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...input, mode: "preview" }).ok, false);
});
test("legacy republication requires an explicit timely IAM-bound operator approval receipt", () => {
  const operatorAuthorization = {
    actorId: CLOUD_IAM_OPERATOR_ACTOR, approvedAt: new Date().toISOString(),
    articleId, currentVersionId: expectedVersionId,
    correctedOriginalPublishedAt: "2026-10-06T00:00:00.000Z", evidenceSha256: hash,
  };
  const base = {
    schemaVersion: 1, mode: "apply-legacy", articleId, expectedVersionId,
    confirmPlanHash: hash, approvalStatement: LEGACY_APPROVAL_STATEMENT, operatorAuthorization,
  };
  assert.equal(parseSpainDateOperatorCommand(base).ok, true);
  assert.equal(parseSpainDateOperatorCommand({ ...base, approvalStatement: "" }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...base, operatorAuthorization: {
    ...operatorAuthorization, actorId: "admin:made-up",
  } }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...base, operatorAuthorization: {
    ...operatorAuthorization, approvedAt: "2026-01-01T00:00:00.000Z",
  } }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...base, operatorAuthorization: {
    ...operatorAuthorization, currentVersionId: "11111111-1111-4111-8111-111111111111",
  } }).ok, false);
  assert.equal(parseSpainDateOperatorCommand({ ...base, mode: "apply" }).ok, false);
});
