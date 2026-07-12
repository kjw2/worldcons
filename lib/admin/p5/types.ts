export const P5_OWNER_ROLES = ["operations", "data", "security"] as const;
export type P5OwnerRole = (typeof P5_OWNER_ROLES)[number];

export const P5_OBSERVATION_SURFACES = [
  "admin_command",
  "article_lifecycle",
  "article_publication",
  "public_query",
  "vector_search",
  "admin_dashboard",
  "admin_analytics",
] as const;
export const P5_OBSERVATION_DOMAINS = ["queue", "lifecycle", "publication", "projection", "operations"] as const;
export const P5_OBSERVATION_DIRECTIONS = ["read", "write"] as const;
export const P5_OBSERVATION_AUTHORITIES = ["legacy", "new", "fallback"] as const;
export const P5_OBSERVATION_OUTCOMES = ["selected", "succeeded", "failed", "fallback", "skipped", "disabled", "unavailable"] as const;

export interface P5CompatibilityObservation {
  surface: (typeof P5_OBSERVATION_SURFACES)[number];
  domain: (typeof P5_OBSERVATION_DOMAINS)[number];
  direction: (typeof P5_OBSERVATION_DIRECTIONS)[number];
  authority: (typeof P5_OBSERVATION_AUTHORITIES)[number];
  outcome: (typeof P5_OBSERVATION_OUTCOMES)[number];
  count?: number;
}

export interface P5HealthEvidence {
  schemaVersion: 1;
  generatedAt: string;
  available: boolean;
  observationWindow: { start: string; end: string };
  queue: {
    states: Record<string, number>;
    oldestQueuedAgeSeconds: number | null;
    staleLeaseCount: number;
    oldestHeartbeatAgeSeconds: number | null;
    abortPendingCount: number;
    oldestAbortAgeSeconds: number | null;
    retryWaitingCount: number;
    oldestRetryAgeSeconds: number | null;
  };
  lifecycle: {
    backlogCount: number;
    oldestReviewAgeSeconds: number | null;
    unresolvedAnomalyCount: number;
  };
  publication: {
    legacyPublicCount: number;
    explicitPublicCount: number;
    parityMismatchCount: number;
    quarantineCount: number;
    legacyIdentityDigest: string;
    explicitIdentityDigest: string;
  };
  outbox: {
    pendingCount: number;
    processingCount: number;
    deadLetterCount: number;
    oldestUndeliveredAgeSeconds: number | null;
  };
  sources: Array<{
    sourceKey: string;
    active: boolean;
    latestRunAt: string | null;
    freshnessAgeSeconds: number | null;
  }>;
  compatibility: {
    totalCount: number;
    legacyReadCount: number;
    legacyWriteCount: number;
    newReadCount: number;
    newWriteCount: number;
    fallbackCount: number;
    unexplainedLegacyCount: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    bucketCount: number;
  };
  inFlight: {
    legacyCount: number;
    newCount: number;
    conflict: boolean;
  };
  governance: {
    backupRestoreAt: string | null;
    backupRestoreExpiresAt: string | null;
    approvedRoles: P5OwnerRole[];
  };
  retention: {
    commandAttemptsDue: number;
    commandEventsDue: number;
    lifecycleEventsDue: number;
    publicationHistoryDue: number;
    contentVersionsDue: number;
    compatibilityObservationsDue: number;
    deliveredOutboxDue: number;
    deadLetterOutboxDue: number;
    legalHoldActive: boolean;
  };
}

export type P5SlaStatus = "healthy" | "warning" | "critical" | "unknown";

export interface P5SlaResult {
  key: string;
  label: string;
  owner: P5OwnerRole;
  status: P5SlaStatus;
  value: number | null;
  warningThreshold: number;
  criticalThreshold: number;
  unit: "seconds" | "count";
}

export interface P5RetirementGate {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface P5RetirementReport {
  schemaVersion: 1;
  generatedAt: string;
  implementationStatus: "implementation-ready";
  evidenceStatus: "pending" | "passing";
  observationWindow: { start: string; end: string; hours: number; explicit: true };
  gates: P5RetirementGate[];
  ready: boolean;
  evidenceDigest: string;
  signature: string | null;
  signatureAlgorithm: "hmac-sha256" | null;
}
