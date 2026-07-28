import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleParityIssues,
  publicationParityIssues,
} from "../lib/admin/rollout-parity";

test("P2 rollout parity accepts matching public sets with tracked private attention", () => {
  assert.deepEqual(lifecycleParityIssues({
    anomalyCount: 0,
    uninitializedCount: 0,
    legacyOnlyCount: 0,
    compatibilityOnlyCount: 0,
    legacyPublicCount: 1209,
    compatibilityPublicCount: 1209,
    legacyIdentityDigest: "same",
    compatibilityIdentityDigest: "same",
    activeAttentionCount: 8,
  }), []);
});

test("P2 rollout parity reports count and identity drift", () => {
  assert.deepEqual(lifecycleParityIssues({
    anomalyCount: 0,
    uninitializedCount: 1,
    legacyOnlyCount: 1,
    compatibilityOnlyCount: 0,
    legacyPublicCount: 1209,
    compatibilityPublicCount: 1208,
    legacyIdentityDigest: "legacy",
    compatibilityIdentityDigest: "projection",
  }), ["uninitializedCount", "legacyOnlyCount", "publicCount", "identityDigest"]);
});

test("P3 rollout parity accepts a complete projection with pending delivery work", () => {
  assert.deepEqual(publicationParityIssues({
    articleCount: 1217,
    versionedArticleCount: 1217,
    publicationCount: 1217,
    legacyOnlyCount: 0,
    projectionOnlyCount: 0,
    legacyPublicCount: 1209,
    projectionPublicCount: 1209,
    legacyIdentityDigest: "same",
    projectionIdentityDigest: "same",
    outboxDeadLetterCount: 0,
    outboxProcessingCount: 0,
    outboxPendingCount: 4,
  }), []);
});

test("P3 rollout parity rejects projection, identity, and delivery drift", () => {
  assert.deepEqual(publicationParityIssues({
    articleCount: 1217,
    versionedArticleCount: 1216,
    publicationCount: 1217,
    legacyOnlyCount: 1,
    projectionOnlyCount: 0,
    legacyPublicCount: 1209,
    projectionPublicCount: 1208,
    legacyIdentityDigest: "legacy",
    projectionIdentityDigest: "projection",
    outboxDeadLetterCount: 1,
    outboxProcessingCount: 1,
  }), [
    "versionedArticleCount",
    "legacyOnlyCount",
    "publicCount",
    "identityDigest",
    "outboxDeadLetterCount",
    "outboxProcessingCount",
  ]);
});
