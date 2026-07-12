import { articleLifecycleService } from "@/lib/article-lifecycle/service";
import type { ArticleLifecycleTransitionInput } from "@/lib/article-lifecycle/types";
import { mapLegacyArticleLifecycle, type LegacyArticleLifecycleEvidence } from "@/lib/article-lifecycle/mapping";
import { createHash } from "@/lib/utils/hash";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";

export const ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_FLAG = "ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED";
export const ARTICLE_LIFECYCLE_P2_READ_FLAG = "ARTICLE_LIFECYCLE_P2_READ_ENABLED";
export const ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS_FLAG = "ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS";
export const ARTICLE_LIFECYCLE_P2_COHORTS = ["collection", "summary", "review", "candidate"] as const;
export const ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES = [
  "collection.metadata_only",
  "crawl.robots_disallowed",
  "crawl.blocked",
  "crawl.timeout",
  "crawl.fetch_failed",
  "crawl.blocked_403",
  "crawl.timeout_response",
  "extract.empty_text",
] as const;
export const ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES = [
  "summary.failed",
  "summary.model_error",
  "summary.retryable_quota",
  "llm.key_missing",
  "job.stale_running",
] as const;

export type ArticleLifecycleP2Cohort = (typeof ARTICLE_LIFECYCLE_P2_COHORTS)[number];

type LifecycleService = Pick<typeof articleLifecycleService, "get" | "transition">;

export interface ArticleLifecycleShadowInput extends Omit<ArticleLifecycleTransitionInput, "expectedRevision" | "idempotencyKey"> {
  cohort: ArticleLifecycleP2Cohort;
}

export interface LegacyArticleLifecycleShadowInput {
  articleId: string;
  cohort: ArticleLifecycleP2Cohort;
  actorType: ArticleLifecycleTransitionInput["actorType"];
  actorId?: string | null;
  source: string;
  reasonCode: string;
  evidence: LegacyArticleLifecycleEvidence;
}

export type ArticleLifecycleShadowResult =
  | { shadow: "disabled" | "cohort_disabled" }
  | { shadow: "written" | "noop"; revision: number; idempotent: boolean }
  | { shadow: "failed"; errorCode: string };

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function articleLifecycleP2ShadowWriteEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_FLAG]);
}

export function articleLifecycleP2ReadsEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[ARTICLE_LIFECYCLE_P2_READ_FLAG]);
}

export function articleLifecycleP2ShadowCohorts(environment: Record<string, string | undefined> = process.env) {
  const configured = environment[ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS_FLAG]?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (configured.some((value) => !ARTICLE_LIFECYCLE_P2_COHORTS.includes(value as ArticleLifecycleP2Cohort))) {
    return new Set<ArticleLifecycleP2Cohort>();
  }
  return new Set(configured as ArticleLifecycleP2Cohort[]);
}

export async function shadowArticleLifecycleTransition(
  input: ArticleLifecycleShadowInput,
  options: {
    environment?: Record<string, string | undefined>;
    service?: LifecycleService;
  } = {},
): Promise<ArticleLifecycleShadowResult> {
  const environment = options.environment ?? process.env;
  recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "legacy", outcome: "succeeded" }, { environment });
  if (!articleLifecycleP2ShadowWriteEnabled(environment)) {
    recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: "disabled" }, { environment });
    return { shadow: "disabled" };
  }
  if (!articleLifecycleP2ShadowCohorts(environment).has(input.cohort)) {
    recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: "skipped" }, { environment });
    return { shadow: "cohort_disabled" };
  }

  const service = options.service ?? articleLifecycleService;
  try {
    const current = await service.get(input.articleId);
    if (!current.ok) {
      recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: "failed" }, { environment });
      return { shadow: "failed", errorCode: current.error.code };
    }
    const idempotencyKey = `p2-shadow:${createHash(`${input.articleId}:${current.data.revision}:${input.source}:${input.reasonCode}`, 64)}`;
    const result = await service.transition({
      ...input,
      expectedRevision: current.data.revision,
      idempotencyKey,
    });
    if (!result.ok) {
      console.warn("[article lifecycle shadow]", { event: "transition_failed", source: input.source, errorCode: result.error.code });
      recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: "failed" }, { environment });
      return { shadow: "failed", errorCode: result.error.code };
    }
    recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: result.data.applied ? "succeeded" : "skipped" }, { environment });
    return {
      shadow: result.data.applied ? "written" : "noop",
      revision: result.data.revision,
      idempotent: result.data.idempotent,
    };
  } catch {
    recordCompatibilityObservation({ surface: "article_lifecycle", domain: "lifecycle", direction: "write", authority: "new", outcome: "failed" }, { environment });
    console.warn("[article lifecycle shadow]", { event: "transition_failed", source: input.source, errorCode: "internal" });
    return { shadow: "failed", errorCode: "internal" };
  }
}

export function shadowLegacyArticleLifecycleOutcome(
  input: LegacyArticleLifecycleShadowInput,
  options: Parameters<typeof shadowArticleLifecycleTransition>[1] = {},
) {
  const mapped = mapLegacyArticleLifecycle(input.evidence);
  const authority = {
    articleId: input.articleId,
    cohort: input.cohort,
    actorType: input.actorType,
    actorId: input.actorId,
    source: input.source,
    reasonCode: input.reasonCode,
  };
  if (!mapped.ok) {
    return shadowArticleLifecycleTransition({
      ...authority,
      reviewState: mapped.reviewState,
      attention: {
        operation: "quarantine",
        code: mapped.anomalyCode,
        retryable: false,
        severity: "high",
        source: "backfill",
      },
    }, options);
  }
  return shadowArticleLifecycleTransition({ ...authority, ...mapped.state }, options);
}
