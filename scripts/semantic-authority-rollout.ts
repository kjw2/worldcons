import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import {
  buildSupabaseLinkedInvocation,
  createSupabaseLinkedQueryRunner,
  defaultSupabaseBinary,
  parseSupabaseLinkedRows,
  type SupabaseLinkedQueryRunner,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import {
  ALLOW_LIVE_BASELINE_FLAG,
  APPLY_FLAG,
  DRY_RUN_FLAG,
  FINALIZE_EXISTING_CHECK_ORDER,
  FINALIZE_EXISTING_FLAG,
  MIGRATION_LIST_ARGS,
  MIGRATION_PATH,
  MIGRATION_SHA256,
  MIGRATION_VERSION,
  PREFLIGHT_FLAG,
  PREFLIGHT_CHECK_ORDER,
  PROVENANCE_COUNTS_SQL,
  PROJECTION_COLUMNS_SQL,
  PROJECTION_IDENTITY_SQL,
  RECORD_HISTORY_FLAG,
  REPORT_FLAG,
  SCHEMA_MIGRATIONS_SQL,
  SEMANTIC_AUTHORITY_EVIDENCE_MARKDOWN_PATH,
  SEMANTIC_AUTHORITY_EVIDENCE_PATH,
  SEMANTIC_AUTHORITY_SMOKE_CASES,
  SMOKE_FLAG,
  assertApplyGate,
  assertContentFreeEvidence,
  assertHistoryRepairEligible,
  assertMigrationRepairInvocation,
  assertMigrationSha256,
  assertPendingSetIsExactlyTarget,
  assertProjectionColumns,
  assertRecordHistoryScope,
  buildMigrationInventory,
  buildMigrationRepairArgs,
  buildSemanticAuthorityEvidence,
  evaluateHistoryRepair,
  evaluateFinalizeExistingState,
  evaluatePostApplyValidation,
  evaluateProvenanceBaseline,
  evaluateSemanticAuthoritySmoke,
  parseProjectionColumnRows,
  parseProjectionIdentityRow,
  parseSchemaMigrationRows,
  parseSupabaseMigrationList,
  planSemanticAuthorityApply,
  provenanceCountsFromAudit,
  readLinkedProjectIdentity,
  readLocalMigrationVersions,
  readMigrationBytes,
  renderSemanticAuthorityEvidenceMarkdown,
  summarizeSemanticAuthorityApplyPlan,
  verifyHistoryRepair,
  type HistoryRepairVerification,
  type LinkedProjectIdentity,
  type MigrationInventoryReport,
  type PostApplyValidationResult,
  type ProjectionIdentity,
  type ProvenanceCounts,
  type SemanticAuthorityEvidence,
  type SemanticAuthorityEvidenceBaseline,
  type SemanticAuthorityEvidenceHistory,
  type SemanticAuthoritySmokeCaseResult,
  type SemanticAuthoritySmokeReport,
} from "@/lib/cloudflare/search-authority";
import { parseSemanticProvenanceAuditRow } from "@/lib/cloudflare/search-vector";

/**
 * M7.8-A semantic-authority rollout operator CLI.
 *
 *   pnpm m7.8a:dry-run    # offline: prints the plan and SQL, connects to nothing
 *   pnpm m7.8a:preflight  # read-only linked production preflight
 *   pnpm m7.8a:apply      # explicit mutation: preflight + exact-bytes apply + validation
 *   pnpm m7.8a:smoke      # read-only bounded semantic/hybrid smoke
 *   pnpm m7.8a:finalize-existing  # READ-ONLY: verify an already-applied state + write applied evidence
 *   ... --report          # write the content-free LOCAL evidence artifact only
 *   ... --record-history  # POST-APPLY ONLY: reconcile the remote ledger after validation
 *   ... --allow-live-baseline  # preflight captures same-day counts, mismatches still 0
 *
 * The apply path executes ONLY the exact bytes of MIGRATION_PATH through
 * `supabase db query --linked -o json <sql>` inside the file's own
 * `begin; ... commit;` transaction, after re-running every preflight check in the
 * same process. It NEVER uses a schema-push, migration-up or include-all
 * tooling bypass.
 *
 * `--finalize-existing` is the recovery/verification surface for an
 * already-applied schema + migration-ledger state. It NEVER executes migration SQL
 * and NEVER runs `migration repair`: it re-reads the ledger, columns, semantic
 * counts and projection identity, runs the bounded smoke, and writes the local
 * applied evidence artifact. Because no pre-apply capture exists on this path, the
 * evidence marks `recoveredExistingState=true` / `preIdentityAvailable=false`; no
 * pre/post id-count+digest equality is fabricated.
 *
 * `--report` and `--record-history` are deliberately distinct:
 *
 * - `--report` writes `artifacts/.../m7.8a-semantic-authority-rollout.{json,md}`
 *   and never mutates Supabase; it is valid in preflight too.
 * - `--record-history` runs exactly `supabase migration repair --linked --status
 *   applied 20260926120000` ONLY after the exact-SQL apply committed AND every
 *   post-apply validation/smoke gate passed, then re-reads
 *   `supabase_migrations.schema_migrations` and requires the target present. It is
 *   rejected in every mode except `--apply`, is never the schema-apply mechanism,
 *   and a failure reports `history_repair_failed` without rolling the schema back.
 *
 * Supabase remains the sole production authority; this CLI changes no
 * SearchRepository, DNS or traffic flag.
 */

type RolloutMode = "dry-run" | "preflight" | "apply" | "smoke" | "finalize-existing";

interface RolloutArgs {
  mode: RolloutMode;
  allowLiveBaseline: boolean;
  /** Write the local content-free evidence artifact (never mutates the ledger). */
  report: boolean;
  /** Repair the remote migration ledger after a validated exact-SQL apply. */
  recordHistory: boolean;
}

export function parseRolloutArgs(argv: readonly string[]): RolloutArgs {
  const flags = [APPLY_FLAG, FINALIZE_EXISTING_FLAG, SMOKE_FLAG, PREFLIGHT_FLAG, DRY_RUN_FLAG].filter((flag) => argv.includes(flag));
  if (flags.length > 1) {
    throw new Error("select exactly one mode: --dry-run, --preflight, --smoke, --finalize-existing or --apply");
  }
  const mode: RolloutMode = argv.includes(APPLY_FLAG)
    ? "apply"
    : argv.includes(FINALIZE_EXISTING_FLAG)
      ? "finalize-existing"
      : argv.includes(SMOKE_FLAG)
        ? "smoke"
        : argv.includes(PREFLIGHT_FLAG)
          ? "preflight"
          : "dry-run";
  return {
    mode,
    allowLiveBaseline: argv.includes(ALLOW_LIVE_BASELINE_FLAG),
    report: argv.includes(REPORT_FLAG),
    recordHistory: argv.includes(RECORD_HISTORY_FLAG),
  };
}

function output(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A bounded Supabase CLI runner for `migration list`/`migration repair`. It uses
 * the same Windows-safe invocation builder as the query runner. stdout is
 * captured only for the caller to parse; stderr is drained and never recorded, so
 * raw CLI output (which may carry credentials or connection details) never reaches
 * a log or an error message. `label` names the operation in bounded error text.
 */
function runSupabaseCli(args: readonly string[], label: string, timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const invocation = buildSupabaseLinkedInvocation({ args: [...args], binary: defaultSupabaseBinary() });
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderrBytes = 0;
    let bytes = 0;
    let settled = false;
    const decoder = new StringDecoder("utf8");
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => finish(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        child.kill();
        return;
      }
      stdout += decoder.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 262_144) child.kill();
    });
    child.on("error", () => finish(() => reject(new Error(`${label} failed to run`))));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${code ?? "unknown"}`));
        return;
      }
      resolve(stdout + decoder.end());
    }));
  });
}

interface RolloutContext {
  runner: SupabaseLinkedQueryRunner;
  rootDir: string;
  now: string;
  allowLiveBaseline: boolean;
  cliMigrationList: () => Promise<string>;
}

async function queryRows(context: RolloutContext, sql: string): Promise<Record<string, unknown>[]> {
  return parseSupabaseLinkedRows(await context.runner(sql));
}

interface LedgerRead {
  direct: string[];
  cli: string[] | null;
  cliReliable: boolean;
}

/**
 * Re-reads the remote migration ledger directly and through the best-effort CLI
 * cross-check. A failure on either side is recorded as "unavailable" rather than
 * fatal, so the caller can decide whether the ledger state is verified.
 */
async function readLedger(context: RolloutContext): Promise<LedgerRead> {
  let direct: string[] = [];
  try {
    direct = parseSchemaMigrationRows(await queryRows(context, SCHEMA_MIGRATIONS_SQL));
  } catch {
    direct = [];
  }
  let cli: string[] | null = null;
  let cliReliable = false;
  try {
    cli = parseSupabaseMigrationList(await context.cliMigrationList()).remote;
    cliReliable = true;
  } catch {
    cli = null;
    cliReliable = false;
  }
  return { direct, cli, cliReliable };
}

interface PreflightOutcome {
  ok: boolean;
  checks: string[];
  blockers: string[];
  identity: LinkedProjectIdentity | null;
  inventory: MigrationInventoryReport | null;
  migration: { version: string; path: string; sha256: string; sqlBytes: number };
  columns: string[] | null;
  baseline: SemanticAuthorityEvidenceBaseline | null;
  preIdentity: ProjectionIdentity | null;
}

async function runPreflight(context: RolloutContext): Promise<PreflightOutcome> {
  const checks: string[] = [];
  const blockers: string[] = [];
  let identity: LinkedProjectIdentity | null = null;
  let inventory: MigrationInventoryReport | null = null;
  let columns: string[] | null = null;
  let baseline: SemanticAuthorityEvidenceBaseline | null = null;
  let preIdentity: ProjectionIdentity | null = null;
  let sqlBytes = 0;

  const migrationBytes = readMigrationBytes(context.rootDir);
  sqlBytes = migrationBytes.length;
  const migration = { version: MIGRATION_VERSION, path: MIGRATION_PATH, sha256: MIGRATION_SHA256, sqlBytes };

  try {
    identity = readLinkedProjectIdentity(context.rootDir);
    checks.push("linked_identity");
  } catch (error) {
    blockers.push(`linked_identity:${message(error)}`);
  }

  try {
    assertMigrationSha256(migrationBytes);
    checks.push("migration_sha256");
  } catch (error) {
    blockers.push(`migration_sha256:${message(error)}`);
  }

  let directRemoteVersions: string[] = [];
  try {
    directRemoteVersions = parseSchemaMigrationRows(await queryRows(context, SCHEMA_MIGRATIONS_SQL));
  } catch (error) {
    blockers.push(`schema_migrations:${message(error)}`);
  }

  let cliRemoteVersions: string[] | null = null;
  let cliReliable = false;
  try {
    cliRemoteVersions = parseSupabaseMigrationList(await context.cliMigrationList()).remote;
    cliReliable = true;
  } catch {
    cliRemoteVersions = null;
    cliReliable = false;
  }

  if (directRemoteVersions.length > 0 || cliReliable) {
    try {
      inventory = buildMigrationInventory({
        localVersions: readLocalMigrationVersions(context.rootDir),
        directRemoteVersions,
        cliRemoteVersions,
        cliReliable,
      });
      assertPendingSetIsExactlyTarget(inventory);
      if (cliReliable && !inventory.crossCheckReliable) {
        blockers.push("inventory_cross_check_unreliable:the direct and CLI remote migration ledgers disagree");
      } else {
        checks.push("remote_target_absent");
        checks.push("pending_set_exact");
      }
    } catch (error) {
      blockers.push(`pending_set_exact:${message(error)}`);
    }
  } else {
    blockers.push("schema_migrations:the remote migration ledger could not be read");
  }

  try {
    columns = parseProjectionColumnRows(await queryRows(context, PROJECTION_COLUMNS_SQL));
    assertProjectionColumns(columns);
    checks.push("projection_columns");
  } catch (error) {
    blockers.push(`projection_columns:${message(error)}`);
  }

  try {
    const audit = parseSemanticProvenanceAuditRow((await queryRows(context, PROVENANCE_COUNTS_SQL))[0] ?? {});
    const counts = provenanceCountsFromAudit(audit);
    const evaluation = evaluateProvenanceBaseline(counts, { allowLiveBaseline: context.allowLiveBaseline });
    baseline = {
      allowLiveBaseline: context.allowLiveBaseline,
      currentPublishedRows: counts.currentPublishedRows,
      projectionRows: counts.projectionRows,
      projectionEmbeddingNullCount: counts.projectionEmbeddingNullCount,
      artifactBackedCurrentPublishedRows: counts.artifactBackedCurrentPublishedRows,
      legacyVersionEmbeddingOnlyCount: counts.legacyVersionEmbeddingOnlyCount,
      totalMismatchCount: counts.totalMismatchCount,
    };
    if (evaluation.ok) checks.push("provenance_baseline");
    else for (const blocker of evaluation.blockers) blockers.push(`provenance_baseline:${blocker.code}:${blocker.detail}`);
  } catch (error) {
    blockers.push(`provenance_baseline:${message(error)}`);
  }

  try {
    preIdentity = parseProjectionIdentityRow((await queryRows(context, PROJECTION_IDENTITY_SQL))[0] ?? {});
    checks.push("projection_identity");
  } catch (error) {
    blockers.push(`projection_identity:${message(error)}`);
  }

  const orderedChecks = PREFLIGHT_CHECK_ORDER.filter((check) => checks.includes(check));
  return {
    ok: blockers.length === 0,
    checks: orderedChecks,
    blockers,
    identity,
    inventory,
    migration,
    columns,
    baseline,
    preIdentity,
  };
}

function smokeRpcSql(caseDef: (typeof SEMANTIC_AUTHORITY_SMOKE_CASES)[number]): string {
  const args: string[] = [
    `p_query => ${renderSqlLiteral(caseDef.query)}`,
    `p_mode => ${renderSqlLiteral(caseDef.mode)}`,
    `p_limit => ${renderSqlLiteral(caseDef.limit)}`,
    `p_offset => 0`,
    `p_range => 'latest'`,
    `p_count => 'none'`,
    `p_query_embedding => (select e.embedding from public.article_publications_p3 p ` +
      `join public.article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id ` +
      `join public.article_embedding_artifacts e on e.article_version_id = v.id and e.article_id = p.article_id and e.content_hash = v.content_hash ` +
      `where p.state = 'published' and p.article_id = ${renderSqlLiteral(caseDef.vectorId)} limit 1)`,
  ];
  return `select public.worldcons_ranked_search_page_v1(${args.join(", ")}) as page`;
}

async function runSmoke(context: RolloutContext): Promise<SemanticAuthoritySmokeReport> {
  const results: SemanticAuthoritySmokeCaseResult[] = [];
  for (const caseDef of SEMANTIC_AUTHORITY_SMOKE_CASES) {
    let productionSemanticEligible = false;
    let pageRetrieved = false;
    let topIds: string[] = [];
    try {
      const eligibleRows = await queryRows(
        context,
        `select (embedding is not null) as eligible from public.public_article_projection_p3 ` +
          `where id = ${renderSqlLiteral(caseDef.vectorId)} limit 1`,
      );
      productionSemanticEligible = eligibleRows[0]?.eligible === true;
      const pageRows = await queryRows(context, smokeRpcSql(caseDef));
      const page = pageRows[0]?.page;
      if (typeof page === "object" && page !== null && !Array.isArray(page)) {
        pageRetrieved = true;
        const entries = Array.isArray((page as Record<string, unknown>).entries)
          ? ((page as Record<string, unknown>).entries as unknown[])
          : [];
        topIds = entries
          .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
          .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
          .filter((id) => id.length > 0)
          .slice(0, caseDef.limit);
      }
    } catch {
      pageRetrieved = false;
    }
    results.push({ caseId: caseDef.id, mode: caseDef.mode, productionSemanticEligible, pageRetrieved, topIds });
  }
  return evaluateSemanticAuthoritySmoke(results);
}

interface PostApplyOutcome {
  validation: PostApplyValidationResult;
  columns: string[];
  postIdentity: ProjectionIdentity;
  counts: SemanticAuthorityEvidenceBaseline;
  smoke: SemanticAuthoritySmokeReport;
}

async function runPostApply(context: RolloutContext, preflight: PreflightOutcome): Promise<PostApplyOutcome> {
  const columns = parseProjectionColumnRows(await queryRows(context, PROJECTION_COLUMNS_SQL));
  const postIdentity = parseProjectionIdentityRow((await queryRows(context, PROJECTION_IDENTITY_SQL))[0] ?? {});
  const audit = parseSemanticProvenanceAuditRow((await queryRows(context, PROVENANCE_COUNTS_SQL))[0] ?? {});
  const counts = provenanceCountsFromAudit(audit);
  const smoke = await runSmoke(context);
  const validation = evaluatePostApplyValidation({
    preColumns: preflight.columns ?? [],
    postColumns: columns,
    preIdentity: preflight.preIdentity ?? { count: -1, digest: "00000000000000000000000000000000" },
    postIdentity,
    counts,
    smokeOracleDrift: smoke.oracleDrift,
  });
  return {
    validation,
    columns,
    postIdentity,
    counts: {
      allowLiveBaseline: context.allowLiveBaseline,
      currentPublishedRows: counts.currentPublishedRows,
      projectionRows: counts.projectionRows,
      projectionEmbeddingNullCount: counts.projectionEmbeddingNullCount,
      artifactBackedCurrentPublishedRows: counts.artifactBackedCurrentPublishedRows,
      legacyVersionEmbeddingOnlyCount: counts.legacyVersionEmbeddingOnlyCount,
      totalMismatchCount: counts.totalMismatchCount,
    },
    smoke,
  };
}

function assembleEvidence(input: {
  now: string;
  mode: RolloutMode;
  status: SemanticAuthorityEvidence["status"];
  preflight: PreflightOutcome;
  postApply: PostApplyOutcome | null;
  history: SemanticAuthorityEvidenceHistory | null;
}): SemanticAuthorityEvidence {
  if (!input.preflight.identity || !input.preflight.inventory || !input.preflight.baseline || !input.preflight.preIdentity) {
    throw new Error("cannot assemble evidence from an incomplete preflight");
  }
  const postApply = input.postApply;
  return buildSemanticAuthorityEvidence({
    generatedAt: input.now,
    mode: input.mode,
    status: input.status,
    migration: input.preflight.migration,
    identity: { projectRef: input.preflight.identity.ref, projectName: input.preflight.identity.name },
    inventory: {
      targetVersion: input.preflight.inventory.targetVersion,
      pendingVersions: input.preflight.inventory.pendingVersions,
      targetAbsent: input.preflight.inventory.targetAbsent,
      pendingSetExact: input.preflight.inventory.pendingSetExact,
      crossCheckReliable: input.preflight.inventory.crossCheckReliable,
    },
    preflight: { mode: "preflight", ok: input.preflight.ok, checks: input.preflight.checks, blockers: input.preflight.blockers },
    baseline: input.preflight.baseline,
    preIdentity: input.preflight.preIdentity,
    postIdentity: postApply?.postIdentity ?? null,
    postApply: postApply
      ? {
          applied: true,
          columnsUnchanged: input.preflight.columns !== null &&
            input.preflight.columns.every((column, index) => postApply.columns[index] === column) &&
            input.preflight.columns.length === postApply.columns.length,
          projectionEmbeddingNullCount: postApply.counts.projectionEmbeddingNullCount,
          rowCountUnchanged: input.preflight.preIdentity.count === postApply.postIdentity.count,
          idDigestUnchanged: input.preflight.preIdentity.digest === postApply.postIdentity.digest,
          smokeOracleDrift: postApply.smoke.oracleDrift,
          ok: postApply.validation.ok,
          blockers: postApply.validation.blockers.map((blocker) => blocker.code),
        }
      : null,
    smoke: postApply
      ? { cases: postApply.smoke.cases, compared: postApply.smoke.compared, oracleDrift: postApply.smoke.oracleDrift, pass: postApply.smoke.pass }
      : null,
    history: input.history,
  });
}

/**
 * Writes the LOCAL content-free evidence artifact. This never mutates Supabase:
 * it is the local `--report` surface, deliberately separate from
 * `--record-history` (which repairs the remote migration ledger).
 */
function writeEvidence(rootDir: string, evidence: SemanticAuthorityEvidence): void {
  assertContentFreeEvidence(evidence);
  const jsonPath = path.join(rootDir, SEMANTIC_AUTHORITY_EVIDENCE_PATH);
  const markdownPath = path.join(rootDir, SEMANTIC_AUTHORITY_EVIDENCE_MARKDOWN_PATH);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderSemanticAuthorityEvidenceMarkdown(evidence), "utf8");
}

interface ApplyHistoryOutcome {
  history: SemanticAuthorityEvidenceHistory;
  historyRepairFailed: boolean;
  repairAttempted: boolean;
  repairError: string | null;
}

/**
 * The post-apply migration-ledger reconciliation. It is invoked ONLY when the
 * operator passed `--record-history`, the exact migration SQL already committed
 * and every post-apply validation/smoke gate passed (enforced by
 * `assertHistoryRepairEligible`). It runs exactly
 * `supabase migration repair --linked --status applied 20260926120000`, re-reads
 * `supabase_migrations.schema_migrations` (with an optional CLI cross-check),
 * verifies the target is applied and records the content-free history state. A
 * failed command or an unverified ledger reports `history_repair_failed`; the
 * schema is never rolled back automatically.
 */
async function runApplyHistory(
  context: RolloutContext,
  input: { recordHistory: boolean; postApplyOk: boolean },
): Promise<ApplyHistoryOutcome> {
  let repairAttempted = false;
  let repairExitOk = false;
  let repairError: string | null = null;

  if (input.recordHistory && input.postApplyOk) {
    assertHistoryRepairEligible({ exactSqlApplied: true, postApplyOk: true });
    repairAttempted = true;
    try {
      const repairArgs = buildMigrationRepairArgs(MIGRATION_VERSION);
      assertMigrationRepairInvocation(repairArgs);
      await runSupabaseCli(repairArgs, "supabase migration repair");
      repairExitOk = true;
    } catch (error) {
      repairError = message(error);
    }
  }

  const ledger = await readLedger(context);
  const verification = verifyHistoryRepair({
    targetVersion: MIGRATION_VERSION,
    localVersions: readLocalMigrationVersions(context.rootDir),
    directRemoteVersions: ledger.direct,
    cliRemoteVersions: ledger.cli,
    cliReliable: ledger.cliReliable,
  });
  const evaluation = evaluateHistoryRepair({ repairExitOk, verification });
  return {
    history: {
      historyRecorded: evaluation.historyRecorded,
      historyVerified: evaluation.historyVerified,
      targetVersion: MIGRATION_VERSION,
      applied: verification.applied,
      pendingVersions: verification.pendingVersions,
    },
    historyRepairFailed: repairAttempted && !evaluation.ok,
    repairAttempted,
    repairError,
  };
}

interface FinalizeExistingOutcome {
  ok: boolean;
  checks: string[];
  blockers: string[];
  identity: LinkedProjectIdentity | null;
  inventory: MigrationInventoryReport | null;
  columns: string[] | null;
  counts: ProvenanceCounts | null;
  postIdentity: ProjectionIdentity | null;
  smoke: SemanticAuthoritySmokeReport | null;
  history: SemanticAuthorityEvidenceHistory;
  sqlBytes: number;
}

/**
 * The read-only `--finalize-existing` path for an already-applied schema+ledger
 * state. It NEVER executes migration SQL and NEVER runs `migration repair`: it
 * only re-reads the remote ledger, the live column order, the counts-only
 * provenance audit and the content-free projection identity, then runs the
 * existing bounded semantic/hybrid smoke. Every value it reads is a `select`;
 * the only writes on this path are the LOCAL evidence files the caller writes.
 */
async function runFinalizeExisting(context: RolloutContext): Promise<FinalizeExistingOutcome> {
  const migrationBytes = readMigrationBytes(context.rootDir);
  const sqlBytes = migrationBytes.length;
  const readChecks: string[] = [];
  const readBlockers: string[] = [];
  let identity: LinkedProjectIdentity | null = null;
  let inventory: MigrationInventoryReport | null = null;
  let columns: string[] | null = null;
  let counts: ProvenanceCounts | null = null;
  let postIdentity: ProjectionIdentity | null = null;
  let smoke: SemanticAuthoritySmokeReport | null = null;
  let verification: HistoryRepairVerification | null = null;

  try {
    identity = readLinkedProjectIdentity(context.rootDir);
    readChecks.push("linked_identity");
  } catch (error) {
    readBlockers.push(`linked_identity:${message(error)}`);
  }
  try {
    assertMigrationSha256(migrationBytes);
    readChecks.push("migration_sha256");
  } catch (error) {
    readBlockers.push(`migration_sha256:${message(error)}`);
  }

  const ledger = await readLedger(context);
  try {
    const localVersions = readLocalMigrationVersions(context.rootDir);
    inventory = buildMigrationInventory({
      localVersions,
      directRemoteVersions: ledger.direct,
      cliRemoteVersions: ledger.cli,
      cliReliable: ledger.cliReliable,
    });
    verification = verifyHistoryRepair({
      targetVersion: MIGRATION_VERSION,
      localVersions,
      directRemoteVersions: ledger.direct,
      cliRemoteVersions: ledger.cli,
      cliReliable: ledger.cliReliable,
    });
  } catch (error) {
    readBlockers.push(`schema_migrations:${message(error)}`);
  }

  try {
    columns = parseProjectionColumnRows(await queryRows(context, PROJECTION_COLUMNS_SQL));
  } catch {
    columns = null;
  }
  try {
    const audit = parseSemanticProvenanceAuditRow((await queryRows(context, PROVENANCE_COUNTS_SQL))[0] ?? {});
    counts = provenanceCountsFromAudit(audit);
  } catch {
    counts = null;
  }
  try {
    postIdentity = parseProjectionIdentityRow((await queryRows(context, PROJECTION_IDENTITY_SQL))[0] ?? {});
  } catch {
    postIdentity = null;
  }
  try {
    smoke = await runSmoke(context);
  } catch {
    smoke = null;
  }

  const history: SemanticAuthorityEvidenceHistory = {
    historyRecorded: verification?.applied === true,
    historyVerified: verification?.verified === true,
    targetVersion: MIGRATION_VERSION,
    applied: verification?.applied === true,
    pendingVersions: verification ? [...verification.pendingVersions] : [MIGRATION_VERSION],
  };

  const evaluation = evaluateFinalizeExistingState({
    columns,
    identity: postIdentity,
    counts,
    smoke,
    targetApplied: verification?.applied === true,
    cliCrossCheckOk: verification ? verification.cliCrossCheck : null,
    pendingVersions: verification ? verification.pendingVersions : null,
  });

  const checks = FINALIZE_EXISTING_CHECK_ORDER.filter(
    (check) => readChecks.includes(check) || evaluation.checks.includes(check),
  );
  const blockers = [...readBlockers, ...evaluation.blockers.map((blocker) => `${blocker.code}:${blocker.detail}`)];
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
    identity,
    inventory,
    columns,
    counts,
    postIdentity,
    smoke,
    history,
    sqlBytes,
  };
}

/**
 * Assembles the content-free finalize-existing evidence. It marks
 * `recoveredExistingState=true` / `preIdentityAvailable=false` and carries a null
 * `preIdentity` with null `rowCountUnchanged`/`idDigestUnchanged`, so no
 * pre-apply digest equality is ever fabricated. `historyRecorded`/`historyVerified`
 * are true only because the direct ledger re-read proves the target applied.
 */
function assembleFinalizeExistingEvidence(
  context: RolloutContext,
  outcome: FinalizeExistingOutcome,
): SemanticAuthorityEvidence {
  if (!outcome.identity) throw new Error("cannot assemble finalize-existing evidence without a linked identity");
  const counts = outcome.counts;
  return buildSemanticAuthorityEvidence({
    generatedAt: context.now,
    mode: "finalize-existing",
    status: outcome.ok ? "applied" : "blocked",
    recoveredExistingState: true,
    preIdentityAvailable: false,
    migration: { version: MIGRATION_VERSION, path: MIGRATION_PATH, sha256: MIGRATION_SHA256, sqlBytes: outcome.sqlBytes },
    identity: { projectRef: outcome.identity.ref, projectName: outcome.identity.name },
    inventory: {
      targetVersion: MIGRATION_VERSION,
      pendingVersions: outcome.inventory ? [...outcome.inventory.pendingVersions] : [...outcome.history.pendingVersions],
      targetAbsent: outcome.inventory ? outcome.inventory.targetAbsent : !outcome.history.applied,
      pendingSetExact: outcome.inventory ? outcome.inventory.pendingSetExact : false,
      crossCheckReliable: outcome.inventory ? outcome.inventory.crossCheckReliable : false,
    },
    preflight: { mode: "preflight", ok: outcome.ok, checks: outcome.checks, blockers: outcome.blockers },
    baseline: {
      allowLiveBaseline: context.allowLiveBaseline,
      currentPublishedRows: counts?.currentPublishedRows ?? -1,
      projectionRows: counts?.projectionRows ?? -1,
      projectionEmbeddingNullCount: counts?.projectionEmbeddingNullCount ?? -1,
      artifactBackedCurrentPublishedRows: counts?.artifactBackedCurrentPublishedRows ?? -1,
      legacyVersionEmbeddingOnlyCount: counts?.legacyVersionEmbeddingOnlyCount ?? -1,
      totalMismatchCount: counts?.totalMismatchCount ?? -1,
    },
    preIdentity: null,
    postIdentity: outcome.postIdentity,
    postApply: {
      applied: outcome.history.applied,
      columnsUnchanged: outcome.checks.includes("projection_columns"),
      projectionEmbeddingNullCount: counts?.projectionEmbeddingNullCount ?? -1,
      rowCountUnchanged: null,
      idDigestUnchanged: null,
      smokeOracleDrift: outcome.smoke?.oracleDrift ?? -1,
      ok: outcome.ok,
      blockers: outcome.blockers,
    },
    smoke: outcome.smoke
      ? { cases: outcome.smoke.cases, compared: outcome.smoke.compared, oracleDrift: outcome.smoke.oracleDrift, pass: outcome.smoke.pass }
      : null,
    history: outcome.history,
  });
}

function dryRunPlan(context: RolloutContext): Record<string, unknown> {
  const bytes = readMigrationBytes(context.rootDir);
  const plan = summarizeSemanticAuthorityApplyPlan(planSemanticAuthorityApply(bytes));
  return {
    event: "m7.8a_semantic_authority_rollout",
    mode: "dry-run",
    connected: false,
    migration: plan.migration,
    apply: { binary: plan.command.binary, tooling: plan.command.tooling, explicit: plan.explicit, preflightRequired: plan.preflightRequired },
    preflightChecks: [...PREFLIGHT_CHECK_ORDER],
    readOnlySql: {
      schema_migrations: SCHEMA_MIGRATIONS_SQL,
      projection_columns: PROJECTION_COLUMNS_SQL,
      projection_identity: PROJECTION_IDENTITY_SQL,
      provenance_counts: PROVENANCE_COUNTS_SQL,
    },
    smokeCases: SEMANTIC_AUTHORITY_SMOKE_CASES.map((caseDef) => ({ id: caseDef.id, mode: caseDef.mode, limit: caseDef.limit })),
  };
}

async function main(): Promise<number> {
  const args = parseRolloutArgs(process.argv.slice(2));
  const context: RolloutContext = {
    runner: createSupabaseLinkedQueryRunner(),
    rootDir: process.cwd(),
    now: new Date().toISOString(),
    allowLiveBaseline: args.allowLiveBaseline,
    cliMigrationList: () => runSupabaseCli(MIGRATION_LIST_ARGS, "supabase migration list"),
  };

  // `--record-history` is a post-apply-only ledger reconciliation; reject it in
  // every other mode before any tool runs, so preflight/dry-run/smoke can never
  // mutate migration history.
  assertRecordHistoryScope(args.mode, args.recordHistory);

  // A successful `--apply` writes evidence by default; preflight/smoke write it
  // only on explicit `--report`. This is the LOCAL evidence surface, distinct from
  // the remote ledger repair below.
  const wantsEvidence = args.report || args.mode === "apply";

  if (args.mode === "dry-run") {
    if (args.report) throw new Error("--report has no evidence to write in --dry-run mode");
    output(dryRunPlan(context));
    return 0;
  }

  if (args.mode === "smoke") {
    if (args.report) throw new Error("--report is not available with --smoke");
    const smoke = await runSmoke(context);
    output({ event: "m7.8a_semantic_authority_rollout", mode: "smoke", ...smoke });
    return smoke.pass ? 0 : 1;
  }

  if (args.mode === "finalize-existing") {
    const outcome = await runFinalizeExisting(context);
    if (outcome.identity) {
      const evidence = assembleFinalizeExistingEvidence(context, outcome);
      writeEvidence(context.rootDir, evidence);
    }
    output({
      event: "m7.8a_semantic_authority_rollout",
      mode: "finalize-existing",
      ok: outcome.ok,
      readOnly: true,
      recoveredExistingState: true,
      preIdentityAvailable: false,
      checks: outcome.checks,
      blockers: outcome.blockers,
      targetVersion: MIGRATION_VERSION,
      historyRecorded: outcome.history.historyRecorded,
      historyVerified: outcome.history.historyVerified,
      ledgerApplied: outcome.history.applied,
      ledgerPending: outcome.history.pendingVersions,
      smokeOracleDrift: outcome.smoke?.oracleDrift ?? null,
      postIdentity: outcome.postIdentity,
    });
    return outcome.ok ? 0 : 1;
  }

  const preflight = await runPreflight(context);
  if (args.mode === "preflight") {
    if (wantsEvidence && preflight.ok) {
      const evidence = assembleEvidence({
        now: context.now,
        mode: "preflight",
        status: "preflight_ready",
        preflight,
        postApply: null,
        history: null,
      });
      writeEvidence(context.rootDir, evidence);
    }
    output({
      event: "m7.8a_semantic_authority_rollout",
      mode: "preflight",
      ok: preflight.ok,
      checks: preflight.checks,
      blockers: preflight.blockers,
      historyMutated: false,
    });
    return preflight.ok ? 0 : 1;
  }

  // mode === "apply"
  if (!preflight.ok) {
    output({ event: "m7.8a_semantic_authority_rollout", mode: "apply", ok: false, blockers: preflight.blockers });
    return 1;
  }
  assertApplyGate({ apply: true, dryRun: false, preflightPassed: preflight.ok });
  const migrationSql = readMigrationBytes(context.rootDir).toString("utf8");
  planSemanticAuthorityApply(migrationSql);
  await context.runner(migrationSql);
  const postApply = await runPostApply(context, preflight);

  // Ledger repair is attempted ONLY after the exact-SQL apply committed AND every
  // post-apply validation/smoke gate passed. On a validation failure it is
  // skipped (never repaired) and the schema is left in place; no auto-rollback.
  const historyOutcome = await runApplyHistory(context, {
    recordHistory: args.recordHistory,
    postApplyOk: postApply.validation.ok,
  });

  const blockers: string[] = postApply.validation.blockers.map((blocker) => blocker.code);
  if (historyOutcome.historyRepairFailed) blockers.push("history_repair_failed");
  const ok = postApply.validation.ok && !historyOutcome.historyRepairFailed;

  const evidence = assembleEvidence({
    now: context.now,
    mode: "apply",
    status: postApply.validation.ok ? "applied" : "blocked",
    preflight,
    postApply,
    history: historyOutcome.history,
  });
  writeEvidence(context.rootDir, evidence);

  output({
    event: "m7.8a_semantic_authority_rollout",
    mode: "apply",
    ok,
    blockers,
    smokeOracleDrift: postApply.smoke.oracleDrift,
    historyRecorded: historyOutcome.history.historyRecorded,
    historyVerified: historyOutcome.history.historyVerified,
    historyRepairFailed: historyOutcome.historyRepairFailed,
    targetVersion: historyOutcome.history.targetVersion,
    ledgerApplied: historyOutcome.history.applied,
    ledgerPending: historyOutcome.history.pendingVersions,
  });
  return ok ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    output({ event: "m7.8a_semantic_authority_rollout_failed", error: message(error), readOnly: true });
    process.exitCode = 1;
  });
