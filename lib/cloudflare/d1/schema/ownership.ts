import type { D1Database, D1OwnershipEntry } from "../types";

/**
 * Plan section 5 ownership: which D1 database owns each Postgres table, plus
 * which D1-only projection tables exist. M5.1/M5.1b/M5.1c `covered` tables are
 * fully modeled in `schema/*.ts`, so every scanned Postgres table now has a D1
 * table. Validation fails if a Postgres table is unowned or if a `covered`
 * entry has no D1 table, so this map cannot silently drift.
 */
function covered(table: string, database: D1Database, note: string): D1OwnershipEntry {
  return { table, database, status: "covered", note };
}


const INGEST_NOTE = "high-write operational ingestion state (plan 5.2)";
const OPS_NOTE = "administrative and operational state (plan 5.3)";

const coveredEntries: D1OwnershipEntry[] = [
  covered("articles", "worldcons_core", "canonical public article/legal metadata foundation table"),
  covered("sources", "worldcons_core", "canonical source registry"),
  covered("tags", "worldcons_core", "canonical tag registry"),
  covered("article_tags", "worldcons_core", "canonical article/tag join"),
  covered("glossary_terms", "worldcons_core", "canonical glossary registry"),
  covered("ingestion_runs", "worldcons_ingest", "ingestion run history"),
  covered("source_url_candidates", "worldcons_ingest", "canonical URL candidate retry queue"),
  covered("site_events", "worldcons_ops", "privacy-minimized analytics/audit event log"),
  covered("admin_jobs", "worldcons_ops", "admin job queue state"),
  covered("admin_job_events", "worldcons_ops", "admin job event log"),
  covered("admin_audit_logs", "worldcons_ops", "admin audit log"),
  covered("admin_article_edit_history", "worldcons_ops", "admin article edit history"),
  covered("llm_settings", "worldcons_ops", "LLM provider settings"),
  covered("search_documents", "worldcons_search", "derived search projection (rebuilt, never authoritative)"),
  covered("search_fts", "worldcons_search", "FTS5 index over search_documents"),
  covered("article_audit_ledger_p3", "worldcons_core", "immutable publication audit ledger"),
  covered("article_cache_outbox_p3", "worldcons_core", "publication cache outbox"),
  covered("article_content_versions_p3", "worldcons_core", "immutable article version snapshots"),
  covered("article_embedding_artifacts", "worldcons_core", "embedding provenance (vector relocates to Vectorize)"),
  covered("article_lifecycle_anomalies_p2", "worldcons_core", "lifecycle anomaly register"),
  covered("article_lifecycle_events_p2", "worldcons_core", "append-only lifecycle transition log"),
  covered("article_publication_history_p3", "worldcons_core", "append-only publication state history"),
  covered("article_publication_quarantine_p3", "worldcons_core", "publication quarantine register"),
  covered("article_publication_quarantine_resolutions_p3", "worldcons_core", "publication quarantine resolutions"),
  covered("article_publication_requests_p3", "worldcons_core", "publication request idempotency ledger"),
  covered("article_publications_p3", "worldcons_core", "current article publication head"),
  covered("article_revision_heads_v4", "worldcons_core", "current article version head (v4 catalog)"),
  covered("article_version_heads_p3", "worldcons_core", "current article version head (p3)"),
  covered("article_view_counts", "worldcons_core", "article view counter"),
  covered("case_catalog_cache_outbox_v1", "worldcons_core", "catalog cache outbox"),
  covered("case_catalog_publication_events_v1", "worldcons_core", "append-only catalog publication events"),
  covered("case_catalog_publications_v1", "worldcons_core", "current catalog publication head"),
  covered("case_identifiers_v1", "worldcons_core", "normalized case identifier registry"),
  covered("case_metadata_v1", "worldcons_core", "constitutional authority/enrichment state"),
  covered("glossary_candidates", "worldcons_core", "glossary candidate review queue"),
  covered("legacy_version_freshness_classifications_v4", "worldcons_core", "legacy version freshness classification"),
  covered("legal_concept_alias_sets_v1", "worldcons_core", "reviewed legal concept alias set"),
  covered("legal_concept_aliases_v1", "worldcons_core", "legal concept alias entries"),
  covered("legal_concepts_v1", "worldcons_core", "legal concept registry"),
  covered("source_corpus_policies", "worldcons_core", "source corpus policy registry"),
];
const coveredIngestTables = [
  "article_raw_externalization_ledger",
  "article_raw_externalization_permits",
  "article_raw_inline_clear_permits",
  "article_raw_inline_restore_permits",
  "source_artifact_externalization_ledger",
  "source_artifact_externalization_permits",
  "source_artifact_inline_clear_permits",
  "source_artifact_inline_restore_permits",
  "source_backfill_item_events",
  "source_backfill_items",
  "source_backfill_runs",
  "source_fetch_artifacts",
  "source_inventory_enumeration_artifacts",
  "source_inventory_snapshot_supersessions",
  "source_inventory_snapshots",
  "source_normalization_artifacts",
  "source_request_governor_states",
  "source_request_permits",
  "us_conan_candidate_authority_artifacts_v1",
  "us_conan_candidate_catalog_events_v1",
  "us_conan_candidate_essay_evidence_v1",
  "us_conan_candidate_reviews_v1",
  "us_conan_candidate_snapshots_v1",
  "us_conan_case_candidates_v1",
];
const coveredOpsTables = [
  "admin_command_attempts",
  "admin_command_events",
  "admin_command_runs",
  "admin_commands",
  "admin_compatibility_observations_p5",
  "admin_governance_evidence_p5",
  "admin_ops_events",
  "admin_retention_holds_p5",
  "masterdash_collection_control",
  "masterdash_control_requests",
  "masterdash_sso_jtis",
  "ops_workflow_heartbeats",
  "security_rate_limit_buckets_v1",
];

export const ownership: D1OwnershipEntry[] = [
  ...coveredEntries,
  ...coveredIngestTables.map((table) => covered(table, "worldcons_ingest", INGEST_NOTE)),
  ...coveredOpsTables.map((table) => covered(table, "worldcons_ops", OPS_NOTE)),
];