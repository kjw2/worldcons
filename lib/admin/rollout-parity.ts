type AggregateEvidence = Record<string, unknown>;

function count(evidence: AggregateEvidence, key: string) {
  const value = Number(evidence[key]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function digest(evidence: AggregateEvidence, key: string) {
  return typeof evidence[key] === "string" ? evidence[key] : "";
}

export function lifecycleParityIssues(evidence: AggregateEvidence) {
  const issues: string[] = [];
  if (count(evidence, "anomalyCount") !== 0) issues.push("anomalyCount");
  if (count(evidence, "uninitializedCount") !== 0) issues.push("uninitializedCount");
  if (count(evidence, "legacyOnlyCount") !== 0) issues.push("legacyOnlyCount");
  if (count(evidence, "compatibilityOnlyCount") !== 0) issues.push("compatibilityOnlyCount");
  if (count(evidence, "legacyPublicCount") !== count(evidence, "compatibilityPublicCount")) {
    issues.push("publicCount");
  }
  const legacyDigest = digest(evidence, "legacyIdentityDigest");
  const compatibilityDigest = digest(evidence, "compatibilityIdentityDigest");
  if (!legacyDigest || legacyDigest !== compatibilityDigest) issues.push("identityDigest");
  return issues;
}

export function publicationParityIssues(evidence: AggregateEvidence) {
  const issues: string[] = [];
  const articleCount = count(evidence, "articleCount");
  if (articleCount !== count(evidence, "versionedArticleCount")) issues.push("versionedArticleCount");
  if (articleCount !== count(evidence, "publicationCount")) issues.push("publicationCount");
  if (count(evidence, "legacyOnlyCount") !== 0) issues.push("legacyOnlyCount");
  if (count(evidence, "projectionOnlyCount") !== 0) issues.push("projectionOnlyCount");
  if (count(evidence, "legacyPublicCount") !== count(evidence, "projectionPublicCount")) {
    issues.push("publicCount");
  }
  const legacyDigest = digest(evidence, "legacyIdentityDigest");
  const projectionDigest = digest(evidence, "projectionIdentityDigest");
  if (!legacyDigest || legacyDigest !== projectionDigest) issues.push("identityDigest");
  if (count(evidence, "outboxDeadLetterCount") !== 0) issues.push("outboxDeadLetterCount");
  if (count(evidence, "outboxProcessingCount") !== 0) issues.push("outboxProcessingCount");
  return issues;
}

export function assertLifecycleParity(evidence: AggregateEvidence) {
  const issues = lifecycleParityIssues(evidence);
  if (issues.length > 0) throw new Error(`P2 parity failed: ${issues.join(", ")}`);
}

export function assertPublicationParity(evidence: AggregateEvidence) {
  const issues = publicationParityIssues(evidence);
  if (issues.length > 0) throw new Error(`P3 parity failed: ${issues.join(", ")}`);
}
