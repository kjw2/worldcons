import {
  D1_REMOTE_RECONCILE_DATABASES,
  buildD1RemoteReconcileManifest,
  type BuildD1RemoteReconcileManifestOptions,
  type D1RemoteReconcileManifest,
  type D1RemoteReconcileManifestTarget,
  type D1RemoteReconcileTableTarget,
} from "@/lib/cloudflare/d1/remote/reconcile";
import type { D1Database } from "@/lib/cloudflare/d1/types";

/**
 * M13 final Supabase -> D1 delta verification.
 *
 * M5.2d already ships the bounded, never-delete reconcile operator
 * (`buildD1RemoteReconcileManifest`): plain INSERTs for source-only rows,
 * full-row parameterized UPDATEs for changed common primary keys, a hard refusal
 * on any remote-only primary key, and a post-apply re-read that must match the
 * fresh source on row count AND canonical full-table hash. M13 does not
 * re-implement that. It adds a deterministic, content-free *final gate* over the
 * exact same infrastructure so the orchestrator can answer one question before
 * the permanent D1 switch:
 *
 *   "Is the whole Supabase -> D1 delta across worldcons_ops, worldcons_ingest
 *    and worldcons_core exactly zero (or, in dry-run, exactly planable), with no
 *    table refused and no remote-only row?"
 *
 * Rules, enforced here and by the delegated builder:
 *
 * - never DELETE: the delegated reconcile contains no delete/truncate/replace;
 *   an M13 final-delta run additionally forces `apply:false` and refuses to
 *   finalize a manifest whose targets show any remote-only row;
 * - hash/invariant checks: the manifest's per-table `expectedHash`/`remoteHash`
 *   and `verified` flags are the invariant surface; M13 surfaces a table as
 *   `exact` only when the canonical hash equality holds;
 * - fail closed: a `refused`/`unknown` table, a remote-only row, or a non-`exact`
 *   dry-run plan is a blocker, never a silent pass.
 */

/** The exact relational databases the final delta covers. `worldcons_search` is
 * rebuildable and intentionally excluded. */
export const M13_FINAL_DELTA_DATABASES: readonly D1Database[] = D1_REMOTE_RECONCILE_DATABASES;

/**
 * The mutable-drift tables that earlier M11/M5.2d work explicitly identified as
 * the known historical deltas. This is reference metadata for the readiness
 * report; the final-delta verifier deliberately scans EVERY migratable table in
 * the three databases rather than trusting this list, so a newly drifted table
 * can never be missed.
 */
export const M13_RECONCILE_KNOWN_DRIFT_TABLES: Readonly<Record<string, readonly string[]>> = {
  worldcons_ops: ["admin_ops_events", "ops_workflow_heartbeats", "admin_audit_logs", "site_events"],
  worldcons_ingest: ["ingestion_runs"],
  worldcons_core: ["articles", "tags", "article_tags", "glossary_candidates"],
} as const;

export interface M13FinalDeltaTableResult {
  database: D1Database;
  table: string;
  state: D1RemoteReconcileTableTarget["state"];
  expectedRowCount: number;
  remoteRowCount: number;
  remoteOnlyRowCount: number;
  insertRowCount: number;
  updateRowCount: number;
  /** True only when the table is `exact` and the canonical hashes were read. */
  hashVerified: boolean;
  /** True when the per-table canonical hash equality held. */
  hashMatches: boolean;
  /** The upstream M5.2d per-table `verified` flag. */
  verified: boolean;
  errors: string[];
}

export interface M13FinalDeltaBlocker {
  code:
    | "postgres_source_unconfigured"
    | "table_refused"
    | "table_unknown"
    | "table_unverified"
    | "table_errors"
    | "remote_only_rows"
    | "pending_inserts"
    | "pending_updates"
    | "database_refused";
  database: D1Database;
  table: string | null;
  detail: string;
}

export interface M13FinalDeltaReport {
  /** The three databases the run covered. */
  databases: readonly D1Database[];
  dryRun: boolean;
  /** True only when every table is `exact` and every hash invariant holds. */
  deltaClear: boolean;
  tableCount: number;
  exactCount: number;
  /** Total remote-only primary keys observed (must be 0). */
  remoteOnlyTotal: number;
  /** Total rows a dry-run would need to INSERT to close the delta. */
  pendingInsertTotal: number;
  /** Total rows a dry-run would need to UPDATE to close the delta. */
  pendingUpdateTotal: number;
  tables: M13FinalDeltaTableResult[];
  blockers: M13FinalDeltaBlocker[];
  /** The underlying M5.2d manifest's `ok` flag. */
  upstreamOk: boolean;
  upstreamErrors: string[];
}

function tableResult(target: D1RemoteReconcileManifestTarget, table: D1RemoteReconcileTableTarget): M13FinalDeltaTableResult {
  const hashRead = table.remoteHash !== null && table.expectedHash.length > 0;
  const hashMatches = hashRead && table.remoteHash === table.expectedHash;
  return {
    database: target.name,
    table: table.table,
    state: table.state,
    expectedRowCount: table.expectedRowCount,
    remoteRowCount: table.remoteRowCount,
    remoteOnlyRowCount: table.remoteOnlyRowCount,
    insertRowCount: table.insertRowCount,
    updateRowCount: table.updateRowCount,
    hashVerified: hashRead,
    hashMatches,
    verified: table.verified,
    errors: [...table.errors],
  };
}

/**
 * Reduces one M5.2d reconcile manifest into the M13 final-delta verdict. Pure and
 * deterministic: identical manifests produce identical reports. It never
 * mutates and never claims `deltaClear` unless every table is `exact` with a
 * matching canonical hash and zero remote-only rows.
 */
export function evaluateM13FinalDelta(manifest: D1RemoteReconcileManifest): M13FinalDeltaReport {
  const tables: M13FinalDeltaTableResult[] = [];
  const blockers: M13FinalDeltaBlocker[] = [];

  for (const target of manifest.targets) {
    if (target.action === "refused" && target.tables.length === 0) {
      blockers.push({ code: "database_refused", database: target.name, table: null, detail: `database ${target.name} was refused with no table detail` });
    }
    for (const table of target.tables) {
      const result = tableResult(target, table);
      tables.push(result);
      if (result.remoteOnlyRowCount > 0) {
        blockers.push({
          code: "remote_only_rows",
          database: target.name,
          table: table.table,
          detail: `${result.remoteOnlyRowCount} remote-only primary key(s); reconciliation never deletes`,
        });
      }
      if (!table.verified) {
        blockers.push({
          code: "table_unverified",
          database: target.name,
          table: table.table,
          detail: `table ${table.table} is not verified (state ${table.state}); a hash/state match is not sufficient`,
        });
      }
      if (table.errors.length > 0) {
        for (const error of table.errors) {
          blockers.push({ code: "table_errors", database: target.name, table: table.table, detail: error });
        }
      }
      if (table.state === "refused") {
        for (const error of table.errors) {
          blockers.push({ code: "table_refused", database: target.name, table: table.table, detail: error });
        }
      } else if (table.state === "unknown") {
        for (const error of table.errors) {
          blockers.push({ code: "table_unknown", database: target.name, table: table.table, detail: error });
        }
      } else if (table.state === "insert-only" || table.state === "mixed") {
        blockers.push({
          code: "pending_inserts",
          database: target.name,
          table: table.table,
          detail: `${result.insertRowCount} source-only row(s) are not yet present in D1`,
        });
      } else if (table.state === "update-only") {
        blockers.push({
          code: "pending_updates",
          database: target.name,
          table: table.table,
          detail: `${result.updateRowCount} common primary key row(s) differ from the source`,
        });
      }
    }
  }

  if (!manifest.ok && !manifest.targets.some((target) => target.tables.length > 0)) {
    blockers.push({
      code: "postgres_source_unconfigured",
      database: "worldcons_core",
      table: null,
      detail: manifest.errors[0] ?? "the read-only Postgres source was not configured",
    });
  }

  const remoteOnlyTotal = tables.reduce((total, table) => total + table.remoteOnlyRowCount, 0);
  const pendingInsertTotal = tables.reduce((total, table) => total + table.insertRowCount, 0);
  const pendingUpdateTotal = tables.reduce((total, table) => total + table.updateRowCount, 0);
  const exactCount = tables.filter((table) => table.state === "exact" && table.hashMatches && table.verified && table.errors.length === 0).length;
  const deltaClear =
    tables.length > 0
    && blockers.length === 0
    && exactCount === tables.length
    && remoteOnlyTotal === 0
    && pendingInsertTotal === 0
    && pendingUpdateTotal === 0;

  return {
    databases: M13_FINAL_DELTA_DATABASES,
    dryRun: manifest.dryRun,
    deltaClear,
    tableCount: tables.length,
    exactCount,
    remoteOnlyTotal,
    pendingInsertTotal,
    pendingUpdateTotal,
    tables,
    blockers,
    upstreamOk: manifest.ok,
    upstreamErrors: [...manifest.errors],
  };
}

/**
 * Builds the M13 final-delta manifest. Apply is forced off: M13 verification is
 * read-only by contract. The orchestrator closes any real delta with the
 * existing, separately authorized `pnpm d1:reconcile --apply --database=...`
 * operator, never from this path.
 */
export async function buildM13FinalDeltaManifest(
  options: Omit<BuildD1RemoteReconcileManifestOptions, "apply" | "databases"> & {
    databases?: readonly D1Database[];
  },
): Promise<{ manifest: D1RemoteReconcileManifest; report: M13FinalDeltaReport }> {
  const manifest = await buildD1RemoteReconcileManifest({
    ...options,
    apply: false,
    databases: options.databases ?? M13_FINAL_DELTA_DATABASES,
  });
  return { manifest, report: evaluateM13FinalDelta(manifest) };
}
