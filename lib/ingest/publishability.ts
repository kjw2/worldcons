import type { ArticleStatus } from "@/lib/db/types";
import type { CollectionMetadata, CrawlAttemptLog } from "@/lib/crawler/types";
import type { NormalizedArticle } from "@/lib/sources/types";

export const MIN_PUBLISHABLE_TEXT_LENGTH = 500;

type CollectionLike = Partial<CollectionMetadata> & Record<string, unknown>;

interface MetadataWithCollection {
  collection?: CollectionLike;
  diagnostics?: CrawlAttemptLog[];
  robots?: { allowed?: boolean; matchedRule?: string };
  review?: { required?: boolean; reason?: string };
}

function asMetadata(value: unknown): MetadataWithCollection {
  return typeof value === "object" && value !== null ? (value as MetadataWithCollection) : {};
}

function attemptsFrom(metadata: MetadataWithCollection) {
  return Array.isArray(metadata.diagnostics) ? metadata.diagnostics : [];
}

function textLengthFor(article: Pick<NormalizedArticle, "cleanedText" | "rawText">) {
  return (article.cleanedText || article.rawText || "").trim().length;
}

function hasStrictSourceTextPolicy(collection?: CollectionLike) {
  return collection?.strictSourceTextAvailable === true || collection?.sourceTextPolicy === "strict";
}

function sourceTextAvailableFor(collection: CollectionLike | undefined, length: number) {
  if (hasStrictSourceTextPolicy(collection)) return collection?.sourceTextAvailable === true;
  return collection?.sourceTextAvailable === true || length >= MIN_PUBLISHABLE_TEXT_LENGTH;
}

function hasRobotsDisallow(metadata: MetadataWithCollection) {
  const collection = metadata.collection;
  return (
    collection?.robotsDisallowed === true ||
    metadata.robots?.allowed === false ||
    attemptsFrom(metadata).some((attempt) => attempt.errorCode === "ROBOTS_DISALLOW" || /ROBOTS_DISALLOW/i.test(attempt.errorMessage ?? ""))
  );
}

function hasBlockedSignal(metadata: MetadataWithCollection) {
  return attemptsFrom(metadata).some(
    (attempt) =>
      attempt.status === 403 ||
      attempt.blocked === true ||
      /403|forbidden|access denied|blocked|bot protection/i.test(`${attempt.errorCode ?? ""} ${attempt.errorMessage ?? ""}`),
  );
}

function hasTimeoutSignal(metadata: MetadataWithCollection) {
  return attemptsFrom(metadata).some(
    (attempt) => attempt.timeout === true || /timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT/i.test(`${attempt.errorCode ?? ""} ${attempt.errorMessage ?? ""}`),
  );
}

function hasExtractionFailureSignal(metadata: MetadataWithCollection) {
  return attemptsFrom(metadata).some(
    (attempt) => /PDF_EMPTY_BUFFER|PDF_TEXT_EXTRACTION_FAILED/i.test(`${attempt.errorCode ?? ""} ${attempt.errorMessage ?? ""}`),
  );
}

function hasRequiredReview(metadata: MetadataWithCollection) {
  return metadata.review?.required === true;
}

function defaultReason(status: ArticleStatus, strategy?: string) {
  if (status === "robots_disallowed") return "robots.txt policy disallows automatic source text fetch. Official link is preserved for manual review.";
  if (status === "blocked") return "Official site returned access denied, 403, or bot-protection response.";
  if (status === "timeout") return "Official site request did not complete within the crawler timeout.";
  if (status === "metadata_only" && strategy === "seed") return "Live discovery or source text fetch failed. Seed URL was stored for later retry.";
  if (status === "metadata_only") return "Official metadata was collected, but source text is not available.";
  if (status === "needs_review") return "Automatic collection succeeded, but the result requires human review before publication.";
  return undefined;
}

export function deriveCollectionStatus(article: NormalizedArticle): ArticleStatus {
  const metadata = asMetadata(article.metadata);
  const collection = metadata.collection;
  const length = textLengthFor(article);
  const strategy = collection?.strategy;
  const sourceTextAvailable = sourceTextAvailableFor(collection, length);

  if (hasRobotsDisallow(metadata)) return "robots_disallowed";
  if (!sourceTextAvailable && hasBlockedSignal(metadata)) return "blocked";
  if (!sourceTextAvailable && hasTimeoutSignal(metadata)) return "timeout";
  if (!sourceTextAvailable && hasExtractionFailureSignal(metadata)) return "needs_review";
  if (hasRequiredReview(metadata)) return "needs_review";
  if (strategy === "seed" || !sourceTextAvailable) return "metadata_only";
  if (collection?.publishable === false) return "needs_review";
  return "cleaned";
}

export function finalizeCollectionMetadata(article: NormalizedArticle, diagnosticsId?: string | null, constitutionalRelevant = true): CollectionMetadata {
  const metadata = asMetadata(article.metadata);
  const prior = metadata.collection ?? {};
  const status = deriveCollectionStatus(article);
  const length = textLengthFor(article);
  const strategy = prior.strategy ?? "fetch";
  const robotsDisallowed = hasRobotsDisallow(metadata);
  const sourceTextAvailable = sourceTextAvailableFor(prior, length);
  const sourceUrlVerified = prior.sourceUrlVerified !== false && !robotsDisallowed;
  const publishable =
    status === "cleaned" &&
    sourceTextAvailable &&
    constitutionalRelevant &&
    strategy !== "seed" &&
    !robotsDisallowed &&
    prior.publishable !== false &&
    sourceUrlVerified;

  return {
    strategy,
    confidence: prior.confidence ?? (publishable ? "high" : "low"),
    diagnosticsId: diagnosticsId ?? prior.diagnosticsId,
    sourceUrlVerified,
    publishable,
    sourceTextAvailable,
    strictSourceTextAvailable: hasStrictSourceTextPolicy(prior) || undefined,
    sourceTextPolicy: hasStrictSourceTextPolicy(prior) ? "strict" : undefined,
    robotsDisallowed: robotsDisallowed || undefined,
    reason: publishable ? prior.reason : prior.reason ?? defaultReason(status, strategy),
    source: prior.source,
  };
}

export function canSummarizeArticle(row: {
  status?: string | null;
  cleaned_text?: string | null;
  source_metadata?: unknown;
}) {
  const metadata = asMetadata(row.source_metadata);
  const collection = metadata.collection;
  const retryableStatus = row.status === "cleaned" || row.status === "failed_summary";
  return (
    retryableStatus &&
    typeof row.cleaned_text === "string" &&
    row.cleaned_text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH &&
    collection?.publishable === true &&
    collection.strategy !== "seed" &&
    collection.sourceTextAvailable === true &&
    collection.robotsDisallowed !== true
  );
}

export function isPublishableListItem(row: { status?: string | null; source_metadata?: unknown }) {
  const metadata = asMetadata(row.source_metadata);
  return row.status === "summarized" && metadata.collection?.publishable === true;
}
