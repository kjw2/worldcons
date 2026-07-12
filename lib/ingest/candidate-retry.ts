import { ARTICLE_CONTENT_TYPES, type ArticleContentType } from "@/lib/db/types";
import {
  beginSourceUrlCandidateRetry,
  finishSourceUrlCandidateRetry,
  type SourceUrlCandidateRetryClaim,
} from "@/lib/db/source-url-candidates";
import { articleExists, articleExistsByNormalizedContent, insertNormalizedArticle } from "@/lib/ingest/run";
import { loadSourceAdapter } from "@/lib/sources/lazy";
import type { DiscoveredItem, SourceAdapter } from "@/lib/sources/types";
import { redactAdminAuditText } from "@/lib/security/audit-redaction";

const OFFICIAL_SOURCE_HOSTS: Record<string, ReadonlySet<string>> = {
  "de-bverfg": new Set(["www.bundesverfassungsgericht.de", "bundesverfassungsgericht.de"]),
  "us-scotus": new Set(["www.supremecourt.gov", "supremecourt.gov"]),
  "fr-conseil-constitutionnel": new Set(["www.conseil-constitutionnel.fr", "qpc360.conseil-constitutionnel.fr"]),
  "es-tribunal-constitucional": new Set(["hj.tribunalconstitucional.es", "www.tribunalconstitucional.es", "tribunalconstitucional.es"]),
};

const BROAD_PATHS = new Set([
  "/",
  "/decisions",
  "/decisions/",
  "/opinions",
  "/opinions/",
  "/entscheidungen",
  "/entscheidungen/",
  "/resultados",
  "/resultados/",
]);

export class CandidateRetryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "CandidateRetryError";
  }
}

export interface CandidateRetryDependencies {
  begin(candidateId: string): Promise<SourceUrlCandidateRetryClaim>;
  finish: typeof finishSourceUrlCandidateRetry;
  loadAdapter(sourceKey: string): Promise<SourceAdapter | null>;
  articleExists(canonicalUrl: string): Promise<boolean>;
  articleExistsByNormalizedContent: typeof articleExistsByNormalizedContent;
  insertNormalizedArticle: typeof insertNormalizedArticle;
}

export interface CandidateRetryOptions {
  candidateId: string;
  checkpoint: () => Promise<void>;
  signal?: AbortSignal;
}

const defaultDependencies: CandidateRetryDependencies = {
  begin: beginSourceUrlCandidateRetry,
  finish: finishSourceUrlCandidateRetry,
  loadAdapter: loadSourceAdapter,
  articleExists,
  articleExistsByNormalizedContent,
  insertNormalizedArticle,
};

async function candidateCheckpoint(options: CandidateRetryOptions) {
  if (options.signal?.aborted) throw options.signal.reason;
  await options.checkpoint();
  if (options.signal?.aborted) throw options.signal.reason;
}

function safeCandidateErrorMessage(error: unknown) {
  const message = redactAdminAuditText(error instanceof Error ? error.message : String(error), 500);
  return message.replace(/https?:\/\/[^\s<>'"`]+/gi, "[redacted-url]");
}

function candidateFailure(error: unknown) {
  if (error instanceof CandidateRetryError) return { code: error.code, retryable: error.retryable };
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/timeout|timed out/.test(message)) return { code: "candidate.timeout", retryable: true };
  if (/network|fetch failed|econn|enotfound|429|502|503|504/.test(message)) {
    return { code: "candidate.network_error", retryable: true };
  }
  return { code: "candidate.fetch_failed", retryable: false };
}

export function isSafeOfficialCandidateUrl(sourceKey: string, storedUrl: string) {
  const allowedHosts = OFFICIAL_SOURCE_HOSTS[sourceKey];
  if (!allowedHosts || storedUrl !== storedUrl.trim()) return false;
  try {
    const url = new URL(storedUrl);
    const path = url.pathname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && !url.hash
      && allowedHosts.has(url.hostname.toLowerCase())
      && !BROAD_PATHS.has(path)
      && !/(^|\/)(search|suche|recherche)(\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function candidateContentType(value: string): ArticleContentType | null {
  return ARTICLE_CONTENT_TYPES.includes(value as ArticleContentType) ? value as ArticleContentType : null;
}

async function markFailed(
  claim: SourceUrlCandidateRetryClaim,
  error: unknown,
  dependencies: CandidateRetryDependencies,
): Promise<never> {
  const failure = candidateFailure(error);
  await dependencies.finish({
    candidateId: claim.candidateId,
    attemptCount: claim.attemptCount,
    status: "failed",
    errorCode: failure.code,
    errorMessage: safeCandidateErrorMessage(error),
  });
  throw new CandidateRetryError(failure.code, failure.retryable);
}

export async function executeExactCandidateRetry(
  options: CandidateRetryOptions,
  dependencies: CandidateRetryDependencies = defaultDependencies,
) {
  const claim = await dependencies.begin(options.candidateId);
  if (!claim.shouldFetch) {
    return { candidateId: claim.candidateId, status: claim.status, attempted: false, idempotent: true };
  }

  try {
    const contentType = candidateContentType(claim.candidateType);
    if (!contentType) throw new CandidateRetryError("candidate.invalid_type", false);
    if (!isSafeOfficialCandidateUrl(claim.sourceKey, claim.url)) {
      throw new CandidateRetryError("candidate.unsafe_official_url", false);
    }
    const adapter = await dependencies.loadAdapter(claim.sourceKey);
    if (!adapter || adapter.sourceKey !== claim.sourceKey) {
      throw new CandidateRetryError("candidate.source_not_supported", false);
    }

    await candidateCheckpoint(options);
    if (await dependencies.articleExists(claim.url)) {
      await candidateCheckpoint(options);
      await dependencies.finish({ candidateId: claim.candidateId, attemptCount: claim.attemptCount, status: "fetched" });
      return { candidateId: claim.candidateId, status: "fetched" as const, attempted: false, idempotent: true };
    }

    const exactItem: DiscoveredItem = {
      sourceKey: claim.sourceKey,
      url: claim.url,
      canonicalUrl: claim.url,
      contentType,
    };
    const raw = await adapter.fetchItem(exactItem, {
      strategy: "auto",
      limit: 1,
      signal: options.signal,
      checkpoint: options.checkpoint,
    });
    await candidateCheckpoint(options);
    const normalized = await adapter.normalize(raw);
    await candidateCheckpoint(options);
    if (normalized.sourceKey !== claim.sourceKey) {
      throw new CandidateRetryError("candidate.source_ownership_mismatch", false);
    }
    if (!isSafeOfficialCandidateUrl(claim.sourceKey, normalized.canonicalUrl)) {
      throw new CandidateRetryError("candidate.normalized_url_unsafe", false);
    }
    if (normalized.canonicalUrl !== claim.url) {
      throw new CandidateRetryError("candidate.canonical_url_mismatch", false);
    }

    await candidateCheckpoint(options);
    const duplicate = await dependencies.articleExistsByNormalizedContent(normalized);
    await candidateCheckpoint(options);
    const inserted = duplicate ? null : await dependencies.insertNormalizedArticle(normalized, null, {
      cohort: "candidate",
      actorType: "candidate",
      source: "candidate.insert",
    });
    if (!duplicate && !inserted) throw new CandidateRetryError("candidate.not_persisted", false);

    await candidateCheckpoint(options);
    await dependencies.finish({ candidateId: claim.candidateId, attemptCount: claim.attemptCount, status: "fetched" });
    return {
      candidateId: claim.candidateId,
      status: "fetched" as const,
      attempted: true,
      idempotent: duplicate,
      inserted: Boolean(inserted),
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof Error && error.name === "WorkerCheckpointError") throw error;
    if (error instanceof Error && /ADMIN_QUEUE_(STALE_CANDIDATE_ATTEMPT|CANDIDATE_STATE_CONFLICT)/.test(error.message)) {
      throw new CandidateRetryError("candidate.stale_attempt", false);
    }
    return markFailed(claim, error, dependencies);
  }
}
