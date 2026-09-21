# WorldCons Cloudflare M4.6 — RPC Ledger

Date: 2026-09-21

Baseline: clean HEAD `01a40a5` (feat: complete cloudflare m4.5 admin analytics read
abstraction). No Orca, no deploy, no DNS change, no D1 creation, no production-data
change, no authority change. Supabase remains production authority.

## 1. Objective and scope

M4's objective is "map every RPC to a service operation". M4.6 is the ledger that
proves the mapping is complete, reproducible and machine-readable. It covers every
Supabase/Postgres RPC call reachable in application source under `app/`, `lib/` and
`workers/` (tests excluded). Operator CLIs under `scripts/` are outside the runtime
ledger scope and are reported separately (section 6) rather than silently ignored.

## 2. Method (reproducible scanner)

`lib/cloudflare/rpc-ledger/scan.ts` parses every in-scope `.ts`/`.tsx` file with the
TypeScript compiler API and records every `X.rpc(...)` call. The first argument (the
function name) is resolved statically:

- string literal -> `literal`;
- same-file or imported `const` initialized from string literal(s), including
  ternary / `??` / `||` / `&&` unions -> `constant`;
- a module-local helper parameter -> `parameter` (finite catalog = the literal first
  arguments at that helper's in-file call sites);
- a resolver function call -> `function-call` (resolved through the module, its
  re-export barrel, and the function's `return` expressions);
- anything else -> `unresolved`.

No call site is skipped. An unresolved call site is recorded and the validator fails
unless the ledger classifies it (section 7).
## 3. Baseline result

| Measure | Value |
| --- | --- |
| `.rpc(` call sites in scope | 74 |
| Resolved function references | 82 |
| Unique Postgres functions | 80 |
| `literal` call sites | 62 |
| `constant` call sites | 10 |
| `parameter` call sites | 1 |
| `function-call` call sites | 1 |
| `unresolved` call sites | 0 |
| Non-literal indirections | 12 |
| Dynamic families (parameter / function-call) | 2 |
| Unbounded dynamic families | 0 |
| Coupling files | 30 |

The 74 call sites yield 82 references because four sites select between two
functions (one helper whose parameter takes six literal names, plus three two-way
selectors) and two functions are called from two sites each; the unique count is 80.

## 4. Ledger schema (machine-readable)

Each row is the migration-plan ledger shape (plan section 6.2) plus migration
metadata. Every field is present directly in the serialized machine output
(`pnpm rpc:ledger --json`, `artifacts/cloudflare-m4/rpc-ledger.json`):

| Field | Meaning |
| --- | --- |
| `rpcName` | exact Postgres function name passed to `.rpc(rpcName, ...)` |
| `domain` | typed owner domain (allowlist below) |
| `callSites` | concrete `{ file, line }` call sites derived from the live scanner (never empty) |
| `currentPurpose` | what the function does today |
| `targetServiceMethod` | one canonical target service method string |
| `additionalServiceMethods` | other service methods that also own the function (may be empty) |
| `targetDatabase` | typed target: exact D1 migration name, or a non-D1 target |
| `transactionSemantics` | typed D1 transaction semantics |
| `migrationPrimitive` | typed migration primitive or compound strategy |
| `parityEvidence` | `{ existing, requiredM5 }` parity tests |
| `status` | `mapped` or `pending-parity` |
| `risk` | `low` / `medium` / `high` |
| `notes` | free-form migration notes |

Typed allowlists (exported from `lib/cloudflare/rpc-ledger/types.ts`):

- `domain`: `public-reference`, `article-publication`, `article-lifecycle`,
  `article-raw`, `case-backfill`, `search`, `embeddings`, `admin-commands`,
  `admin-jobs`, `admin-governance`, `admin-observability`, `security`,
  `analytics`, `workflow`, `tag-maintenance`.
- `targetDatabase`: `worldcons_core`, `worldcons_ingest`, `worldcons_ops`,
  `worldcons_search` (exact migration names, plan section 5), plus the explicit
  non-D1 target `vectorize` (plan section 6.1: `extensions.vector(1536)` ->
  Vectorize; used by the two semantic vector-match RPCs).
- `migrationPrimitive`: `d1-read`, `d1-transaction`, `d1-conditional-update`,
  `d1-audit-append`, `d1-projection-publish`, `d1-search`, `queue`, `workflow`,
  `r2-coordination`, `vectorize`, `durable-object`, and the compound strategies
  `d1-transaction+queue`, `d1-transaction+vectorize`, `d1-transaction+workflow`,
  `r2-coordination+d1-transaction`.
- `transactionSemantics`: `read`, `read-aggregate`, `search-rank`,
  `mutate-transactional`, `mutate-idempotent`, `claim-lease`, `claim-permit`,
  `outbox-claim`, `outbox-settle`, `audit-append`, `retention-purge`,
  `projection-publish`.
- `status`: `mapped` (focused parity tests exist), `pending-parity`.
- `risk`: `low` / `medium` / `high`.

The ledger data lives in `lib/cloudflare/rpc-ledger/ledger.ts` (typed, canonical).
The scan-derived `callSites` are attached by `lib/cloudflare/rpc-ledger/index.ts`,
so they cannot drift from the source tree. `pnpm rpc:ledger --json` prints the
machine-readable report; `--write` writes it to
`artifacts/cloudflare-m4/rpc-ledger.json`.

## 5. Complete ledger

80 rows (one per Postgres function) with migration metadata. `domain`,
`targetServiceMethod`, `migrationPrimitive`, `risk` and `status` are curated in
`ledger.ts`; `callSites` are derived from the live scanner/report.

| Postgres function | Domain | Target DB | Semantics | Migration primitive | Target service operation | Parity evidence | Risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cclmetasearch_search_v1` | search | worldcons_search | search-rank | d1-search | searchCclMetasearch | `tests/cclmetasearch-api.test.ts` | medium | mapped |
| `article_raw_operator_candidates_v1` | article-raw | worldcons_core | read | d1-read | ArticleRawInlineClearRepository.listArticleRawInlineClearCandidates<br>ArticleRawExternalizationRepository.listArticleRawExternalizationCandidates | `tests/article-raw-operator-read-authority.test.ts`<br>`tests/article-raw-blob-inline-clear.test.ts`<br>`tests/article-raw-blob-externalize.test.ts` | low | mapped |
| `article_raw_inline_clear_v1` | article-raw | worldcons_core | mutate-idempotent | r2-coordination+d1-transaction | ArticleRawInlineClearRepository.clearArticleRawInline | `tests/article-raw-blob-inline-clear.test.ts` | high | mapped |
| `article_raw_externalize_v1` | article-raw | worldcons_core | mutate-idempotent | r2-coordination+d1-transaction | ArticleRawExternalizationRepository.attachArticleRawExternalization | `tests/article-raw-blob-externalize.test.ts` | high | mapped |
| `article_raw_restore_candidates_v1` | article-raw | worldcons_core | read | d1-read | ArticleRawRestoreRepository.listArticleRawRestoreCandidates | `tests/article-raw-blob-restore.test.ts` | low | mapped |
| `article_raw_restore_inline_v1` | article-raw | worldcons_core | mutate-idempotent | r2-coordination+d1-transaction | ArticleRawRestoreRepository.restoreArticleRawInline | `tests/article-raw-blob-restore.test.ts` | high | mapped |
| `article_raw_readiness_v1` | article-raw | worldcons_core | read-aggregate | d1-read | ArticleRawReadinessAggregateRepository.readArticleRawReadiness | `tests/article-raw-readiness.test.ts` | low | mapped |
| `article_publication_transition_p3` | article-publication | worldcons_core | mutate-transactional | d1-transaction | ArticlePublicationRepository.transition | `tests/article-publication-p3.test.ts` | high | mapped |
| `article_publication_transition_p3_blob` | article-publication | worldcons_core | mutate-transactional | d1-transaction | ArticlePublicationRepository.transition | `tests/article-publication-p3.test.ts` | high | mapped |
| `article_publication_snapshot_p3` | article-publication | worldcons_core | read | d1-read | ArticlePublicationRepository.getSnapshot | `tests/article-publication-p3.test.ts` | low | mapped |
| `article_cache_outbox_claim_p3` | article-publication | worldcons_core | outbox-claim | d1-conditional-update | ArticleCacheOutboxRepository.claim | `tests/article-publication-p3.test.ts` | high | mapped |
| `article_cache_outbox_deliver_p3` | article-publication | worldcons_core | outbox-settle | d1-transaction+queue | ArticleCacheOutboxRepository.deliver | `tests/article-publication-p3.test.ts` | high | mapped |
| `article_cache_outbox_fail_p3` | article-publication | worldcons_core | outbox-settle | d1-transaction | ArticleCacheOutboxRepository.fail | `tests/article-publication-p3.test.ts` | medium | mapped |
| `article_lifecycle_transition_p2` | article-lifecycle | worldcons_core | mutate-transactional | d1-transaction | ArticleLifecycleRepository.transition | `tests/article-lifecycle-p2.test.ts` | high | mapped |
| `us_conan_candidate_review_v2` | case-backfill | worldcons_core | mutate-transactional | d1-transaction | UsConanReviewRepository.appendReview | `tests/constitutional-case-backfill-us-gate5.test.ts` | high | mapped |
| `us_conan_candidate_snapshot_open_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | UsConanCandidateRepository.openSnapshot | `tests/constitutional-case-backfill-us-gate5.test.ts` | high | mapped |
| `us_conan_candidate_upsert_v1` | case-backfill | worldcons_ingest | mutate-idempotent | d1-transaction | UsConanCandidateRepository.upsertCandidate | `tests/constitutional-case-backfill-us-gate5.test.ts` | high | mapped |
| `us_conan_candidate_snapshot_close_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | UsConanCandidateRepository.closeSnapshot | `tests/constitutional-case-backfill-us-gate5.test.ts` | high | mapped |
| `us_conan_candidate_publish_catalog_v1` | case-backfill | worldcons_core | projection-publish | d1-projection-publish | UsConanCatalogRepository.publish | `tests/constitutional-case-backfill-us-gate5.test.ts` | high | mapped |
| `us_conan_candidate_catalog_canary_v1` | case-backfill | worldcons_core | read | d1-read | UsConanCatalogCanaryRepository.getEvidence | required M5: M5 D1 parity: focused test proving UsConanCatalogCanaryRepository.getEvidence reproduces us_conan_candidate_catalog_canary_v1 on worldcons_core | medium | pending-parity |
| `us_conan_candidate_authority_record_v1` | case-backfill | worldcons_core | audit-append | d1-audit-append | UsConanAuthorityRepository.recordAuthority | `tests/constitutional-case-backfill-us-gate5.test.ts` | low | mapped |
| `case_backfill_bverfg_shadow_canary_v1` | case-backfill | worldcons_ingest | read | d1-read | BverfgShadowCanaryRepository.getEvidence | required M5: M5 D1 parity: focused test proving BverfgShadowCanaryRepository.getEvidence reproduces case_backfill_bverfg_shadow_canary_v1 on worldcons_ingest | medium | pending-parity |
| `purge_site_events` | analytics | worldcons_ops | retention-purge | d1-transaction | runSiteAnalyticsRetention | `tests/analytics-privacy.test.ts` | high | mapped |
| `source_inventory_snapshot_supersede_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | supersedeCaseBackfillSnapshot | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_inventory_snapshot_open_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.openSnapshot | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_inventory_item_upsert_v3` | case-backfill | worldcons_ingest | mutate-idempotent | d1-transaction | CaseBackfillRepository.upsertInventoryItem | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_inventory_enumeration_artifact_record_v1` | case-backfill | worldcons_ingest | audit-append | d1-audit-append | CaseBackfillRepository.recordEnumerationArtifact | `tests/constitutional-case-backfill-gate1.test.ts` | low | mapped |
| `source_inventory_snapshot_evidence_v2` | case-backfill | worldcons_ingest | mutate-idempotent | d1-transaction | CaseBackfillRepository.updateSnapshotEvidence | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_inventory_snapshot_close_v3` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.closeSnapshot | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_request_permit_acquire_v1` | case-backfill | worldcons_ingest | claim-permit | d1-conditional-update | CaseBackfillRepository.acquireSourceRequestPermit | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_request_permit_release_v1` | case-backfill | worldcons_ingest | claim-permit | d1-conditional-update | CaseBackfillRepository.releaseSourceRequestPermit | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_snapshot_status_v1` | case-backfill | worldcons_ingest | read-aggregate | d1-read | CaseBackfillRepository.getSnapshotStatus | `tests/constitutional-case-backfill-gate1.test.ts` | low | mapped |
| `source_backfill_run_begin_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.beginRun | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_pass_allocate_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.allocatePass | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_run_finish_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.finishRun | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_phase_backlog_count_v1` | case-backfill | worldcons_ingest | read-aggregate | d1-read | CaseBackfillRepository.countBacklog | `tests/constitutional-case-backfill-gate1.test.ts` | low | mapped |
| `source_backfill_items_claim_v2` | case-backfill | worldcons_ingest | claim-lease | d1-conditional-update | CaseBackfillRepository.claimItems | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_items_extend_v1` | case-backfill | worldcons_ingest | claim-lease | d1-conditional-update | CaseBackfillRepository.extendItems | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_fetch_artifact_record_v2` | case-backfill | worldcons_ingest | audit-append | r2-coordination+d1-transaction | CaseBackfillRepository.recordFetchArtifact | `tests/backfill-artifact-blob-write.test.ts` | high | mapped |
| `source_backfill_fetch_artifact_record_v1` | case-backfill | worldcons_ingest | audit-append | d1-audit-append | CaseBackfillRepository.recordFetchArtifact | `tests/backfill-artifact-blob-write.test.ts` | low | mapped |
| `source_backfill_normalization_artifact_record_v2` | case-backfill | worldcons_ingest | audit-append | r2-coordination+d1-transaction | CaseBackfillRepository.recordNormalizationArtifact | `tests/backfill-artifact-blob-write.test.ts` | high | mapped |
| `source_backfill_normalization_artifact_record_v1` | case-backfill | worldcons_ingest | audit-append | d1-audit-append | CaseBackfillRepository.recordNormalizationArtifact | `tests/backfill-artifact-blob-write.test.ts` | low | mapped |
| `case_catalog_publish_backfill_item_v1` | case-backfill | worldcons_core | projection-publish | d1-projection-publish | CaseBackfillRepository.publishItem | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_item_complete_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.completeItem | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_item_fail_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.failItem | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_item_exclude_v1` | case-backfill | worldcons_ingest | mutate-transactional | d1-transaction | CaseBackfillRepository.excludeItem | `tests/constitutional-case-backfill-gate1.test.ts` | high | mapped |
| `source_backfill_artifact_externalize_v1` | case-backfill | worldcons_ingest | mutate-idempotent | r2-coordination+d1-transaction | CaseBackfillRepository.attachArtifactExternalization | `tests/backfill-artifact-blob-externalize.test.ts` | high | mapped |
| `source_backfill_artifact_inline_clear_v1` | case-backfill | worldcons_ingest | mutate-idempotent | r2-coordination+d1-transaction | CaseBackfillRepository.clearArtifactInline | `tests/backfill-artifact-blob-inline-clear.test.ts` | high | mapped |
| `source_backfill_artifact_inline_restore_v1` | case-backfill | worldcons_ingest | mutate-idempotent | r2-coordination+d1-transaction | CaseBackfillRepository.restoreArtifactInline | `tests/backfill-artifact-blob-restore.test.ts` | high | mapped |
| `source_backfill_artifact_readiness_rows_v1` | case-backfill | worldcons_ingest | read | d1-read | CaseBackfillRepository.listArtifactReadinessRows | `tests/backfill-artifact-blob-readiness.test.ts` | low | mapped |
| `worldcons_consume_rate_limit_v1` | security | worldcons_ops | mutate-idempotent | d1-conditional-update | consumeRateLimit | `tests/security-platform-hardening.test.ts` | medium | mapped |
| `admin_operational_health_p5` | admin-governance | worldcons_ops | read-aggregate | d1-read | getP5HealthEvidence | `tests/admin-governance-p5.test.ts` | low | mapped |
| `admin_record_owner_approval_p5_v2` | admin-governance | worldcons_ops | audit-append | d1-audit-append | recordP5OwnerApproval | `tests/admin-governance-p5.test.ts` | low | mapped |
| `admin_apply_retention_p5` | admin-governance | worldcons_ops | retention-purge | d1-transaction | applyP5Retention | `tests/admin-governance-p5.test.ts` | high | mapped |
| `admin_record_compatibility_observation_p5` | admin-governance | worldcons_ops | audit-append | d1-audit-append | recordCompatibilityObservation | `tests/admin-governance-p5.test.ts` | low | mapped |
| `worldcons_ranked_search_page_v1` | search | worldcons_search | search-rank | d1-search | SearchRepository.rankedSearchPageRpc | `tests/search-repository.test.ts`<br>`tests/constitutional-case-search-gate4.test.ts` | medium | mapped |
| `worldcons_case_search_page_v2` | search | worldcons_search | search-rank | d1-search | SearchRepository.catalogCaseSearchRpc | `tests/search-repository.test.ts`<br>`tests/constitutional-case-search-gate3.test.ts` | medium | mapped |
| `public_fulltext_ranked_ids_v1` | search | worldcons_search | search-rank | d1-search | SearchRepository.fullTextRankedIdsRpc | `tests/search-repository.test.ts` | medium | mapped |
| `match_public_article_versions_p3` | search | vectorize | search-rank | vectorize | SearchRepository.vectorMatchRpc | `tests/search-repository.test.ts` | high | mapped |
| `match_articles` | search | vectorize | search-rank | vectorize | SearchRepository.vectorMatchRpc | `tests/search-repository.test.ts` | high | mapped |
| `rpc_admin_dashboard_snapshot` | admin-observability | worldcons_ops | read-aggregate | d1-read | AdminOpsReadRepository.loadDashboardSnapshot | `tests/admin-ops-read-repository.test.ts` | low | mapped |
| `public_jurisdiction_article_counts` | public-reference | worldcons_core | read-aggregate | d1-read | ReferenceReadRepository.listJurisdictionArticleCounts | `tests/reference-reads-repository.test.ts` | low | mapped |
| `public_jurisdiction_article_counts_p3` | public-reference | worldcons_core | read-aggregate | d1-read | ReferenceReadRepository.listJurisdictionArticleCounts | `tests/reference-reads-repository.test.ts` | low | mapped |
| `admin_submit_command_v3` | admin-commands | worldcons_ops | mutate-transactional | d1-transaction | AdminCommandRepository.submit | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_claim_command_attempt_p1` | admin-commands | worldcons_ops | claim-lease | d1-conditional-update | AdminCommandRepository.claim | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_claim_command_attempt_v3` | admin-commands | worldcons_ops | claim-lease | d1-conditional-update | AdminCommandRepository.claim | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_heartbeat_command_attempt_v3` | admin-commands | worldcons_ops | claim-lease | d1-conditional-update | AdminCommandRepository.heartbeat | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_complete_command_attempt_v3` | admin-commands | worldcons_ops | mutate-transactional | d1-transaction | AdminCommandRepository.complete | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_fail_command_attempt_v3` | admin-commands | worldcons_ops | mutate-transactional | d1-transaction | AdminCommandRepository.fail | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_abort_command_run_v3` | admin-commands | worldcons_ops | mutate-transactional | d1-transaction | AdminCommandRepository.abort | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_retry_command_run_v3` | admin-commands | worldcons_ops | mutate-transactional | d1-transaction | AdminCommandRepository.retry | `tests/admin-command-control-plane.test.ts` | high | mapped |
| `admin_begin_source_url_candidate_retry_p1` | admin-jobs | worldcons_ingest | claim-lease | d1-conditional-update | beginSourceUrlCandidateRetry | required M5: M5 D1 parity: focused test proving beginSourceUrlCandidateRetry reproduces admin_begin_source_url_candidate_retry_p1 on worldcons_ingest | high | pending-parity |
| `admin_finish_source_url_candidate_retry_p1` | admin-jobs | worldcons_ingest | mutate-idempotent | d1-transaction | finishSourceUrlCandidateRetry | required M5: M5 D1 parity: focused test proving finishSourceUrlCandidateRetry reproduces admin_finish_source_url_candidate_retry_p1 on worldcons_ingest | medium | pending-parity |
| `claim_admin_job` | admin-jobs | worldcons_ops | claim-lease | d1-conditional-update | claimAdminJob | required M5: M5 D1 parity: focused test proving claimAdminJob reproduces claim_admin_job on worldcons_ops | high | pending-parity |
| `append_admin_job_event` | admin-jobs | worldcons_ops | audit-append | d1-audit-append | appendAdminJobEvent | required M5: M5 D1 parity: focused test proving appendAdminJobEvent reproduces append_admin_job_event on worldcons_ops | low | pending-parity |
| `rpc_admin_analytics_health_snapshot` | admin-observability | worldcons_ops | read-aggregate | d1-read | AdminAnalyticsReadRepository.loadAnalyticsHealthSnapshot | `tests/admin-analytics-read-repository.test.ts` | low | mapped |
| `ops_workflow_heartbeat_v1` | workflow | worldcons_ops | mutate-idempotent | d1-transaction+workflow | recordWorkflowHeartbeat | `tests/workflow-heartbeat.test.ts` | medium | mapped |
| `article_embedding_write_v1` | embeddings | worldcons_core | mutate-idempotent | d1-transaction+vectorize | persistArticleEmbedding | `tests/embedding-vector.test.ts` | high | mapped |
| `article_embedding_readiness_v1` | embeddings | worldcons_core | read-aggregate | d1-read | getEmbeddingReadiness | `tests/embedding-provider.test.ts` | low | mapped |
| `refresh_tag_counts` | tag-maintenance | worldcons_core | mutate-transactional | d1-transaction | runRefreshTagCounts | required M5: M5 D1 parity: focused test proving runRefreshTagCounts reproduces refresh_tag_counts on worldcons_core | medium | pending-parity |

### 5.1 Dynamic indirections

| Id | Call site | Kind | Bounded | Resolver | Resolved functions |
| --- | --- | --- | --- | --- | --- |
| command-control-plane-local-rpc-wrapper | `lib/admin/command-control-plane/repository.ts` `.rpc(name)` | parameter | true | module-local helper rpc(name, args): catalog = the literal first argument at each of its 6 in-file call sites | `admin_abort_command_run_v3`<br>`admin_complete_command_attempt_v3`<br>`admin_fail_command_attempt_v3`<br>`admin_heartbeat_command_attempt_v3`<br>`admin_retry_command_run_v3`<br>`admin_submit_command_v3` |
| command-control-plane-claim-variant | `lib/admin/command-control-plane/repository.ts` `.rpc(rpcName)` | constant | true | const rpcName = input.cohorts?.length ? admin_claim_command_attempt_p1 : admin_claim_command_attempt_v3 | `admin_claim_command_attempt_p1`<br>`admin_claim_command_attempt_v3` |
| article-raw-externalization-operator-read | `lib/article-raw/externalization-repository.ts` `.rpc(ARTICLE_RAW_OPERATOR_READ_RPC)` | constant | true | same-file const ARTICLE_RAW_OPERATOR_READ_RPC = article_raw_operator_candidates_v1 | `article_raw_operator_candidates_v1` |
| article-raw-inline-clear-operator-read | `lib/article-raw/inline-clear-repository.ts` `.rpc(ARTICLE_RAW_OPERATOR_READ_RPC)` | constant | true | same-file const ARTICLE_RAW_OPERATOR_READ_RPC = article_raw_operator_candidates_v1 | `article_raw_operator_candidates_v1` |
| article-raw-readiness | `lib/article-raw/readiness-repository.ts` `.rpc(ARTICLE_RAW_READINESS_RPC)` | constant | true | exported const ARTICLE_RAW_READINESS_RPC = article_raw_readiness_v1 | `article_raw_readiness_v1` |
| article-raw-restore-candidates | `lib/article-raw/restore-repository.ts` `.rpc(ARTICLE_RAW_RESTORE_LIST_RPC)` | constant | true | same-file const ARTICLE_RAW_RESTORE_LIST_RPC = article_raw_restore_candidates_v1 | `article_raw_restore_candidates_v1` |
| article-raw-restore-inline | `lib/article-raw/restore-repository.ts` `.rpc(ARTICLE_RAW_RESTORE_RPC)` | constant | true | same-file const ARTICLE_RAW_RESTORE_RPC = article_raw_restore_inline_v1 | `article_raw_restore_inline_v1` |
| reference-reads-jurisdiction-count-projection | `lib/reference-reads/supabase-repository.ts` `.rpc(countRpc)` | constant | true | const countRpc = projectionEnabled() ? public_jurisdiction_article_counts_p3 : public_jurisdiction_article_counts | `public_jurisdiction_article_counts`<br>`public_jurisdiction_article_counts_p3` |
| search-ranked-page | `lib/search/repository/supabase-repository.ts` `.rpc(RANKED_SEARCH_PAGE_RPC)` | constant | true | same-file const RANKED_SEARCH_PAGE_RPC = worldcons_ranked_search_page_v1 | `worldcons_ranked_search_page_v1` |
| search-catalog-case-page | `lib/search/repository/supabase-repository.ts` `.rpc(CATALOG_CASE_SEARCH_RPC)` | constant | true | same-file const CATALOG_CASE_SEARCH_RPC = worldcons_case_search_page_v2 | `worldcons_case_search_page_v2` |
| search-fulltext-ranked-ids | `lib/search/repository/supabase-repository.ts` `.rpc(FULLTEXT_RANKED_IDS_RPC)` | constant | true | same-file const FULLTEXT_RANKED_IDS_RPC = public_fulltext_ranked_ids_v1 | `public_fulltext_ranked_ids_v1` |
| search-vector-match-authority | `lib/search/repository/supabase-repository.ts` `.rpc(publicVectorMatchRpc(false, environment))` | function-call | true | imported publicVectorMatchRpc() from @/lib/article-publication -> public-read-authority.ts; ternary on the projection flag, resolved through the barrel re-export | `match_articles`<br>`match_public_article_versions_p3` |

### 5.2 Ledger coverage summary

Validated counts from `pnpm rpc:ledger --json` (80 functions, 73 `mapped` /
7 `pending-parity`):

- Target databases: `worldcons_core` 23, `worldcons_ingest` 32, `worldcons_ops` 19,
  `worldcons_search` 4, `vectorize` 2.
- Domains: `case-backfill` 35, `admin-commands` 8, `article-publication` 6,
  `article-raw` 6, `search` 6, `admin-governance` 4, `admin-jobs` 4,
  `admin-observability` 2, `embeddings` 2, `public-reference` 2, and
  `analytics` / `article-lifecycle` / `security` / `tag-maintenance` / `workflow`
  1 each.
- Transaction semantics: `mutate-transactional` 21, `mutate-idempotent` 13,
  `audit-append` 9, `read-aggregate` 9, `claim-lease` 7, `read` 6, `search-rank` 6,
  `claim-permit` 2, `outbox-settle` 2, `projection-publish` 2, `retention-purge` 2,
  `outbox-claim` 1.
- Risk: `high` 49, `medium` 11, `low` 20.

**Track-B / Hyperdrive evaluation candidates.** These are the rows with genuine
cross-store / atomicity concerns, not every `high` row. They are evaluation
candidates, not blockers: M5 first attempts the planned Cloudflare primitives
(D1 transactions, Queues, Workflows, Vectorize, R2 coordination), and
Hyperdrive/Postgres is a fallback only if parity/atomicity cannot be preserved.

| Cross-store concern | Candidate functions |
| --- | --- |
| R2 + D1 | `article_raw_inline_clear_v1`, `article_raw_externalize_v1`, `article_raw_restore_inline_v1`, `source_backfill_fetch_artifact_record_v2`, `source_backfill_normalization_artifact_record_v2`, `source_backfill_artifact_externalize_v1`, `source_backfill_artifact_inline_clear_v1`, `source_backfill_artifact_inline_restore_v1` |
| D1 + Queue / outbox | `article_cache_outbox_deliver_p3`, `us_conan_candidate_publish_catalog_v1`, `case_catalog_publish_backfill_item_v1` |
| D1 + Vectorize | `article_embedding_write_v1` |

## 6. Roots outside the runtime ledger scope

The scanner also counts adjacent roots so nothing is dropped silently.

| Root | `.rpc(` call sites | Note |
| --- | --- | --- |
| `worker/` | 0 | |
| `components/` | 0 | |
| `plugins/` | 0 | |
| `scripts/` | 7 | operator/backfill CLIs, not app runtime |

The 7 operator-CLI calls are documented for completeness but are not part of the
`app/lib/workers` runtime ledger:

| Call site | Function |
| --- | --- |
| `scripts/article-publication-p3.ts:25` | `article_publication_backfill_batch_p3` |
| `scripts/article-publication-p3.ts:75` | `article_publication_evidence_p3` |
| `scripts/article-lifecycle-p2.ts:32` | `article_lifecycle_backfill_batch_p2` |
| `scripts/article-lifecycle-p2.ts:43` | `article_lifecycle_evidence_p2` |
| `scripts/admin-ops-readiness.ts:48` | `admin.rpc(functionName, args)` (dynamic probe) |
| `scripts/admin-ops-readiness.ts:112` | `claim_admin_job` |
| `scripts/backfill-judicial-complaint-tags.ts:187` | `refresh_tag_counts` |

A follow-on slice can extend `DEFAULT_SCAN_ROOTS` to include `scripts` if the
operator paths are brought under the same repository abstraction.

## 7. Validator

`pnpm rpc:ledger` scans source and validates the ledger. It first validates every
`RpcLedgerDefinitionEntry` on its own (runtime field validation, independent of the
scan), then cross-checks the ledger against the scan. It fails (`exit 1`) when:

- a ledger row has an empty `rpcName`, `currentPurpose`, `targetServiceMethod` or
  `notes`, or an empty `additionalServiceMethods` entry (`empty-ledger-field`);
- a ledger row's `domain`, `targetDatabase`, `transactionSemantics`,
  `migrationPrimitive`, `status` or `risk` is not one of the exact typed allowlist
  values exported from `types.ts` (`invalid-ledger-field`);
- a ledger row's `parityEvidence.existing` / `parityEvidence.requiredM5` contains a
  blank string, a `mapped` row has no existing parity test, or a `pending-parity`
  row carries an existing test or lacks a required M5 test (`invalid-parity-evidence`);
- a ledger row has no scanner-resolved `.rpc(` call site
  (`ledger-function-without-call-site`);
- a reachable function has no ledger entry (`unmapped-function`);
- a ledger entry has no reachable call site (`orphan-ledger-function`);
- a `.rpc()` call resolves to no function name (`unresolved-call-site`);
- a non-literal call site has no ledger indirection (`unclassified-call-site`);
- a bounded indirection's catalog differs from the scanner (`indirection-catalog-mismatch`);
- an indirection references an unknown function, is duplicated, or has no call site;
- an unbounded indirection carries no resolver.

A truly unbounded dynamic RPC is ledgered as `bounded: false` with its resolver; it
is counted (`unboundedDynamicFamilyCount`) and reported, never silently dropped. In
this repository every non-literal call site is bounded, so
`unboundedDynamicFamilyCount` is 0 - the two dynamic families resolve to finite
catalogs derived from surrounding code.

## 8. Files and verification

Added:

- `lib/cloudflare/rpc-ledger/types.ts` - enriched ledger row, call-site/indirection, parity-evidence and typed allowlist (domain, targetDatabase, migrationPrimitive, transactionSemantics, status, risk) types.
- `lib/cloudflare/rpc-ledger/scan.ts` - reproducible TypeScript-API scanner.
- `lib/cloudflare/rpc-ledger/ledger.ts` - the 80 enriched ledger rows + 12 indirections.
- `lib/cloudflare/rpc-ledger/validate.ts` - ledger <-> scan cross-check.
- `lib/cloudflare/rpc-ledger/index.ts` - barrel + machine-readable report builder (attaches scan-derived `callSites` and the summary).
- `scripts/rpc-ledger.ts` - `pnpm rpc:ledger` CLI (`--json`, `--write`).
- `tests/rpc-ledger.test.ts` - 16 focused tests (11 ledger/scan tests + 5 validator field negative tests).
- `docs/worldcons-cloudflare-m4-rpc-ledger-20260921.md` - this document.

Changed:

- `package.json` - `rpc:ledger`, `test:rpc-ledger`; `test:rpc-ledger` added to `verify:release`.
- `.gitignore` - ignore the generated `artifacts/cloudflare-m4/` report.

| Check | Result |
| --- | --- |
| `pnpm rpc:ledger` | Pass, 80 functions / 74 call sites / 80 unique / 2 dynamic / 0 unbounded / 73 mapped / 7 pending-parity |
| `pnpm test:rpc-ledger` | Pass, 16/16 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` (new files) | Pass |

Rollback is repository-only: delete `lib/cloudflare/rpc-ledger/`,
`scripts/rpc-ledger.ts`, `tests/rpc-ledger.test.ts`, this document, and revert the
`package.json` / `.gitignore` additions.
