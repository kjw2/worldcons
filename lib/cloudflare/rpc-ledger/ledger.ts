import type {
  RpcDomain,
  RpcLedger,
  RpcLedgerDefinitionEntry,
  RpcLedgerIndirection,
  RpcMigrationPrimitive,
  RpcRisk,
  RpcTargetDatabase,
  RpcTransactionSemantics,
} from "./types";
import { DEFAULT_SCAN_ROOTS } from "./scan";

/**
 * M4.6 RPC ledger data.
 *
 * One row per Postgres function reachable from app/lib/workers source. The
 * scanner (`scan.ts`) proves the call-site set is complete and reproducible;
 * this table proves every function has a target service operation, target
 * database, transaction semantics and migration primitive. `status` is derived:
 * a row with existing parity tests is `mapped`, otherwise `pending-parity` with
 * an explicit required M5 parity test.
 *
 * Target databases use the exact migration names from the plan (section 5):
 *   worldcons_core   - public/legal metadata + publication/lifecycle + raw metadata
 *   worldcons_ingest - ingestion/backfill/inventory/permit/artifact ledgers
 *   worldcons_ops    - admin commands/jobs/audit/governance/retention/heartbeats/rate-limit
 *   worldcons_search - disposable FTS5 search projection
 *   vectorize        - non-D1 semantic/vector index (plan section 6.1)
 */
const BACKFILL_GATE1 = "tests/constitutional-case-backfill-gate1.test.ts";
const BACKFILL_US_GATE5 = "tests/constitutional-case-backfill-us-gate5.test.ts";
const PUBLICATION_P3 = "tests/article-publication-p3.test.ts";
const LIFECYCLE_P2 = "tests/article-lifecycle-p2.test.ts";
const GOVERNANCE_P5 = "tests/admin-governance-p5.test.ts";
const COMMAND_CONTROL_PLANE = "tests/admin-command-control-plane.test.ts";
const SEARCH_REPOSITORY = "tests/search-repository.test.ts";
const SEARCH_GATE3 = "tests/constitutional-case-search-gate3.test.ts";
const SEARCH_GATE4 = "tests/constitutional-case-search-gate4.test.ts";
const REFERENCE_READS = "tests/reference-reads-repository.test.ts";
const ARTIFACT_WRITE = "tests/backfill-artifact-blob-write.test.ts";
const ARTIFACT_EXTERNALIZE = "tests/backfill-artifact-blob-externalize.test.ts";
const ARTIFACT_INLINE_CLEAR = "tests/backfill-artifact-blob-inline-clear.test.ts";
const ARTIFACT_RESTORE = "tests/backfill-artifact-blob-restore.test.ts";
const ARTIFACT_READINESS = "tests/backfill-artifact-blob-readiness.test.ts";
const ARTICLE_RAW_OPERATOR_READ = "tests/article-raw-operator-read-authority.test.ts";
const ARTICLE_RAW_INLINE_CLEAR = "tests/article-raw-blob-inline-clear.test.ts";
const ARTICLE_RAW_EXTERNALIZE = "tests/article-raw-blob-externalize.test.ts";
const ARTICLE_RAW_RESTORE = "tests/article-raw-blob-restore.test.ts";
const ARTICLE_RAW_READINESS = "tests/article-raw-readiness.test.ts";
const CCLMETASEARCH = "tests/cclmetasearch-api.test.ts";
const ANALYTICS_PRIVACY = "tests/analytics-privacy.test.ts";
const SECURITY_HARDENING = "tests/security-platform-hardening.test.ts";
const ADMIN_OPS_READS = "tests/admin-ops-read-repository.test.ts";
const ADMIN_ANALYTICS_READS = "tests/admin-analytics-read-repository.test.ts";
const WORKFLOW_HEARTBEAT = "tests/workflow-heartbeat.test.ts";
const EMBEDDING_VECTOR = "tests/embedding-vector.test.ts";
const EMBEDDING_PROVIDER = "tests/embedding-provider.test.ts";

function requiredM5Parity(rpcName: string, method: string, database: RpcTargetDatabase): string {
  return "M5 D1 parity: focused test proving " + method + " reproduces " + rpcName + " on " + database;
}

type RpcLedgerRow = readonly [
  rpcName: string,
  domain: RpcDomain,
  targetDatabase: RpcTargetDatabase,
  transactionSemantics: RpcTransactionSemantics,
  migrationPrimitive: RpcMigrationPrimitive,
  risk: RpcRisk,
  targetServiceMethod: string,
  additionalServiceMethods: readonly string[],
  currentPurpose: string,
  existingParityTests: readonly string[],
  requiredM5Tests: readonly string[],
  notes: string,
];

const RPC_LEDGER_ROWS: readonly RpcLedgerRow[] = [
  ["cclmetasearch_search_v1", "search", "worldcons_search", "search-rank", "d1-search", "medium", "searchCclMetasearch", [], "Serve the CCL/ChatGPT metasearch page over the worldcons corpus (query, limit, offset, sort).", [CCLMETASEARCH], [], "FTS5/BM25 ranking in worldcons_search replaces the Postgres full-text rank; the search corpus stays the parity oracle."],
  ["article_raw_operator_candidates_v1", "article-raw", "worldcons_core", "read", "d1-read", "low", "ArticleRawInlineClearRepository.listArticleRawInlineClearCandidates", ["ArticleRawExternalizationRepository.listArticleRawExternalizationCandidates"], "List article-raw rows whose inline text is clearable or externalizable, for the operator CLIs.", [ARTICLE_RAW_OPERATOR_READ, ARTICLE_RAW_INLINE_CLEAR, ARTICLE_RAW_EXTERNALIZE], [], "Read-only candidate listing shared by the inline-clear and externalization repositories."],
  ["article_raw_inline_clear_v1", "article-raw", "worldcons_core", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "ArticleRawInlineClearRepository.clearArticleRawInline", [], "Clear the inline article raw text after the R2 copy has been verified (idempotent re-run).", [ARTICLE_RAW_INLINE_CLEAR], [], "R2 clear gate (PUT, GET, size, SHA-256, decode) must pass before the inline column is cleared."],
  ["article_raw_externalize_v1", "article-raw", "worldcons_core", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "ArticleRawExternalizationRepository.attachArticleRawExternalization", [], "Attach the R2 object key/hash metadata for an externalized article raw body.", [ARTICLE_RAW_EXTERNALIZE], [], "R2 coordination; dual-copy rows are preserved until the clear gate passes."],
  ["article_raw_restore_candidates_v1", "article-raw", "worldcons_core", "read", "d1-read", "low", "ArticleRawRestoreRepository.listArticleRawRestoreCandidates", [], "List article-raw rows eligible for inline restore.", [ARTICLE_RAW_RESTORE], [], "Read-only candidate listing."],
  ["article_raw_restore_inline_v1", "article-raw", "worldcons_core", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "ArticleRawRestoreRepository.restoreArticleRawInline", [], "Restore inline article raw text from the verified R2 body (idempotent).", [ARTICLE_RAW_RESTORE], [], "Reads R2 then writes the inline column."],
  ["article_raw_readiness_v1", "article-raw", "worldcons_core", "read-aggregate", "d1-read", "low", "ArticleRawReadinessAggregateRepository.readArticleRawReadiness", [], "Aggregate raw-version readiness (inline vs externalized coverage).", [ARTICLE_RAW_READINESS], [], "Read-only rollout evidence."],
  ["article_publication_transition_p3", "article-publication", "worldcons_core", "mutate-transactional", "d1-transaction", "high", "ArticlePublicationRepository.transition", [], "Transactional article publication transition (legacy inline capture).", [PUBLICATION_P3], [], "Single D1 batch transaction must preserve version-head/publication coupling."],
  ["article_publication_transition_p3_blob", "article-publication", "worldcons_core", "mutate-transactional", "d1-transaction", "high", "ArticlePublicationRepository.transition", [], "Transactional article publication transition (R2 blob capture).", [PUBLICATION_P3], [], "Same transaction as the p3 legacy path; blob body addressed by R2 key/hash."],
  ["article_publication_snapshot_p3", "article-publication", "worldcons_core", "read", "d1-read", "low", "ArticlePublicationRepository.getSnapshot", [], "Read the publication snapshot (heads and projection state).", [PUBLICATION_P3], [], "Read-only."],
  ["article_cache_outbox_claim_p3", "article-publication", "worldcons_core", "outbox-claim", "d1-conditional-update", "high", "ArticleCacheOutboxRepository.claim", [], "Atomically claim pending cache-invalidation outbox rows.", [PUBLICATION_P3], [], "Lease-style conditional UPDATE; returned state uses D1 batch."],
  ["article_cache_outbox_deliver_p3", "article-publication", "worldcons_core", "outbox-settle", "d1-transaction+queue", "high", "ArticleCacheOutboxRepository.deliver", [], "Settle a delivered outbox row and hand cache revalidation to the Queue.", [PUBLICATION_P3], [], "Compound: D1 settle plus Queue delivery/ack (plan 5.4 outbox pipeline)."],
  ["article_cache_outbox_fail_p3", "article-publication", "worldcons_core", "outbox-settle", "d1-transaction", "medium", "ArticleCacheOutboxRepository.fail", [], "Record a failed outbox delivery for retry or DLQ.", [PUBLICATION_P3], [], "D1-only settle path."],
  ["article_lifecycle_transition_p2", "article-lifecycle", "worldcons_core", "mutate-transactional", "d1-transaction", "high", "ArticleLifecycleRepository.transition", [], "Transactional article lifecycle transition (P2).", [LIFECYCLE_P2], [], "Lifecycle state must be transactionally coupled to the article row."],
  ["us_conan_candidate_review_v2", "case-backfill", "worldcons_core", "mutate-transactional", "d1-transaction", "high", "UsConanReviewRepository.appendReview", [], "Append a US constitutional-case candidate review decision.", [BACKFILL_US_GATE5], [], "Review append is auditable and transactional with candidate state."],
  ["us_conan_candidate_snapshot_open_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "UsConanCandidateRepository.openSnapshot", [], "Open a US candidate inventory snapshot.", [BACKFILL_US_GATE5], [], "High-write ingest snapshot state."],
  ["us_conan_candidate_upsert_v1", "case-backfill", "worldcons_ingest", "mutate-idempotent", "d1-transaction", "high", "UsConanCandidateRepository.upsertCandidate", [], "Idempotent upsert of a US candidate row.", [BACKFILL_US_GATE5], [], "Idempotent on the stable candidate key."],
  ["us_conan_candidate_snapshot_close_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "UsConanCandidateRepository.closeSnapshot", [], "Close a US candidate inventory snapshot with final counts.", [BACKFILL_US_GATE5], [], "High-write ingest snapshot state."],
  ["us_conan_candidate_publish_catalog_v1", "case-backfill", "worldcons_core", "projection-publish", "d1-projection-publish", "high", "UsConanCatalogRepository.publish", [], "Publish US candidates into the public case catalog projection.", [BACKFILL_US_GATE5], [], "Cross-domain publish: owning commit + outbox + Queue to worldcons_search."],
  ["us_conan_candidate_catalog_canary_v1", "case-backfill", "worldcons_core", "read", "d1-read", "medium", "UsConanCatalogCanaryRepository.getEvidence", [], "Read the US catalog canary evidence summary.", [], [requiredM5Parity("us_conan_candidate_catalog_canary_v1", "UsConanCatalogCanaryRepository.getEvidence", "worldcons_core")], "Read-only canary; no focused parity test yet."],
  ["us_conan_candidate_authority_record_v1", "case-backfill", "worldcons_core", "audit-append", "d1-audit-append", "low", "UsConanAuthorityRepository.recordAuthority", [], "Record the resolved US candidate authority decision.", [BACKFILL_US_GATE5], [], "Audit append in the owner (core) transaction."],
  ["case_backfill_bverfg_shadow_canary_v1", "case-backfill", "worldcons_ingest", "read", "d1-read", "medium", "BverfgShadowCanaryRepository.getEvidence", [], "Read the BVerfG shadow-read canary evidence.", [], [requiredM5Parity("case_backfill_bverfg_shadow_canary_v1", "BverfgShadowCanaryRepository.getEvidence", "worldcons_ingest")], "Read-only canary; no focused parity test yet."],
  ["purge_site_events", "analytics", "worldcons_ops", "retention-purge", "d1-transaction", "high", "runSiteAnalyticsRetention", [], "Delete site_events older than the configured retention window.", [ANALYTICS_PRIVACY], [], "Destructive batch delete; retention window is bounded (30-365 days)."],
  ["source_inventory_snapshot_supersede_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "supersedeCaseBackfillSnapshot", [], "Supersede an open source-inventory snapshot.", [BACKFILL_GATE1], [], "High-write ingest snapshot state."],
  ["source_inventory_snapshot_open_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.openSnapshot", [], "Open a source-inventory snapshot for a case backfill.", [BACKFILL_GATE1], [], "High-write ingest snapshot state."],
  ["source_inventory_item_upsert_v3", "case-backfill", "worldcons_ingest", "mutate-idempotent", "d1-transaction", "high", "CaseBackfillRepository.upsertInventoryItem", [], "Idempotent upsert of a source-inventory item.", [BACKFILL_GATE1], [], "Idempotent on the stable inventory item key."],
  ["source_inventory_enumeration_artifact_record_v1", "case-backfill", "worldcons_ingest", "audit-append", "d1-audit-append", "low", "CaseBackfillRepository.recordEnumerationArtifact", [], "Record the enumeration artifact for an inventory snapshot.", [BACKFILL_GATE1], [], "Audit append in the ingest transaction."],
  ["source_inventory_snapshot_evidence_v2", "case-backfill", "worldcons_ingest", "mutate-idempotent", "d1-transaction", "high", "CaseBackfillRepository.updateSnapshotEvidence", [], "Update a snapshot's evidence counts.", [BACKFILL_GATE1], [], "Idempotent aggregate update."],
  ["source_inventory_snapshot_close_v3", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.closeSnapshot", [], "Close a source-inventory snapshot.", [BACKFILL_GATE1], [], "High-write ingest snapshot state."],
  ["source_backfill_request_permit_acquire_v1", "case-backfill", "worldcons_ingest", "claim-permit", "d1-conditional-update", "high", "CaseBackfillRepository.acquireSourceRequestPermit", [], "Acquire a source-request permit (rate governor).", [BACKFILL_GATE1], [], "Atomic conditional claim under the request governor."],
  ["source_backfill_request_permit_release_v1", "case-backfill", "worldcons_ingest", "claim-permit", "d1-conditional-update", "high", "CaseBackfillRepository.releaseSourceRequestPermit", [], "Release a source-request permit.", [BACKFILL_GATE1], [], "Atomic conditional release."],
  ["source_backfill_snapshot_status_v1", "case-backfill", "worldcons_ingest", "read-aggregate", "d1-read", "low", "CaseBackfillRepository.getSnapshotStatus", [], "Read aggregate backfill snapshot status.", [BACKFILL_GATE1], [], "Read-only."],
  ["source_backfill_run_begin_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.beginRun", [], "Begin a source-backfill run.", [BACKFILL_GATE1], [], "High-write ingest run state."],
  ["source_backfill_pass_allocate_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.allocatePass", [], "Allocate a backfill pass.", [BACKFILL_GATE1], [], "High-write ingest run state."],
  ["source_backfill_run_finish_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.finishRun", [], "Finish a source-backfill run.", [BACKFILL_GATE1], [], "High-write ingest run state."],
  ["source_backfill_phase_backlog_count_v1", "case-backfill", "worldcons_ingest", "read-aggregate", "d1-read", "low", "CaseBackfillRepository.countBacklog", [], "Count the remaining backfill backlog for a phase.", [BACKFILL_GATE1], [], "Read-only."],
  ["source_backfill_items_claim_v2", "case-backfill", "worldcons_ingest", "claim-lease", "d1-conditional-update", "high", "CaseBackfillRepository.claimItems", [], "Atomically lease a batch of backfill items.", [BACKFILL_GATE1], [], "Conditional UPDATE returning leased item state."],
  ["source_backfill_items_extend_v1", "case-backfill", "worldcons_ingest", "claim-lease", "d1-conditional-update", "high", "CaseBackfillRepository.extendItems", [], "Extend the lease on claimed backfill items.", [BACKFILL_GATE1], [], "Atomic conditional lease extension."],
  ["source_backfill_fetch_artifact_record_v2", "case-backfill", "worldcons_ingest", "audit-append", "r2-coordination+d1-transaction", "high", "CaseBackfillRepository.recordFetchArtifact", [], "Record a blob-backed fetch artifact (R2) in the artifact ledger.", [ARTIFACT_WRITE], [], "R2 object metadata and the ledger row must be committed together."],
  ["source_backfill_fetch_artifact_record_v1", "case-backfill", "worldcons_ingest", "audit-append", "d1-audit-append", "low", "CaseBackfillRepository.recordFetchArtifact", [], "Record an inline fetch artifact in the artifact ledger.", [ARTIFACT_WRITE], [], "Inline capture path; same artifact ledger as v2."],
  ["source_backfill_normalization_artifact_record_v2", "case-backfill", "worldcons_ingest", "audit-append", "r2-coordination+d1-transaction", "high", "CaseBackfillRepository.recordNormalizationArtifact", [], "Record a blob-backed normalization artifact (R2).", [ARTIFACT_WRITE], [], "R2 object metadata and the ledger row must be committed together."],
  ["source_backfill_normalization_artifact_record_v1", "case-backfill", "worldcons_ingest", "audit-append", "d1-audit-append", "low", "CaseBackfillRepository.recordNormalizationArtifact", [], "Record an inline normalization artifact.", [ARTIFACT_WRITE], [], "Inline capture path; same artifact ledger as v2."],
  ["case_catalog_publish_backfill_item_v1", "case-backfill", "worldcons_core", "projection-publish", "d1-projection-publish", "high", "CaseBackfillRepository.publishItem", [], "Publish a backfilled case item into the public catalog projection.", [BACKFILL_GATE1], [], "Cross-domain publish to worldcons_search via outbox + Queue."],
  ["source_backfill_item_complete_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.completeItem", [], "Mark a backfill item complete.", [BACKFILL_GATE1], [], "High-write ingest item state."],
  ["source_backfill_item_fail_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.failItem", [], "Mark a backfill item failed.", [BACKFILL_GATE1], [], "High-write ingest item state."],
  ["source_backfill_item_exclude_v1", "case-backfill", "worldcons_ingest", "mutate-transactional", "d1-transaction", "high", "CaseBackfillRepository.excludeItem", [], "Mark a backfill item excluded.", [BACKFILL_GATE1], [], "High-write ingest item state."],
  ["source_backfill_artifact_externalize_v1", "case-backfill", "worldcons_ingest", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "CaseBackfillRepository.attachArtifactExternalization", [], "Attach R2 externalization metadata to a backfill artifact.", [ARTIFACT_EXTERNALIZE], [], "The R2 clear gate applies before any inline clear."],
  ["source_backfill_artifact_inline_clear_v1", "case-backfill", "worldcons_ingest", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "CaseBackfillRepository.clearArtifactInline", [], "Clear the inline backfill artifact body after R2 verification.", [ARTIFACT_INLINE_CLEAR], [], "R2 clear gate (PUT, GET, size, SHA-256, decode) must pass first."],
  ["source_backfill_artifact_inline_restore_v1", "case-backfill", "worldcons_ingest", "mutate-idempotent", "r2-coordination+d1-transaction", "high", "CaseBackfillRepository.restoreArtifactInline", [], "Restore the inline backfill artifact body from R2.", [ARTIFACT_RESTORE], [], "Reads R2 then writes the inline column."],
  ["source_backfill_artifact_readiness_rows_v1", "case-backfill", "worldcons_ingest", "read", "d1-read", "low", "CaseBackfillRepository.listArtifactReadinessRows", [], "List artifact readiness rows for the rollout gate.", [ARTIFACT_READINESS], [], "Read-only."],
  ["worldcons_consume_rate_limit_v1", "security", "worldcons_ops", "mutate-idempotent", "d1-conditional-update", "medium", "consumeRateLimit", [], "Consume a distributed rate-limit token for a profile/identifier window.", [SECURITY_HARDENING], [], "Cloudflare Durable Object is the preferred hot-path backend; worldcons_ops holds the relational fallback counter."],
  ["admin_operational_health_p5", "admin-governance", "worldcons_ops", "read-aggregate", "d1-read", "low", "getP5HealthEvidence", [], "Read the P5 operational health evidence snapshot.", [GOVERNANCE_P5], [], "Privileged admin authority."],
  ["admin_record_owner_approval_p5_v2", "admin-governance", "worldcons_ops", "audit-append", "d1-audit-append", "low", "recordP5OwnerApproval", [], "Record a P5 owner approval.", [GOVERNANCE_P5], [], "Audit append."],
  ["admin_apply_retention_p5", "admin-governance", "worldcons_ops", "retention-purge", "d1-transaction", "high", "applyP5Retention", [], "Apply the P5 retention policy (destructive purge).", [GOVERNANCE_P5], [], "Destructive; must be transactional and auditable."],
  ["admin_record_compatibility_observation_p5", "admin-governance", "worldcons_ops", "audit-append", "d1-audit-append", "low", "recordCompatibilityObservation", [], "Record a new-vs-fallback compatibility observation.", [GOVERNANCE_P5], [], "Coalesced per-key observation (60s window)."],
  ["worldcons_ranked_search_page_v1", "search", "worldcons_search", "search-rank", "d1-search", "medium", "SearchRepository.rankedSearchPageRpc", [], "Serve the ranked public search page (FTS plus semantic fusion).", [SEARCH_REPOSITORY, SEARCH_GATE4], [], "Search corpus is the parity oracle (plan 6.4/11.3)."],
  ["worldcons_case_search_page_v2", "search", "worldcons_search", "search-rank", "d1-search", "medium", "SearchRepository.catalogCaseSearchRpc", [], "Serve the cursor-paged case-catalog search.", [SEARCH_REPOSITORY, SEARCH_GATE3], [], "Cursor error evidence semantics must be preserved."],
  ["public_fulltext_ranked_ids_v1", "search", "worldcons_search", "search-rank", "d1-search", "medium", "SearchRepository.fullTextRankedIdsRpc", [], "Return FTS-ranked article ids for the vector/fallback path.", [SEARCH_REPOSITORY], [], "FTS5 BM25 replaces the Postgres rank."],
  ["match_public_article_versions_p3", "search", "vectorize", "search-rank", "vectorize", "high", "SearchRepository.vectorMatchRpc", [], "Semantic vector match over the projection-authority article versions.", [SEARCH_REPOSITORY], [], "Non-D1 target: embeddings live in Vectorize (plan 6.1); ids are re-materialized from D1."],
  ["match_articles", "search", "vectorize", "search-rank", "vectorize", "high", "SearchRepository.vectorMatchRpc", [], "Legacy semantic vector match over article embeddings.", [SEARCH_REPOSITORY], [], "Legacy authority selector; same Vectorize target as the projection match."],
  ["rpc_admin_dashboard_snapshot", "admin-observability", "worldcons_ops", "read-aggregate", "d1-read", "low", "AdminOpsReadRepository.loadDashboardSnapshot", [], "Read the pre-aggregated admin dashboard snapshot.", [ADMIN_OPS_READS], [], "Privileged; legacy fallback retained until parity."],
  ["public_jurisdiction_article_counts", "public-reference", "worldcons_core", "read-aggregate", "d1-read", "low", "ReferenceReadRepository.listJurisdictionArticleCounts", [], "Per-jurisdiction public article counts (legacy authority).", [REFERENCE_READS], [], "Legacy relation selector."],
  ["public_jurisdiction_article_counts_p3", "public-reference", "worldcons_core", "read-aggregate", "d1-read", "low", "ReferenceReadRepository.listJurisdictionArticleCounts", [], "Per-jurisdiction public article counts (projection authority).", [REFERENCE_READS], [], "Projection relation selector."],
  ["admin_submit_command_v3", "admin-commands", "worldcons_ops", "mutate-transactional", "d1-transaction", "high", "AdminCommandRepository.submit", [], "Submit an admin command run.", [COMMAND_CONTROL_PLANE], [], "Command control-plane transaction."],
  ["admin_claim_command_attempt_p1", "admin-commands", "worldcons_ops", "claim-lease", "d1-conditional-update", "high", "AdminCommandRepository.claim", [], "Claim a command attempt (cohort branch).", [COMMAND_CONTROL_PLANE], [], "Cohort-selected variant of the v3 claim."],
  ["admin_claim_command_attempt_v3", "admin-commands", "worldcons_ops", "claim-lease", "d1-conditional-update", "high", "AdminCommandRepository.claim", [], "Claim a pending admin command attempt.", [COMMAND_CONTROL_PLANE], [], "Atomic conditional claim."],
  ["admin_heartbeat_command_attempt_v3", "admin-commands", "worldcons_ops", "claim-lease", "d1-conditional-update", "high", "AdminCommandRepository.heartbeat", [], "Heartbeat an in-flight command attempt lease.", [COMMAND_CONTROL_PLANE], [], "Atomic conditional lease heartbeat."],
  ["admin_complete_command_attempt_v3", "admin-commands", "worldcons_ops", "mutate-transactional", "d1-transaction", "high", "AdminCommandRepository.complete", [], "Complete a command attempt successfully.", [COMMAND_CONTROL_PLANE], [], "Command control-plane transaction."],
  ["admin_fail_command_attempt_v3", "admin-commands", "worldcons_ops", "mutate-transactional", "d1-transaction", "high", "AdminCommandRepository.fail", [], "Mark a command attempt failed.", [COMMAND_CONTROL_PLANE], [], "Command control-plane transaction."],
  ["admin_abort_command_run_v3", "admin-commands", "worldcons_ops", "mutate-transactional", "d1-transaction", "high", "AdminCommandRepository.abort", [], "Abort a command run.", [COMMAND_CONTROL_PLANE], [], "Command control-plane transaction."],
  ["admin_retry_command_run_v3", "admin-commands", "worldcons_ops", "mutate-transactional", "d1-transaction", "high", "AdminCommandRepository.retry", [], "Retry a command run.", [COMMAND_CONTROL_PLANE], [], "Command control-plane transaction."],
  ["admin_begin_source_url_candidate_retry_p1", "admin-jobs", "worldcons_ingest", "claim-lease", "d1-conditional-update", "high", "beginSourceUrlCandidateRetry", [], "Begin a retry lease for a source URL candidate.", [], [requiredM5Parity("admin_begin_source_url_candidate_retry_p1", "beginSourceUrlCandidateRetry", "worldcons_ingest")], "Lease atomicity must be preserved."],
  ["admin_finish_source_url_candidate_retry_p1", "admin-jobs", "worldcons_ingest", "mutate-idempotent", "d1-transaction", "medium", "finishSourceUrlCandidateRetry", [], "Finish a source URL candidate retry and record the outcome.", [], [requiredM5Parity("admin_finish_source_url_candidate_retry_p1", "finishSourceUrlCandidateRetry", "worldcons_ingest")], "Idempotent retry completion."],
  ["claim_admin_job", "admin-jobs", "worldcons_ops", "claim-lease", "d1-conditional-update", "high", "claimAdminJob", [], "Atomically claim a pending admin job.", [], [requiredM5Parity("claim_admin_job", "claimAdminJob", "worldcons_ops")], "Lease atomicity must be preserved."],
  ["append_admin_job_event", "admin-jobs", "worldcons_ops", "audit-append", "d1-audit-append", "low", "appendAdminJobEvent", [], "Append an admin job event.", [], [requiredM5Parity("append_admin_job_event", "appendAdminJobEvent", "worldcons_ops")], "Audit append."],
  ["rpc_admin_analytics_health_snapshot", "admin-observability", "worldcons_ops", "read-aggregate", "d1-read", "low", "AdminAnalyticsReadRepository.loadAnalyticsHealthSnapshot", [], "Read the pre-aggregated admin analytics health snapshot.", [ADMIN_ANALYTICS_READS], [], "Privileged; legacy fallback retained until parity."],
  ["ops_workflow_heartbeat_v1", "workflow", "worldcons_ops", "mutate-idempotent", "d1-transaction+workflow", "medium", "recordWorkflowHeartbeat", [], "Record a workflow heartbeat (running/success/failed/deferred).", [WORKFLOW_HEARTBEAT], [], "Driven by Cloudflare Workflows; idempotent upsert keyed by workflow key."],
  ["article_embedding_write_v1", "embeddings", "worldcons_core", "mutate-idempotent", "d1-transaction+vectorize", "high", "persistArticleEmbedding", [], "Provenance-locked write of a Gemini embedding to the article and its published P3 artifact.", [EMBEDDING_VECTOR], [], "Compound: D1 provenance transaction plus Vectorize upsert (plan 6.1)."],
  ["article_embedding_readiness_v1", "embeddings", "worldcons_core", "read-aggregate", "d1-read", "low", "getEmbeddingReadiness", [], "Aggregate embedding readiness (missing articles and published artifacts).", [EMBEDDING_PROVIDER], [], "Read-only."],
  ["refresh_tag_counts", "tag-maintenance", "worldcons_core", "mutate-transactional", "d1-transaction", "medium", "runRefreshTagCounts", [], "Recompute denormalized tag article counts.", [], [requiredM5Parity("refresh_tag_counts", "runRefreshTagCounts", "worldcons_core")], "Two call sites (lib/ingest/summary.ts, lib/ingest/run.ts) share the canonical service method."],
];

function toDefinitionEntry(row: RpcLedgerRow): RpcLedgerDefinitionEntry {
  const [
    rpcName,
    domain,
    targetDatabase,
    transactionSemantics,
    migrationPrimitive,
    risk,
    targetServiceMethod,
    additionalServiceMethods,
    currentPurpose,
    existingParityTests,
    requiredM5Tests,
    notes,
  ] = row;
  return {
    rpcName,
    domain,
    currentPurpose,
    targetServiceMethod,
    additionalServiceMethods: [...additionalServiceMethods],
    targetDatabase,
    transactionSemantics,
    migrationPrimitive,
    parityEvidence: {
      existing: [...existingParityTests],
      requiredM5: [...requiredM5Tests],
    },
    status: existingParityTests.length > 0 ? "mapped" : "pending-parity",
    risk,
    notes,
  };
}

/**
 * Curated ledger rows. `status` is derived: a row with existing focused parity
 * tests is `mapped`; otherwise it is `pending-parity` and carries an explicit
 * required M5 parity test in `parityEvidence.requiredM5`.
 */
export const rpcLedgerFunctions: RpcLedgerDefinitionEntry[] = RPC_LEDGER_ROWS.map(toDefinitionEntry);

/**
 * Non-literal call sites. Every `.rpc(arg, ...)` whose `arg` is not a string
 * literal must appear here with its resolver and a finite catalog (`bounded:
 * true`). A `bounded: false` family is an acknowledged unbounded dynamic RPC;
 * the validator reports it.
 */
export const rpcLedgerIndirections: RpcLedgerIndirection[] = [
  {
    id: "command-control-plane-local-rpc-wrapper",
    file: "lib/admin/command-control-plane/repository.ts",
    argText: "name",
    kind: "parameter",
    resolver: "module-local helper rpc(name, args): catalog = the literal first argument at each of its 6 in-file call sites",
    bounded: true,
    resolvedFunctions: [
      "admin_abort_command_run_v3",
      "admin_complete_command_attempt_v3",
      "admin_fail_command_attempt_v3",
      "admin_heartbeat_command_attempt_v3",
      "admin_retry_command_run_v3",
      "admin_submit_command_v3",
    ],
  },
  {
    id: "command-control-plane-claim-variant",
    file: "lib/admin/command-control-plane/repository.ts",
    argText: "rpcName",
    kind: "constant",
    resolver: "const rpcName = input.cohorts?.length ? admin_claim_command_attempt_p1 : admin_claim_command_attempt_v3",
    bounded: true,
    resolvedFunctions: ["admin_claim_command_attempt_p1", "admin_claim_command_attempt_v3"],
  },
  {
    id: "article-raw-externalization-operator-read",
    file: "lib/article-raw/externalization-repository.ts",
    argText: "ARTICLE_RAW_OPERATOR_READ_RPC",
    kind: "constant",
    resolver: "same-file const ARTICLE_RAW_OPERATOR_READ_RPC = article_raw_operator_candidates_v1",
    bounded: true,
    resolvedFunctions: ["article_raw_operator_candidates_v1"],
  },
  {
    id: "article-raw-inline-clear-operator-read",
    file: "lib/article-raw/inline-clear-repository.ts",
    argText: "ARTICLE_RAW_OPERATOR_READ_RPC",
    kind: "constant",
    resolver: "same-file const ARTICLE_RAW_OPERATOR_READ_RPC = article_raw_operator_candidates_v1",
    bounded: true,
    resolvedFunctions: ["article_raw_operator_candidates_v1"],
  },
  {
    id: "article-raw-readiness",
    file: "lib/article-raw/readiness-repository.ts",
    argText: "ARTICLE_RAW_READINESS_RPC",
    kind: "constant",
    resolver: "exported const ARTICLE_RAW_READINESS_RPC = article_raw_readiness_v1",
    bounded: true,
    resolvedFunctions: ["article_raw_readiness_v1"],
  },
  {
    id: "article-raw-restore-candidates",
    file: "lib/article-raw/restore-repository.ts",
    argText: "ARTICLE_RAW_RESTORE_LIST_RPC",
    kind: "constant",
    resolver: "same-file const ARTICLE_RAW_RESTORE_LIST_RPC = article_raw_restore_candidates_v1",
    bounded: true,
    resolvedFunctions: ["article_raw_restore_candidates_v1"],
  },
  {
    id: "article-raw-restore-inline",
    file: "lib/article-raw/restore-repository.ts",
    argText: "ARTICLE_RAW_RESTORE_RPC",
    kind: "constant",
    resolver: "same-file const ARTICLE_RAW_RESTORE_RPC = article_raw_restore_inline_v1",
    bounded: true,
    resolvedFunctions: ["article_raw_restore_inline_v1"],
  },
  {
    id: "reference-reads-jurisdiction-count-projection",
    file: "lib/reference-reads/supabase-repository.ts",
    argText: "countRpc",
    kind: "constant",
    resolver: "const countRpc = projectionEnabled() ? public_jurisdiction_article_counts_p3 : public_jurisdiction_article_counts",
    bounded: true,
    resolvedFunctions: ["public_jurisdiction_article_counts", "public_jurisdiction_article_counts_p3"],
  },
  {
    id: "search-ranked-page",
    file: "lib/search/repository/supabase-repository.ts",
    argText: "RANKED_SEARCH_PAGE_RPC",
    kind: "constant",
    resolver: "same-file const RANKED_SEARCH_PAGE_RPC = worldcons_ranked_search_page_v1",
    bounded: true,
    resolvedFunctions: ["worldcons_ranked_search_page_v1"],
  },
  {
    id: "search-catalog-case-page",
    file: "lib/search/repository/supabase-repository.ts",
    argText: "CATALOG_CASE_SEARCH_RPC",
    kind: "constant",
    resolver: "same-file const CATALOG_CASE_SEARCH_RPC = worldcons_case_search_page_v2",
    bounded: true,
    resolvedFunctions: ["worldcons_case_search_page_v2"],
  },
  {
    id: "search-fulltext-ranked-ids",
    file: "lib/search/repository/supabase-repository.ts",
    argText: "FULLTEXT_RANKED_IDS_RPC",
    kind: "constant",
    resolver: "same-file const FULLTEXT_RANKED_IDS_RPC = public_fulltext_ranked_ids_v1",
    bounded: true,
    resolvedFunctions: ["public_fulltext_ranked_ids_v1"],
  },
  {
    id: "search-vector-match-authority",
    file: "lib/search/repository/supabase-repository.ts",
    argText: "publicVectorMatchRpc(false, environment)",
    kind: "function-call",
    resolver: "imported publicVectorMatchRpc() from @/lib/article-publication -> public-read-authority.ts; ternary on the projection flag, resolved through the barrel re-export",
    bounded: true,
    resolvedFunctions: ["match_articles", "match_public_article_versions_p3"],
  },
];

/** The complete M4.6 RPC ledger (classification rows + dynamic indirections). */
export const rpcLedger: RpcLedger = {
  version: 1,
  scope: [...DEFAULT_SCAN_ROOTS],
  functions: rpcLedgerFunctions,
  indirections: rpcLedgerIndirections,
};