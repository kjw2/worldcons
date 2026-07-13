export const ADMIN_WORK_TYPES = ["execution", "article", "candidate", "outbox", "legacy"] as const;
export const ADMIN_WORK_STAGES = ["collect", "process", "review", "publish"] as const;
export const ADMIN_WORK_SCOPES = ["all", "operations", "tracking"] as const;
export const ADMIN_WORK_ATTENTION = ["all", "required", "clear"] as const;
export const ADMIN_WORK_SLA = ["all", "breached", "due", "healthy"] as const;
export const ADMIN_WORK_AGES = ["all", "1h", "24h", "7d", "30d"] as const;
export const ADMIN_WORK_SORTS = ["newest", "oldest", "sla"] as const;

export type AdminWorkType = (typeof ADMIN_WORK_TYPES)[number];
export type AdminWorkStage = (typeof ADMIN_WORK_STAGES)[number];
export type AdminWorkScope = (typeof ADMIN_WORK_SCOPES)[number];
export type AdminWorkAttentionFilter = (typeof ADMIN_WORK_ATTENTION)[number];
export type AdminWorkSlaFilter = (typeof ADMIN_WORK_SLA)[number];
export type AdminWorkAgeFilter = (typeof ADMIN_WORK_AGES)[number];
export type AdminWorkSort = (typeof ADMIN_WORK_SORTS)[number];

export interface AdminWorkFilters {
  scope: AdminWorkScope;
  owner?: string;
  stage?: AdminWorkStage;
  source?: string;
  type?: AdminWorkType;
  state?: string;
  attention: AdminWorkAttentionFilter;
  sla: AdminWorkSlaFilter;
  age: AdminWorkAgeFilter;
  sort: AdminWorkSort;
  page: number;
  pageSize: number;
}

export interface AdminWorkStateLabel {
  value: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface AdminWorkItem {
  id: string;
  type: AdminWorkType;
  stage: AdminWorkStage;
  title: string;
  target: string;
  source: string | null;
  owner: string | null;
  execution: AdminWorkStateLabel;
  lifecycle: AdminWorkStateLabel;
  publication: AdminWorkStateLabel;
  attention: boolean;
  attentionCode: string | null;
  createdAt: string;
  updatedAt: string;
  slaDueAt: string;
  slaState: "breached" | "due" | "healthy";
  latestError: string | null;
  attempts: number;
  compatibility: boolean;
  detailHref: string;
  safeAction: "abort" | "retry" | "candidate-retry" | "publish" | "withdraw" | null;
  actionDisabledReason: string | null;
}

export interface AdminWorkQueueSnapshot {
  generatedAt: string;
  available: boolean;
  compatibilityMode: boolean;
  warnings: string[];
  items: AdminWorkItem[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    truncated: boolean;
  };
  counts: {
    backlog: number;
    breached: number;
    failed: number;
    stale: number;
    abortRequested: number;
    outbox: number;
    trackingCandidates: number;
    candidateOfficialDetail404: number;
    candidateDiscoveryEmpty: number;
    candidateOther: number;
  };
}

export interface AdminWorkTimelineEvent {
  id: string;
  category: "execution" | "lifecycle" | "publication" | "audit" | "outbox";
  title: string;
  state: string;
  occurredAt: string;
  actor: string | null;
  reason: string | null;
  correlationId: string | null;
}

export interface AdminWorkItemDetail {
  item: AdminWorkItem;
  timeline: AdminWorkTimelineEvent[];
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  fencingToken: string | null;
  abortRequestedAt: string | null;
  links: Array<{ href: string; label: string }>;
  warnings: string[];
}
