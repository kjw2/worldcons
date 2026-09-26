import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * M7.8-A semantic-authority rollout migration contract (operator-only, pure
 * constants + integrity assertions).
 *
 * This module pins the EXACT forward migration M7.8-A is allowed to apply. It
 * carries the version, path, expected SHA-256, the linked production project
 * identity and the frozen gate2 projection column order. Nothing here mutates
 * Supabase; the apply path (`apply-plan.ts`) consumes these constants so a
 * drifted file, a wrong linked project or a wrong column order fails closed
 * before any bytes reach the database.
 *
 * The forward migration is `20260926120000_m7_7a_semantic_authority_projection.sql`
 * (authored by M7.7-A, NOT applied remotely). M7.8-A only operationalises the
 * rollout of those exact bytes; it never edits the migration.
 */

/** The 14-digit timestamp version of the forward M7.7-A migration. */
export const MIGRATION_VERSION = "20260926120000" as const;

/** The bare migration filename (no directory). */
export const MIGRATION_FILENAME = "20260926120000_m7_7a_semantic_authority_projection.sql" as const;

/** The repository-relative forward migration path. */
export const MIGRATION_PATH = `supabase/migrations/${MIGRATION_FILENAME}` as const;

/**
 * The frozen SHA-256 of the forward migration bytes, uppercase hex. Any edit of
 * the migration (whitespace included) changes this value and fails the rollout
 * closed. Recorded here once, at authoring time, from the committed file.
 */
export const MIGRATION_SHA256 = "89159138DF2085338D6F54B3D8BA2ADBA9FE74D6F9140CC59C7C28ECBE281FE5" as const;

/** The linked production Supabase project ref the rollout is allowed to target. */
export const LINKED_PROJECT_REF = "eawgnnytdvjuwhczyhlq" as const;

/** The linked production Supabase project name (identity cross-check). */
export const LINKED_PROJECT_NAME = "worldcons" as const;

/** The local Supabase linked-state directory used for the identity check. */
export const SUPABASE_TEMP_DIR = "supabase/.temp" as const;

/** The local CLI linked-project descriptor filename. */
export const LINKED_PROJECT_FILE = "linked-project.json" as const;

/** The local CLI bare project-ref filename. */
export const PROJECT_REF_FILE = "project-ref" as const;

/**
 * The frozen gate2 `public_article_projection_p3` column names, in exact
 * `attnum` order. The forward migration MUST preserve this list exactly (only
 * the embedding expression changes), and the preflight compares the live view to
 * this list before the apply, then again after.
 */
export const GATE2_PROJECTION_COLUMNS = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "raw_text",
  "cleaned_text",
  "summary_json",
  "source_metadata",
  "error_metadata",
  "content_hash",
  "search_vector",
  "embedding",
  "publication_id",
  "publication_revision",
  "article_version_id",
  "article_version_revision",
  "article_tags",
  "case_key",
  "source_anchor_version_id",
  "version_role",
  "enrichment_status",
  "enrichment_freshness",
  "summary_status",
  "summary_available",
] as const;

export const GATE2_PROJECTION_COLUMN_COUNT = GATE2_PROJECTION_COLUMNS.length;

/** The staged rollback candidate (kept OUTSIDE `supabase/migrations`). */
export const ROLLBACK_CANDIDATE_VERSION = "20260927120000" as const;
export const ROLLBACK_CANDIDATE_FILENAME =
  "20260927120000_m7_8_rollback_semantic_authority_projection.sql" as const;
export const ROLLBACK_CANDIDATE_DIRECTORY = "supabase/rollback-candidates" as const;
export const ROLLBACK_CANDIDATE_PATH =
  `${ROLLBACK_CANDIDATE_DIRECTORY}/${ROLLBACK_CANDIDATE_FILENAME}` as const;

/** The frozen pre-apply production baseline counts (M7.7-A read-only audit). */
export const BASELINE_CURRENT_PUBLISHED_ROWS = 1258 as const;
export const BASELINE_PROJECTION_ROWS = 1258 as const;
export const BASELINE_ARTIFACT_BACKED_CURRENT_PUBLISHED_ROWS = 1258 as const;
export const BASELINE_PROJECTION_EMBEDDING_NULL_COUNT = 872 as const;
export const BASELINE_LEGACY_VERSION_EMBEDDING_ONLY_COUNT = 872 as const;
export const BASELINE_TOTAL_MISMATCH_COUNT = 0 as const;

export const MIGRATION_CONTRACT_ERROR_CODES = [
  "migration_file_missing",
  "migration_sha256_mismatch",
  "linked_project_not_found",
  "linked_project_ref_mismatch",
  "linked_project_name_mismatch",
  "projection_columns_mismatch",
] as const;

export type MigrationContractErrorCode = (typeof MIGRATION_CONTRACT_ERROR_CODES)[number];

export class MigrationContractError extends Error {
  readonly code: MigrationContractErrorCode;

  constructor(code: MigrationContractErrorCode, message: string) {
    super(message);
    this.name = "MigrationContractError";
    this.code = code;
  }
}

/** Uppercase hex SHA-256 of the given bytes. */
export function migrationSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex").toUpperCase();
}

/** True when the content hashes to the pinned forward-migration SHA-256. */
export function migrationMatchesPin(content: string | Buffer): boolean {
  return migrationSha256(content) === MIGRATION_SHA256;
}

/** Fails closed unless the content hashes to the pinned SHA-256. */
export function assertMigrationSha256(content: string | Buffer): void {
  if (!migrationMatchesPin(content)) {
    throw new MigrationContractError(
      "migration_sha256_mismatch",
      "the forward migration bytes do not match the pinned M7.8-A SHA-256",
    );
  }
}

/** Reads the forward migration bytes from the repository, failing closed if absent. */
export function readMigrationBytes(rootDir: string): Buffer {
  const absolute = path.join(rootDir, MIGRATION_PATH);
  if (!fs.existsSync(absolute)) {
    throw new MigrationContractError("migration_file_missing", "the forward migration file is missing");
  }
  return fs.readFileSync(absolute);
}

export interface LinkedProjectIdentity {
  ref: string;
  name: string;
}

/**
 * Reads the local linked Supabase project identity from `supabase/.temp`. This
 * only reads the on-disk link state; it never contacts Supabase. Fails closed if
 * the link state is absent or does not match the pinned `worldcons` project.
 */
export function readLinkedProjectIdentity(rootDir: string): LinkedProjectIdentity {
  const projectRefPath = path.join(rootDir, SUPABASE_TEMP_DIR, PROJECT_REF_FILE);
  const linkedProjectPath = path.join(rootDir, SUPABASE_TEMP_DIR, LINKED_PROJECT_FILE);
  if (!fs.existsSync(projectRefPath) || !fs.existsSync(linkedProjectPath)) {
    throw new MigrationContractError("linked_project_not_found", "the Supabase linked state is missing");
  }
  const ref = fs.readFileSync(projectRefPath, "utf8").trim();
  const descriptor = JSON.parse(fs.readFileSync(linkedProjectPath, "utf8")) as {
    ref?: unknown;
    name?: unknown;
  };
  const name = typeof descriptor.name === "string" ? descriptor.name : "";
  if (ref !== LINKED_PROJECT_REF || descriptor.ref !== LINKED_PROJECT_REF) {
    throw new MigrationContractError(
      "linked_project_ref_mismatch",
      "the linked Supabase project ref does not match the pinned M7.8-A project",
    );
  }
  if (name !== LINKED_PROJECT_NAME) {
    throw new MigrationContractError(
      "linked_project_name_mismatch",
      "the linked Supabase project name does not match the pinned M7.8-A project",
    );
  }
  return { ref, name };
}

/** Fails closed unless the ordered live columns equal the frozen gate2 order. */
export function assertProjectionColumns(columns: readonly string[]): void {
  const matches =
    columns.length === GATE2_PROJECTION_COLUMNS.length &&
    columns.every((column, index) => column === GATE2_PROJECTION_COLUMNS[index]);
  if (!matches) {
    throw new MigrationContractError(
      "projection_columns_mismatch",
      "the live public_article_projection_p3 column order does not match the frozen gate2 list",
    );
  }
}
