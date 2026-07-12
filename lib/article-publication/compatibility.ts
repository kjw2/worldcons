import { articlePublicationService } from "@/lib/article-publication/service";
import type {
  ArticlePublicationSnapshot,
  ArticlePublicationTransitionInput,
  ArticleVersionProvenanceActor,
} from "@/lib/article-publication/types";
import { createHash } from "@/lib/utils/hash";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";
import type { P5CompatibilityObservation } from "@/lib/admin/p5/types";

export const ADMIN_PUBLICATION_V4_SHADOW_WRITE_FLAG = "ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED";
export const ADMIN_PUBLICATION_V4_READ_FLAG = "ADMIN_PUBLICATION_V4_READ_ENABLED";
export const ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_FLAG = "ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED";

type PublicationService = Pick<typeof articlePublicationService, "getSnapshot" | "transition">;

export interface ConfirmedLegacyArticleMutation {
  articleId: string;
  succeeded: boolean;
  reason: string;
  provenanceActorType: ArticleVersionProvenanceActor;
  provenanceActorId?: string | null;
  modelRef?: string | null;
  promptRef?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  safeMetadata?: Record<string, unknown>;
}

export type ArticlePublicationShadowResult =
  | { shadow: "disabled" | "not_confirmed" }
  | { shadow: "written" | "noop"; versionCreated: boolean; publicationApplied: boolean; idempotent: boolean }
  | { shadow: "failed"; errorCode: string };

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function articlePublicationV4ShadowWriteEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[ADMIN_PUBLICATION_V4_SHADOW_WRITE_FLAG]);
}

export function articlePublicationV4ReadsEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[ADMIN_PUBLICATION_V4_READ_FLAG]);
}

export function observeArticlePublicationReadDecision(
  surface: P5CompatibilityObservation["surface"],
  environment: Record<string, string | undefined> = process.env,
) {
  const selected = articlePublicationV4ReadsEnabled(environment);
  recordCompatibilityObservation({ surface, domain: "projection", direction: "read", authority: selected ? "new" : "legacy", outcome: "selected" }, { environment });
  return selected;
}

export function articlePublicationV4OutboxProcessorEnabled(environment: Record<string, string | undefined> = process.env) {
  return explicitTrue(environment[ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_FLAG]);
}

function targetState(snapshot: ArticlePublicationSnapshot, legacyPublic: boolean) {
  if (legacyPublic) return "published" as const;
  if (snapshot.publicationState === "published") return "withdrawn" as const;
  return snapshot.publicationState ?? "draft";
}

export async function shadowConfirmedLegacyArticleMutation(
  input: ConfirmedLegacyArticleMutation,
  options: {
    environment?: Record<string, string | undefined>;
    service?: PublicationService;
    legacyPublic?: (articleId: string) => Promise<boolean>;
  } = {},
): Promise<ArticlePublicationShadowResult> {
  if (!input.succeeded) return { shadow: "not_confirmed" };
  const environment = options.environment ?? process.env;
  recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "legacy", outcome: "succeeded" }, { environment });
  if (!articlePublicationV4ShadowWriteEnabled(environment)) {
    recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "disabled" }, { environment });
    return { shadow: "disabled" };
  }
  const service = options.service ?? articlePublicationService;

  try {
    const current = await service.getSnapshot(input.articleId);
    if (!current.ok) {
      recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "failed" }, { environment });
      return { shadow: "failed", errorCode: current.error.code };
    }
    const legacyPublic = options.legacyPublic
      ? await options.legacyPublic(input.articleId)
      : await loadLegacyPublicOutcome(input.articleId);
    const target = targetState(current.data, legacyPublic);
    const idempotencyKey = `p3-shadow:${createHash([
      input.articleId,
      current.data.legacyUpdatedAt,
      current.data.versionRevision,
      current.data.publicationRevision,
      target,
      input.reason,
    ].join(":"), 64)}`;
    const transition: ArticlePublicationTransitionInput = {
      articleId: input.articleId,
      expectedVersionRevision: current.data.versionRevision,
      expectedPublicationRevision: current.data.publicationRevision,
      expectedLegacyUpdatedAt: current.data.legacyUpdatedAt,
      idempotencyKey,
      targetState: target,
      captureLegacy: true,
      actorType: "compatibility",
      actorId: "legacy-publication-shadow",
      reason: input.reason,
      requestId: input.requestId,
      correlationId: input.correlationId,
      provenanceActorType: input.provenanceActorType,
      provenanceActorId: input.provenanceActorId,
      modelRef: input.modelRef,
      promptRef: input.promptRef,
      safeMetadata: input.safeMetadata,
    };
    const result = await service.transition(transition);
    if (!result.ok) {
      console.warn("[article publication shadow]", { event: "transition_failed", errorCode: result.error.code });
      recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "failed" }, { environment });
      return { shadow: "failed", errorCode: result.error.code };
    }
    recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: result.data.versionCreated || result.data.publicationApplied ? "succeeded" : "skipped" }, { environment });
    return {
      shadow: result.data.versionCreated || result.data.publicationApplied ? "written" : "noop",
      versionCreated: result.data.versionCreated,
      publicationApplied: result.data.publicationApplied,
      idempotent: result.data.idempotent,
    };
  } catch {
    recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "failed" }, { environment });
    console.warn("[article publication shadow]", { event: "transition_failed", errorCode: "internal" });
    return { shadow: "failed", errorCode: "internal" };
  }
}

async function loadLegacyPublicOutcome(articleId: string) {
  const { getSupabaseServiceRoleAdmin } = await import("@/lib/db/client");
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("publication shadow unavailable");
  const { data, error } = await supabase
    .from("articles")
    .select("status,source_metadata")
    .eq("id", articleId)
    .maybeSingle();
  if (error || !data) throw new Error("publication shadow evidence unavailable");
  const metadata = data.source_metadata && typeof data.source_metadata === "object"
    ? data.source_metadata as Record<string, unknown>
    : {};
  const collection = metadata.collection && typeof metadata.collection === "object"
    ? metadata.collection as Record<string, unknown>
    : {};
  return data.status === "summarized" && collection.publishable === true;
}
