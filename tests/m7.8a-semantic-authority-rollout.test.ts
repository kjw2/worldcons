import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FINALIZE_EXISTING_CHECK_ORDER,
  FINALIZE_EXISTING_FLAG,
  FINALIZE_EXISTING_FORBIDDEN_OPERATIONS,
  FINALIZED_PROJECTION_EMBEDDING_NULL_COUNT,
  GATE2_PROJECTION_COLUMNS,
  GATE2_PROJECTION_COLUMN_COUNT,
  LINKED_PROJECT_NAME,
  LINKED_PROJECT_REF,
  MIGRATION_PATH,
  MIGRATION_REPAIR_STATUS,
  MIGRATION_REPAIR_TOOLING,
  MIGRATION_SHA256,
  MIGRATION_VERSION,
  PROVENANCE_COUNTS_SQL,
  PROJECTION_COLUMNS_SQL,
  PROJECTION_IDENTITY_SQL,
  ROLLBACK_CANDIDATE_DIRECTORY,
  ROLLBACK_CANDIDATE_FILENAME,
  ROLLBACK_CANDIDATE_PATH,
  SCHEMA_MIGRATIONS_SQL,
  SEMANTIC_AUTHORITY_EVIDENCE_MARKDOWN_PATH,
  SEMANTIC_AUTHORITY_EVIDENCE_PATH,
  SEMANTIC_AUTHORITY_SMOKE_CASES,
  SEMANTIC_AUTHORITY_SMOKE_LIMIT_CEILING,
  assertApplyGate,
  assertApplyInvocation,
  assertContentFreeEvidence,
  assertFinalizeExistingReadOnly,
  assertHistoryRepairEligible,
  assertMigrationRepairInvocation,
  assertMigrationSha256,
  assertNoForbiddenMigrationTooling,
  assertPendingSetIsExactlyTarget,
  assertProjectionColumns,
  assertRecordHistoryScope,
  assertSemanticAuthoritySmokeCases,
  buildMigrationInventory,
  buildMigrationRepairArgs,
  buildSemanticAuthorityEvidence,
  computePendingMigrations,
  evaluateFinalizeExistingState,
  evaluateHistoryRepair,
  evaluatePostApplyValidation,
  evaluateProvenanceBaseline,
  evaluateSemanticAuthoritySmoke,
  isMigrationRepairInvocation,
  migrationSha256,
  parseLocalMigrationFilenames,
  parseProjectionColumnRows,
  parseProjectionIdentityRow,
  parseSchemaMigrationRows,
  parseSupabaseMigrationList,
  planSemanticAuthorityApply,
  provenanceCountsFromAudit,
  renderSemanticAuthorityEvidenceMarkdown,
  usesForbiddenMigrationTooling,
  verifyHistoryRepair,
  type ProvenanceCounts,
  type SemanticAuthorityEvidence,
} from "../lib/cloudflare/search-authority";
import { parseSemanticProvenanceAuditRow } from "../lib/cloudflare/search-vector";

const rootDir = process.cwd();
const forwardMigrationSql = fs.readFileSync(path.join(rootDir, MIGRATION_PATH), "utf8");
const rolloutScript = fs.readFileSync(path.join(rootDir, "scripts/semantic-authority-rollout.ts"), "utf8");
const rollbackSql = fs.readFileSync(path.join(rootDir, ROLLBACK_CANDIDATE_PATH), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The frozen gate2 order, restated independently of the contract module. */
const EXPECTED_GATE2_COLUMNS = [
  "id", "slug", "source_key", "jurisdiction", "institution_name", "content_type",
  "original_url", "canonical_url", "original_language", "original_title", "korean_title",
  "original_published_at", "discovered_at", "fetched_at", "summarized_at", "status",
  "raw_text", "cleaned_text", "summary_json", "source_metadata", "error_metadata",
  "content_hash", "search_vector", "embedding", "publication_id", "publication_revision",
  "article_version_id", "article_version_revision", "article_tags", "case_key",
  "source_anchor_version_id", "version_role", "enrichment_status", "enrichment_freshness",
  "summary_status", "summary_available",
];

test("M7.8-A pins the exact forward migration version, path and SHA-256", () => {
  assert.equal(MIGRATION_VERSION, "20260926120000");
  assert.equal(MIGRATION_PATH, "supabase/migrations/20260926120000_m7_7a_semantic_authority_projection.sql");
  assert.equal(MIGRATION_SHA256, "89159138DF2085338D6F54B3D8BA2ADBA9FE74D6F9140CC59C7C28ECBE281FE5");
  assert.equal(migrationSha256(forwardMigrationSql), MIGRATION_SHA256);
  assert.doesNotThrow(() => assertMigrationSha256(forwardMigrationSql));
  assert.throws(() => assertMigrationSha256(Buffer.from("tampered bytes")), /SHA-256/u);
});

test("the gate2 projection column contract is exactly 36 columns in gate2 order", () => {
  assert.equal(GATE2_PROJECTION_COLUMN_COUNT, 36);
  assert.deepEqual([...GATE2_PROJECTION_COLUMNS], EXPECTED_GATE2_COLUMNS);
  for (const column of EXPECTED_GATE2_COLUMNS) {
    assert.match(forwardMigrationSql, new RegExp(`'${column}'`, "u"), `${column} must be in the migration preflight`);
  }
  assert.doesNotThrow(() => assertProjectionColumns([...GATE2_PROJECTION_COLUMNS]));
  assert.throws(() => assertProjectionColumns([...EXPECTED_GATE2_COLUMNS.slice(0, -1)]), /column order/u);
});

test("the migration ledger is read-only and the linked project identity is pinned", () => {
  assert.equal(LINKED_PROJECT_REF, "eawgnnytdvjuwhczyhlq");
  assert.equal(LINKED_PROJECT_NAME, "worldcons");
  assert.match(SCHEMA_MIGRATIONS_SQL, /^select /u);
  assert.doesNotMatch(SCHEMA_MIGRATIONS_SQL, /\b(insert|update|delete|drop|alter|truncate)\b/iu);
  assert.deepEqual(parseSchemaMigrationRows([{ version: "20260926120000" }, { version: "not-a-version" }]), [
    "20260926120000",
  ]);
  assert.deepEqual(parseLocalMigrationFilenames(["20260926120000_x.sql", ".gitkeep", "notes.txt"]), [
    "20260926120000",
  ]);
});

test("the pending set must be exactly the single target version", () => {
  const local = ["20260101000000", "20260926120000"];
  const remote = ["20260101000000"];
  const report = buildMigrationInventory({ localVersions: local, directRemoteVersions: remote });
  assert.deepEqual(computePendingMigrations({ localVersions: local, remoteVersions: remote }), [
    "20260926120000",
  ]);
  assert.deepEqual(report.pendingVersions, ["20260926120000"]);
  assert.equal(report.targetAbsent, true);
  assert.equal(report.pendingSetExact, true);
  assert.doesNotThrow(() => assertPendingSetIsExactlyTarget(report));

  const extraFile = buildMigrationInventory({
    localVersions: [...local, "20260927120000"],
    directRemoteVersions: remote,
  });
  assert.equal(extraFile.pendingSetExact, false);
  assert.throws(() => assertPendingSetIsExactlyTarget(extraFile), /pending/u);

  const alreadyPresent = buildMigrationInventory({
    localVersions: local,
    directRemoteVersions: [...remote, "20260926120000"],
  });
  assert.throws(() => assertPendingSetIsExactlyTarget(alreadyPresent), /already present/u);

  const noTarget = buildMigrationInventory({ localVersions: ["20260101000000"], directRemoteVersions: remote });
  assert.throws(() => assertPendingSetIsExactlyTarget(noTarget), /pending/u);
});

test("the CLI migration inventory cross-check parses only 14-digit versions", () => {
  const stdout = [
    "        LOCAL      |     REMOTE     |     TIME (UTC)",
    "   20260101000000  | 20260101000000 | 2026-01-01 00:00:00",
    "   20260926120000  |                | 2026-09-26 12:00:00",
    "   20260927120000  | 20260927120000 | 2026-09-27 12:00:00",
    "   (relative time footer text)",
  ].join("\n");
  const parsed = parseSupabaseMigrationList(stdout);
  assert.deepEqual(parsed.local, ["20260101000000", "20260926120000", "20260927120000"]);
  assert.deepEqual(parsed.remote, ["20260101000000", "20260927120000"]);

  const reliable = buildMigrationInventory({
    localVersions: ["20260101000000", "20260926120000"],
    directRemoteVersions: ["20260101000000"],
    cliRemoteVersions: ["20260101000000"],
    cliReliable: true,
  });
  assert.equal(reliable.crossCheckReliable, true);
});

test("the apply plan carries only the exact forward-migration bytes through db query --linked", () => {
  const plan = planSemanticAuthorityApply(forwardMigrationSql);
  assert.deepEqual(plan.command.args.slice(0, 5), ["db", "query", "--linked", "-o", "json"]);
  assert.equal(plan.command.args[5], forwardMigrationSql);
  assert.equal(plan.migration.sha256, MIGRATION_SHA256);
  assert.equal(plan.explicit, true);
  assert.equal(plan.preflightRequired, true);
  assert.doesNotThrow(() => assertApplyInvocation(plan.command.args));
  assert.throws(() => assertApplyInvocation(["db", "push"]), /invocation/u);
  assert.throws(() => planSemanticAuthorityApply(Buffer.from("tampered bytes")), /SHA-256/u);
});

test("the apply path never uses forbidden migration tooling", () => {
  assert.throws(() => assertNoForbiddenMigrationTooling(["db", "push"]), /forbidden/u);
  assert.throws(() => assertNoForbiddenMigrationTooling(["migration", "up"]), /forbidden/u);
  assert.throws(() => assertNoForbiddenMigrationTooling(["db", "query", "--linked", "--include-all"]), /forbidden/u);
  assert.equal(usesForbiddenMigrationTooling(["db", "query", "--linked"]), false);
  assert.doesNotMatch(rolloutScript, /db push|migration up|--include-all/u);
  assert.match(rolloutScript, /db query --linked/u);
});

test("apply requires both the explicit flag and an in-process preflight", () => {
  assert.throws(() => assertApplyGate({ apply: false, dryRun: false, preflightPassed: true }), /apply/u);
  assert.throws(() => assertApplyGate({ apply: true, dryRun: false, preflightPassed: false }), /preflight/u);
  assert.throws(() => assertApplyGate({ apply: true, dryRun: true, preflightPassed: true }), /dry-run/u);
  assert.doesNotThrow(() => assertApplyGate({ apply: true, dryRun: false, preflightPassed: true }));
  assert.match(rolloutScript, /assertApplyGate/u);
  assert.match(rolloutScript, /planSemanticAuthorityApply/u);
  assert.match(rolloutScript, /createSupabaseLinkedQueryRunner/u);
});

test("the rollout script is dry-run by default and supports every documented mode", () => {
  assert.match(rolloutScript, /--dry-run/u);
  assert.match(rolloutScript, /--preflight/u);
  assert.match(rolloutScript, /--smoke/u);
  assert.match(rolloutScript, /--apply/u);
  assert.match(rolloutScript, /--finalize-existing/u);
  assert.match(rolloutScript, /--record-history/u);
  assert.match(rolloutScript, /--report/u);
  assert.match(rolloutScript, /--allow-live-baseline/u);
  assert.equal(FINALIZE_EXISTING_FLAG, "--finalize-existing");
  assert.equal(packageJson.scripts["m7.8a:dry-run"], "tsx scripts/semantic-authority-rollout.ts --dry-run");
  assert.equal(packageJson.scripts["m7.8a:preflight"], "tsx scripts/semantic-authority-rollout.ts --preflight");
  assert.equal(packageJson.scripts["m7.8a:report"], "tsx scripts/semantic-authority-rollout.ts --preflight --report");
  assert.equal(packageJson.scripts["m7.8a:apply"], "tsx scripts/semantic-authority-rollout.ts --apply --record-history --report");
  assert.equal(packageJson.scripts["m7.8a:apply:diagnostic"], "tsx scripts/semantic-authority-rollout.ts --apply");
  assert.equal(packageJson.scripts["m7.8a:smoke"], "tsx scripts/semantic-authority-rollout.ts --smoke");
  assert.equal(
    packageJson.scripts["m7.8a:finalize-existing"],
    "tsx scripts/semantic-authority-rollout.ts --finalize-existing",
  );
  assert.equal(packageJson.scripts["test:m7.8a"], "tsx --test tests/m7.8a-semantic-authority-rollout.test.ts");
});

test("record-history is a post-apply-only ledger reconciliation, never a preflight or schema-apply surface", () => {
  // Package scripts must never pair --record-history with --preflight.
  assert.equal(packageJson.scripts["m7.8a:record-history"], undefined);
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (command.includes("semantic-authority-rollout.ts")) {
      assert.equal(
        command.includes("--preflight") && command.includes("--record-history"),
        false,
        `${name} must not run --record-history in preflight`,
      );
    }
  }
  assert.equal(packageJson.scripts["m7.8a:apply"].includes("--record-history"), true);
  assert.equal(packageJson.scripts["m7.8a:apply"].includes("--report"), true);
  assert.equal(packageJson.scripts["m7.8a:finalize-existing"].includes("--record-history"), false);
  assert.equal(packageJson.scripts["m7.8a:finalize-existing"].includes("--apply"), false);

  // The gate is a pure function: only --apply may carry --record-history.
  assert.throws(() => assertRecordHistoryScope("preflight", true), /only valid with --apply/u);
  assert.throws(() => assertRecordHistoryScope("dry-run", true), /only valid with --apply/u);
  assert.throws(() => assertRecordHistoryScope("smoke", true), /only valid with --apply/u);
  assert.throws(() => assertRecordHistoryScope("finalize-existing", true), /only valid with --apply/u);
  assert.doesNotThrow(() => assertRecordHistoryScope("preflight", false));
  assert.doesNotThrow(() => assertRecordHistoryScope("apply", true));

  // Source-scan: the CLI enforces the scope and never writes evidence with --record-history.
  assert.match(rolloutScript, /assertRecordHistoryScope\(args\.mode, args\.recordHistory\)/u);
  assert.doesNotMatch(rolloutScript, /--preflight\s+--record-history|--record-history\s+--preflight/u);
});

test("the migration-repair invocation is exactly `migration repair --linked --status applied <version>`", () => {
  assert.equal(MIGRATION_REPAIR_STATUS, "applied");
  assert.equal(MIGRATION_REPAIR_TOOLING, "supabase migration repair --linked --status applied");
  const args = buildMigrationRepairArgs(MIGRATION_VERSION);
  assert.deepEqual(args, ["migration", "repair", "--linked", "--status", "applied", MIGRATION_VERSION]);
  assert.doesNotThrow(() => assertMigrationRepairInvocation(args));
  assert.equal(isMigrationRepairInvocation(args), true);

  // wrong subcommand, wrong status, wrong version, missing/extra tokens all reject
  assert.throws(() => assertMigrationRepairInvocation(["migration", "up", "--linked"]), /exactly/u);
  assert.throws(
    () => assertMigrationRepairInvocation(["migration", "repair", "--linked", "--status", "reverted", MIGRATION_VERSION]),
    /exactly/u,
  );
  assert.throws(
    () => assertMigrationRepairInvocation(["migration", "repair", "--linked", "--status", "applied", "20260926120001"]),
    /exactly/u,
  );
  assert.throws(
    () => assertMigrationRepairInvocation(["db", "push"]),
    /exactly/u,
  );
  assert.throws(() => buildMigrationRepairArgs("not-a-version"), /14-digit/u);
  assert.equal(isMigrationRepairInvocation(["db", "push"]), false);

  // The repair argv must still pass the shared forbidden-tooling deny-list.
  assert.doesNotThrow(() => assertNoForbiddenMigrationTooling(args));
  assert.throws(() => assertNoForbiddenMigrationTooling(["db", "push"]), /forbidden/u);

  // The CLI uses the exact builder and re-reads the ledger before trusting it.
  assert.match(rolloutScript, /buildMigrationRepairArgs\(MIGRATION_VERSION\)/u);
  assert.match(rolloutScript, /runSupabaseCli\(repairArgs, "supabase migration repair"\)/u);
  assert.match(rolloutScript, /parseSchemaMigrationRows\(await queryRows\(context, SCHEMA_MIGRATIONS_SQL\)\)/u);
});

test("history repair is forbidden before the exact-SQL apply and before post-apply validation", () => {
  assert.throws(
    () => assertHistoryRepairEligible({ exactSqlApplied: false, postApplyOk: false }),
    /after the exact migration SQL/u,
  );
  assert.throws(
    () => assertHistoryRepairEligible({ exactSqlApplied: false, postApplyOk: true }),
    /after the exact migration SQL/u,
  );
  // A failed post-apply validation never repairs, even though the SQL committed.
  assert.throws(
    () => assertHistoryRepairEligible({ exactSqlApplied: true, postApplyOk: false }),
    /post-apply validation/u,
  );
  assert.doesNotThrow(() => assertHistoryRepairEligible({ exactSqlApplied: true, postApplyOk: true }));

  // The CLI only reaches the repair branch after postApply.validation.ok, and the
  // repair helper repairs only when that gate is true.
  assert.match(rolloutScript, /postApplyOk: postApply\.validation\.ok/u);
  assert.match(rolloutScript, /if \(input\.recordHistory && input\.postApplyOk\)/u);
  assert.match(rolloutScript, /assertHistoryRepairEligible/u);
});

test("ledger state records the post-apply pending set and applied state without leaking content", () => {
  const local = ["20260101000000", "20260926120000"];

  const repaired = verifyHistoryRepair({
    localVersions: local,
    directRemoteVersions: ["20260101000000", "20260926120000"],
    cliRemoteVersions: ["20260101000000", "20260926120000"],
    cliReliable: true,
  });
  assert.equal(repaired.targetVersion, MIGRATION_VERSION);
  assert.equal(repaired.applied, true);
  assert.deepEqual(repaired.pendingVersions, []);
  assert.equal(repaired.verified, true);

  const notApplied = verifyHistoryRepair({
    localVersions: local,
    directRemoteVersions: ["20260101000000"],
  });
  assert.equal(notApplied.applied, false);
  assert.deepEqual(notApplied.pendingVersions, [MIGRATION_VERSION]);
  assert.equal(notApplied.verified, false);

  const cliDisagrees = verifyHistoryRepair({
    localVersions: local,
    directRemoteVersions: ["20260101000000", "20260926120000"],
    cliRemoteVersions: ["20260101000000"],
    cliReliable: true,
  });
  assert.equal(cliDisagrees.cliCrossCheck, false);
  assert.equal(cliDisagrees.verified, false);

  // The decision: a repair command that exits 0 but does not verify still fails.
  const unverified = evaluateHistoryRepair({ repairExitOk: true, verification: notApplied });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.historyRecorded, true);
  assert.equal(unverified.historyVerified, false);
  assert.equal(unverified.blocker, "history_repair_failed");

  const failedExit = evaluateHistoryRepair({ repairExitOk: false, verification: repaired });
  assert.equal(failedExit.ok, false);
  assert.equal(failedExit.blocker, "history_repair_failed");

  const verified = evaluateHistoryRepair({ repairExitOk: true, verification: repaired });
  assert.equal(verified.ok, true);
  assert.equal(verified.historyRecorded, true);
  assert.equal(verified.historyVerified, true);
  assert.equal(verified.blocker, null);

  // The CLI reports the bounded history_repair_failed blocker and never auto-rolls back.
  assert.match(rolloutScript, /history_repair_failed/u);
  assert.match(rolloutScript, /historyVerified/u);
  assert.match(rolloutScript, /do NOT rollback|never rolled back|no auto-rollback/iu);
});

test("the preflight baseline is enforced strictly unless --allow-live-baseline captures same-day counts", () => {
  const baseline: ProvenanceCounts = {
    currentPublishedRows: 1258,
    projectionRows: 1258,
    projectionEmbeddingNullCount: 872,
    artifactBackedCurrentPublishedRows: 1258,
    legacyVersionEmbeddingOnlyCount: 872,
    totalMismatchCount: 0,
  };
  assert.equal(evaluateProvenanceBaseline(baseline).ok, true);
  assert.equal(evaluateProvenanceBaseline({ ...baseline, totalMismatchCount: 1 }).ok, false);
  assert.equal(evaluateProvenanceBaseline({ ...baseline, projectionRows: 1257 }).ok, false);

  const live = evaluateProvenanceBaseline(
    {
      currentPublishedRows: 1301,
      projectionRows: 1301,
      projectionEmbeddingNullCount: 901,
      artifactBackedCurrentPublishedRows: 1301,
      legacyVersionEmbeddingOnlyCount: 901,
      totalMismatchCount: 0,
    },
    { allowLiveBaseline: true },
  );
  assert.equal(live.ok, true);
  assert.equal(live.allowLiveBaseline, true);
  // mismatches stay fatal even when the live baseline is allowed
  assert.equal(evaluateProvenanceBaseline({ ...baseline, totalMismatchCount: 2 }, { allowLiveBaseline: true }).ok, false);

  const audit = parseSemanticProvenanceAuditRow({
    current_published_rows: 1258,
    projection_rows: 1258,
    projection_embedding_null_count: 872,
    artifact_backed_current_published_rows: 1258,
    legacy_version_embedding_only_count: 872,
    artifact_provider_mismatch_count: 0,
    artifact_model_mismatch_count: 0,
    artifact_dimensions_mismatch_count: 0,
    artifact_content_hash_mismatch_count: 0,
    artifact_version_mismatch_count: 0,
  });
  assert.equal(provenanceCountsFromAudit(audit).totalMismatchCount, 0);
  assert.match(PROVENANCE_COUNTS_SQL, /projection_embedding_null_count/u);
});

test("post-apply validation gates columns, count+digest, artifact-backing, mismatches and smoke drift", () => {
  const counts: ProvenanceCounts = {
    currentPublishedRows: 1258,
    projectionRows: 1258,
    projectionEmbeddingNullCount: 0,
    artifactBackedCurrentPublishedRows: 1258,
    legacyVersionEmbeddingOnlyCount: 872,
    totalMismatchCount: 0,
  };
  const preIdentity = { count: 1258, digest: "a".repeat(32) };
  const base = {
    preColumns: [...GATE2_PROJECTION_COLUMNS],
    postColumns: [...GATE2_PROJECTION_COLUMNS],
    preIdentity,
    postIdentity: preIdentity,
    counts,
    smokeOracleDrift: 0,
  };
  assert.equal(evaluatePostApplyValidation(base).ok, true);

  const driftedColumns = evaluatePostApplyValidation({ ...base, postColumns: [...GATE2_PROJECTION_COLUMNS.slice(1), "extra"] });
  assert.equal(driftedColumns.blockers.some((blocker) => blocker.code === "columns_changed"), true);

  const nullEmbedding = evaluatePostApplyValidation({ ...base, counts: { ...counts, projectionEmbeddingNullCount: 1 } });
  assert.equal(nullEmbedding.blockers.some((blocker) => blocker.code === "projection_embedding_null_nonzero"), true);

  const countChanged = evaluatePostApplyValidation({ ...base, postIdentity: { count: 1259, digest: preIdentity.digest } });
  assert.equal(countChanged.blockers.some((blocker) => blocker.code === "projection_row_count_changed"), true);

  const digestChanged = evaluatePostApplyValidation({ ...base, postIdentity: { count: 1258, digest: "b".repeat(32) } });
  assert.equal(digestChanged.blockers.some((blocker) => blocker.code === "projection_id_digest_changed"), true);

  const notArtifactBacked = evaluatePostApplyValidation({
    ...base,
    counts: { ...counts, artifactBackedCurrentPublishedRows: 1257 },
  });
  assert.equal(notArtifactBacked.blockers.some((blocker) => blocker.code === "artifact_backed_mismatch"), true);

  const mismatch = evaluatePostApplyValidation({ ...base, counts: { ...counts, totalMismatchCount: 1 } });
  assert.equal(mismatch.blockers.some((blocker) => blocker.code === "provenance_mismatch"), true);

  const drift = evaluatePostApplyValidation({ ...base, smokeOracleDrift: 1 });
  assert.equal(drift.blockers.some((blocker) => blocker.code === "smoke_oracle_drift"), true);
});

test("the semantic/hybrid smoke uses the M7.6 oracle seam and fails closed on drift", () => {
  assert.ok(SEMANTIC_AUTHORITY_SMOKE_CASES.length >= 2);
  for (const caseDef of SEMANTIC_AUTHORITY_SMOKE_CASES) {
    assert.ok(caseDef.mode === "semantic" || caseDef.mode === "hybrid");
    assert.ok(caseDef.limit > 0 && caseDef.limit <= SEMANTIC_AUTHORITY_SMOKE_LIMIT_CEILING);
  }
  assert.doesNotThrow(() => assertSemanticAuthoritySmokeCases());

  const clean = evaluateSemanticAuthoritySmoke([
    { caseId: "semantic-de-bverfg", mode: "semantic", productionSemanticEligible: true, pageRetrieved: true, topIds: ["11111111-1111-1111-1111-111111111111"] },
    { caseId: "hybrid-de-bverfg", mode: "hybrid", productionSemanticEligible: true, pageRetrieved: true, topIds: [] },
  ]);
  assert.equal(clean.oracleDrift, 0);
  assert.equal(clean.errors, 0);
  assert.equal(clean.pass, true);

  const drifted = evaluateSemanticAuthoritySmoke([
    { caseId: "semantic-de-bverfg", mode: "semantic", productionSemanticEligible: false, pageRetrieved: true, topIds: [] },
    { caseId: "hybrid-de-bverfg", mode: "hybrid", productionSemanticEligible: true, pageRetrieved: true, topIds: [] },
  ]);
  assert.equal(drifted.oracleDrift, 1);
  assert.equal(drifted.pass, false);
});

test("the read-only preflight SQL selects counts/columns/digests only", () => {
  assert.match(PROJECTION_COLUMNS_SQL, /^select /u);
  assert.match(PROJECTION_COLUMNS_SQL, /order by a\.attnum/u);
  assert.match(PROJECTION_IDENTITY_SQL, /count\(\*\)/u);
  assert.match(PROJECTION_IDENTITY_SQL, /md5\(/u);
  assert.doesNotMatch(PROJECTION_IDENTITY_SQL, /raw_text|cleaned_text|canonical_url|embedding\b/iu);
  assert.deepEqual(parseProjectionColumnRows([{ column_name: "id" }, { column_name: "slug" }]), ["id", "slug"]);
  const identity = parseProjectionIdentityRow({ projection_id_count: "1258", projection_id_digest: "a".repeat(32) });
  assert.equal(identity.count, 1258);
});

test("the rollback candidate is staged outside supabase/migrations and restores bare v.embedding", () => {
  assert.equal(ROLLBACK_CANDIDATE_DIRECTORY, "supabase/rollback-candidates");
  assert.equal(ROLLBACK_CANDIDATE_PATH, `${ROLLBACK_CANDIDATE_DIRECTORY}/${ROLLBACK_CANDIDATE_FILENAME}`);
  assert.equal(ROLLBACK_CANDIDATE_PATH.startsWith("supabase/migrations/"), false);
  assert.equal(fs.existsSync(path.join(rootDir, ROLLBACK_CANDIDATE_PATH)), true);
  assert.equal(fs.existsSync(path.join(rootDir, "supabase/migrations", ROLLBACK_CANDIDATE_FILENAME)), false);

  assert.match(rollbackSql, /^begin;/u);
  assert.match(rollbackSql, /commit;\s*$/u);
  assert.match(rollbackSql, /v\.embedding,p\.id as publication_id/u);
  assert.doesNotMatch(rollbackSql, /coalesce\(e\.embedding,v\.embedding\)/u);
  assert.match(rollbackSql, /with \(security_barrier = true\)/u);
  assert.match(rollbackSql, /M78_ROLLBACK_VIEW_MISSING/u);
  assert.match(rollbackSql, /M78_ROLLBACK_VIEW_COLUMN_DRIFT/u);
  assert.match(rollbackSql, /M78_ROLLBACK_SOURCE_STATE_MISSING/u);
  assert.match(rollbackSql, /notify pgrst, 'reload schema';/u);
  assert.match(rollbackSql, /grant select on public_article_projection_p3 to anon/u);
  assert.match(rollbackSql, /p\.state='published'/u);
});

function sampleEvidence(): SemanticAuthorityEvidence {
  return buildSemanticAuthorityEvidence({
    generatedAt: "2026-09-26T12:00:00.000Z",
    mode: "preflight",
    status: "preflight_ready",
    migration: { version: MIGRATION_VERSION, path: MIGRATION_PATH, sha256: MIGRATION_SHA256, sqlBytes: forwardMigrationSql.length },
    identity: { projectRef: LINKED_PROJECT_REF, projectName: LINKED_PROJECT_NAME },
    inventory: {
      targetVersion: MIGRATION_VERSION,
      pendingVersions: [MIGRATION_VERSION],
      targetAbsent: true,
      pendingSetExact: true,
      crossCheckReliable: false,
    },
    preflight: { mode: "preflight", ok: true, checks: ["migration_sha256"], blockers: [] },
    baseline: {
      allowLiveBaseline: false,
      currentPublishedRows: 1258,
      projectionRows: 1258,
      projectionEmbeddingNullCount: 872,
      artifactBackedCurrentPublishedRows: 1258,
      legacyVersionEmbeddingOnlyCount: 872,
      totalMismatchCount: 0,
    },
    preIdentity: { count: 1258, digest: "a".repeat(32) },
  });
}

test("evidence is content-free and rejects vectors, URLs, text and forbidden keys", () => {
  const evidence = sampleEvidence();
  assert.doesNotThrow(() => assertContentFreeEvidence(evidence));
  const json = JSON.stringify(evidence);
  assert.equal(json.includes("https://"), false);
  assert.equal(SEMANTIC_AUTHORITY_EVIDENCE_PATH, "artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.json");

  assert.throws(() => assertContentFreeEvidence({ embedding: [1, 2, 3] }), /forbidden/u);
  assert.throws(() => assertContentFreeEvidence({ summary_json: {} }), /forbidden/u);
  assert.throws(() => assertContentFreeEvidence({ href: "https://example.invalid/x" }), /URL/u);
  assert.throws(() => assertContentFreeEvidence({ value: Array.from({ length: 8 }, (_, index) => index) }), /vector/u);
  assert.throws(() => assertContentFreeEvidence({ value: "x".repeat(2000) }), /text/u);

  const markdown = renderSemanticAuthorityEvidenceMarkdown(evidence);
  assert.doesNotMatch(markdown, /https?:\/\//iu);
  assert.match(markdown, /authored_not_applied|preflight_ready/u);
});

test("apply evidence carries a content-free history block while preflight evidence has none", () => {
  const preflightEvidence = sampleEvidence();
  assert.equal(preflightEvidence.history, null);
  assert.doesNotThrow(() => assertContentFreeEvidence(preflightEvidence));
  assert.doesNotMatch(renderSemanticAuthorityEvidenceMarkdown(preflightEvidence), /- history:/u);

  const applyEvidence = buildSemanticAuthorityEvidence({
    generatedAt: "2026-09-26T12:00:00.000Z",
    mode: "apply",
    status: "applied",
    migration: preflightEvidence.migration,
    identity: preflightEvidence.identity,
    inventory: preflightEvidence.inventory,
    preflight: preflightEvidence.preflight,
    baseline: preflightEvidence.baseline,
    preIdentity: preflightEvidence.preIdentity,
    postIdentity: preflightEvidence.preIdentity,
    postApply: {
      applied: true,
      columnsUnchanged: true,
      projectionEmbeddingNullCount: 0,
      rowCountUnchanged: true,
      idDigestUnchanged: true,
      smokeOracleDrift: 0,
      ok: true,
      blockers: [],
    },
    smoke: { cases: 4, compared: 4, oracleDrift: 0, pass: true },
    history: {
      historyRecorded: true,
      historyVerified: true,
      targetVersion: MIGRATION_VERSION,
      applied: true,
      pendingVersions: [],
    },
  });
  assert.equal(applyEvidence.history?.historyRecorded, true);
  assert.equal(applyEvidence.history?.historyVerified, true);
  assert.equal(applyEvidence.history?.targetVersion, MIGRATION_VERSION);
  assert.equal(applyEvidence.history?.applied, true);
  assert.deepEqual(applyEvidence.history?.pendingVersions, []);
  assert.doesNotThrow(() => assertContentFreeEvidence(applyEvidence));

  const markdown = renderSemanticAuthorityEvidenceMarkdown(applyEvidence);
  assert.match(markdown, /history: recorded=true, verified=true, target=20260926120000, applied=true/u);
  assert.doesNotMatch(markdown, /https?:\/\//iu);

  // The apply path assembles evidence with the ledger history and writes it by default.
  assert.match(rolloutScript, /history: historyOutcome\.history/u);
  assert.match(rolloutScript, /writeEvidence\(context\.rootDir, evidence\)/u);
});

test("finalize-existing is a read-only verification that never applies SQL or repairs the ledger", () => {
  const start = rolloutScript.indexOf("async function runFinalizeExisting");
  const end = rolloutScript.indexOf("function dryRunPlan");
  assert.ok(start > 0 && end > start, "the finalize-existing implementation must be a contiguous block");
  const finalizeBody = rolloutScript.slice(start, end);

  // No mutation invocation may appear in the finalize-existing path.
  assert.doesNotMatch(finalizeBody, /planSemanticAuthorityApply\s*\(/u);
  assert.doesNotMatch(finalizeBody, /buildSemanticAuthorityApplyArgs\s*\(/u);
  assert.doesNotMatch(finalizeBody, /buildMigrationRepairArgs\s*\(/u);
  assert.doesNotMatch(finalizeBody, /migration["'],\s*["']repair/u);
  assert.doesNotMatch(finalizeBody, /context\.runner\(\s*migrationSql/u);
  assert.doesNotMatch(finalizeBody, /readMigrationBytes\([^)]*\)\.toString/u);

  // It only re-reads the already-applied state and the bounded smoke.
  assert.match(finalizeBody, /assertMigrationSha256/u);
  assert.match(finalizeBody, /verifyHistoryRepair/u);
  assert.match(finalizeBody, /readLedger/u);
  assert.match(finalizeBody, /PROJECTION_COLUMNS_SQL/u);
  assert.match(finalizeBody, /PROVENANCE_COUNTS_SQL/u);
  assert.match(finalizeBody, /PROJECTION_IDENTITY_SQL/u);
  assert.match(finalizeBody, /runSmoke/u);
  assert.match(finalizeBody, /evaluateFinalizeExistingState/u);
  assert.match(rolloutScript, /recoveredExistingState: true/u);
  assert.match(rolloutScript, /preIdentityAvailable: false/u);

  // The machine-checkable read-only contract.
  assert.deepEqual([...FINALIZE_EXISTING_FORBIDDEN_OPERATIONS], [
    "planSemanticAuthorityApply",
    "buildSemanticAuthorityApplyArgs",
    "buildMigrationRepairArgs",
    "supabase migration repair",
  ]);
  assert.doesNotThrow(() =>
    assertFinalizeExistingReadOnly(["select version from supabase_migrations.schema_migrations", "runSmoke", "select a.attname"]),
  );
  for (const operation of FINALIZE_EXISTING_FORBIDDEN_OPERATIONS) {
    assert.throws(() => assertFinalizeExistingReadOnly([`invoke ${operation}`]), /read-only/u);
  }
});

test("finalize-existing validates the finalized post-state read-only (target present, pending empty, exact counts)", () => {
  const counts: ProvenanceCounts = {
    currentPublishedRows: 1258,
    projectionRows: 1258,
    projectionEmbeddingNullCount: FINALIZED_PROJECTION_EMBEDDING_NULL_COUNT,
    artifactBackedCurrentPublishedRows: 1258,
    legacyVersionEmbeddingOnlyCount: 872,
    totalMismatchCount: 0,
  };
  const base = {
    columns: [...GATE2_PROJECTION_COLUMNS],
    identity: { count: 1258, digest: "a".repeat(32) },
    counts,
    smoke: { oracleDrift: 0, pass: true },
    targetApplied: true,
    cliCrossCheckOk: true,
    pendingVersions: [] as string[],
  };

  const good = evaluateFinalizeExistingState(base);
  assert.equal(good.ok, true);
  assert.deepEqual(
    [...good.checks],
    FINALIZE_EXISTING_CHECK_ORDER.filter((check) => check !== "linked_identity" && check !== "migration_sha256"),
  );

  const hasBlocker = (result: ReturnType<typeof evaluateFinalizeExistingState>, code: string): boolean =>
    result.blockers.some((blocker) => blocker.code === code);

  assert.equal(FINALIZED_PROJECTION_EMBEDDING_NULL_COUNT, 0);
  assert.equal(hasBlocker(evaluateFinalizeExistingState({ ...base, targetApplied: false }), "finalize_target_not_applied"), true);
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, cliCrossCheckOk: false }), "finalize_cli_cross_check_failed"),
    true,
  );
  assert.equal(hasBlocker(evaluateFinalizeExistingState({ ...base, cliCrossCheckOk: null }), "finalize_cli_cross_check_failed"), false);
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, pendingVersions: [MIGRATION_VERSION] }), "finalize_pending_not_empty"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, columns: [...GATE2_PROJECTION_COLUMNS.slice(1), "extra"] }), "finalize_columns_mismatch"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, counts: { ...counts, projectionEmbeddingNullCount: 872 } }), "finalize_projection_embedding_null_nonzero"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, counts: { ...counts, legacyVersionEmbeddingOnlyCount: 0 } }), "finalize_count_mismatch"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, counts: { ...counts, totalMismatchCount: 1 } }), "finalize_provenance_mismatch"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, smoke: { oracleDrift: 1, pass: false } }), "finalize_smoke_oracle_drift"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, smoke: { oracleDrift: 0, pass: false } }), "finalize_smoke_failed"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, columns: null }), "finalize_columns_unavailable"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, identity: null }), "finalize_identity_unavailable"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, counts: null }), "finalize_counts_unavailable"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, smoke: null }), "finalize_smoke_unavailable"),
    true,
  );
  assert.equal(
    hasBlocker(evaluateFinalizeExistingState({ ...base, pendingVersions: null }), "finalize_ledger_unavailable"),
    true,
  );
});

test("finalize-existing evidence marks the recovered state and never fabricates a pre-digest comparison", () => {
  const evidence = buildSemanticAuthorityEvidence({
    generatedAt: "2026-09-26T12:00:00.000Z",
    mode: "finalize-existing",
    status: "applied",
    recoveredExistingState: true,
    preIdentityAvailable: false,
    migration: { version: MIGRATION_VERSION, path: MIGRATION_PATH, sha256: MIGRATION_SHA256, sqlBytes: forwardMigrationSql.length },
    identity: { projectRef: LINKED_PROJECT_REF, projectName: LINKED_PROJECT_NAME },
    inventory: {
      targetVersion: MIGRATION_VERSION,
      pendingVersions: [],
      targetAbsent: false,
      pendingSetExact: false,
      crossCheckReliable: true,
    },
    preflight: { mode: "preflight", ok: true, checks: [...FINALIZE_EXISTING_CHECK_ORDER], blockers: [] },
    baseline: {
      allowLiveBaseline: false,
      currentPublishedRows: 1258,
      projectionRows: 1258,
      projectionEmbeddingNullCount: 0,
      artifactBackedCurrentPublishedRows: 1258,
      legacyVersionEmbeddingOnlyCount: 872,
      totalMismatchCount: 0,
    },
    preIdentity: null,
    postIdentity: { count: 1258, digest: "8225277ff26ba0622cecfd726a07e3b8" },
    postApply: {
      applied: true,
      columnsUnchanged: true,
      projectionEmbeddingNullCount: 0,
      rowCountUnchanged: null,
      idDigestUnchanged: null,
      smokeOracleDrift: 0,
      ok: true,
      blockers: [],
    },
    smoke: { cases: 4, compared: 4, oracleDrift: 0, pass: true },
    history: {
      historyRecorded: true,
      historyVerified: true,
      targetVersion: MIGRATION_VERSION,
      applied: true,
      pendingVersions: [],
    },
  });

  assert.equal(evidence.mode, "finalize-existing");
  assert.equal(evidence.status, "applied");
  assert.equal(evidence.recoveredExistingState, true);
  assert.equal(evidence.preIdentityAvailable, false);
  assert.equal(evidence.preIdentity, null);
  assert.equal(evidence.postApply?.rowCountUnchanged, null);
  assert.equal(evidence.postApply?.idDigestUnchanged, null);
  assert.equal(evidence.postApply?.applied, true);
  assert.equal(evidence.history?.historyRecorded, true);
  assert.equal(evidence.history?.historyVerified, true);
  assert.deepEqual(evidence.history?.pendingVersions, []);
  assert.doesNotThrow(() => assertContentFreeEvidence(evidence));

  const markdown = renderSemanticAuthorityEvidenceMarkdown(evidence);
  assert.match(markdown, /- recoveredExistingState: true/u);
  assert.match(markdown, /- preIdentityAvailable: false/u);
  assert.match(markdown, /- preIdentity: unavailable \(recoveredExistingState=true\)/u);
  assert.match(markdown, /rowCountUnchanged=n\/a, idDigestUnchanged=n\/a/u);
  assert.match(markdown, /history: recorded=true, verified=true, target=20260926120000, applied=true/u);
  assert.doesNotMatch(markdown, /https?:\/\//iu);

  // The checked-in artifact is the finalize-existing applied evidence and its
  // markdown renders back exactly from the JSON (no hand drift).
  const artifact = JSON.parse(
    fs.readFileSync(path.join(rootDir, SEMANTIC_AUTHORITY_EVIDENCE_PATH), "utf8"),
  ) as SemanticAuthorityEvidence;
  assert.equal(artifact.mode, "finalize-existing");
  assert.equal(artifact.status, "applied");
  assert.equal(artifact.recoveredExistingState, true);
  assert.equal(artifact.preIdentityAvailable, false);
  assert.equal(artifact.preIdentity, null);
  assert.equal(artifact.history?.historyVerified, true);
  assert.equal(artifact.smoke?.oracleDrift, 0);
  assert.doesNotThrow(() => assertContentFreeEvidence(artifact));
  const artifactMarkdown = fs.readFileSync(path.join(rootDir, SEMANTIC_AUTHORITY_EVIDENCE_MARKDOWN_PATH), "utf8");
  assert.equal(renderSemanticAuthorityEvidenceMarkdown(artifact), artifactMarkdown);
});
