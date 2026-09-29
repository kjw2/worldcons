import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { createSupabaseLinkedRowSource } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { buildM13FinalDeltaManifest } from "@/lib/cloudflare/m13/final-delta";
import { evaluateM13FinalDeltaFromManifestFiles } from "@/lib/cloudflare/m13/delta-manifest-evidence";
import {
  M13_AUTHORITY_PROFILE_ENV,
  buildM13AuthorityEnvProfile,
  resolveM13AuthorityProfile,
} from "@/lib/cloudflare/m13/authority-profile";
import {
  buildM13AuthoritySummary,
  emptyM13GovernanceEvidence,
  evaluateM13Readiness,
  type M13DrRehearsalEvidence,
  type M13GovernanceEvidence,
  type M13ObservationEvidence,
  type M13P5RetirementEvidence,
  type M13SearchReadinessEvidence,
} from "@/lib/cloudflare/m13/readiness";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { createLazyRemoteQuery, resolveReadFallbackPolicy } from "./d1-reconcile";

const REPORT_PATH = path.join("artifacts", "cloudflare-m13", "m13-readiness-evidence.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * M13 read-only retirement readiness/evidence command.
 *
 *   pnpm m13:readiness --json
 *   pnpm m13:readiness --profile=d1 --json
 *   pnpm m13:readiness --emit-authority-env
 *   pnpm m13:readiness --source=supabase-linked --observation-start=<iso> --observation-end=<iso> --json
 *   pnpm m13:readiness --delta-manifests=<core.json>,<ingest.json>,<ops.json> --json
 *
 * It is strictly READ-ONLY: it never writes to Supabase, D1, R2, Vercel, the
 * Worker or any remote resource. `--emit-authority-env` prints the exact
 * per-domain values a permanent switch or rollback would use; it does not apply
 * them. The final-delta leg is only run when an explicit `--source=` is given
 * (forced dry-run), and it is mutually exclusive with `--delta-manifests=`.
 * After the permanent D1 cutover, use the immutable PRE-SWITCH raw reconcile
 * manifests via `--delta-manifests=` instead of a live parity re-run against the
 * now-authoritative D1, which diverges by design. It never claims
 * `readyForDestructiveRetirement` unless every machine gate passes AND the
 * caller supplies explicit human attestation flags for owner approvals,
 * legal/retention review and retirement approval.
 */

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function positiveIntegerArg(args: readonly string[], name: string): number | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function nonNegativeIntegerArg(args: readonly string[], name: string): number | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function listArg(args: readonly string[], name: string): string[] | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const items = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return items.length > 0 ? items : null;
}

function flag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function boundedReference(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 300);
}

function profileOverlay(args: readonly string[]): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env };
  const profileArg = argValue(args, "profile");
  if (profileArg !== null) environment[M13_AUTHORITY_PROFILE_ENV] = profileArg;
  return environment;
}

function buildObservation(args: readonly string[], minimumHours: number): M13ObservationEvidence | null {
  const start = argValue(args, "observation-start");
  const end = argValue(args, "observation-end");
  if (!start && !end) return null;
  const parsedStart = start ? new Date(start) : null;
  const parsedEnd = end ? new Date(end) : null;
  const valid = Boolean(parsedStart && parsedEnd && !Number.isNaN(parsedStart.getTime()) && !Number.isNaN(parsedEnd.getTime()) && parsedStart < parsedEnd);
  const hours = valid && parsedStart && parsedEnd ? (parsedEnd.getTime() - parsedStart.getTime()) / 3_600_000 : null;
  return {
    start: parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart.toISOString() : null,
    end: parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd.toISOString() : null,
    hours,
    minimumHours,
    verified: Boolean(valid && hours !== null && hours >= minimumHours),
    reference: boundedReference(argValue(args, "observation-reference")),
  };
}

function buildSearch(args: readonly string[]): M13SearchReadinessEvidence | null {
  const touched = ["search-fts-parity", "search-vectorize-parity", "search-stable", "search-reference"]
    .some((name) => args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)));
  if (!touched) return null;
  return {
    ftsParityPass: flag(args, "search-fts-parity"),
    vectorizeParityPass: flag(args, "search-vectorize-parity"),
    stable: flag(args, "search-stable"),
    reference: boundedReference(argValue(args, "search-reference")),
  };
}

function buildDrRehearsal(args: readonly string[]): M13DrRehearsalEvidence | null {
  if (!flag(args, "dr-passed") && !argValue(args, "dr-at")) return null;
  return {
    passed: flag(args, "dr-passed"),
    at: argValue(args, "dr-at"),
    reference: boundedReference(argValue(args, "dr-reference")),
    maxAgeHours: positiveIntegerArg(args, "dr-max-age-hours") ?? 720,
  };
}

async function buildP5Evidence(args: readonly string[]): Promise<M13P5RetirementEvidence | null> {
  if (!flag(args, "p5")) return null;
  try {
    const { getP5HealthEvidence } = await import("@/lib/admin/p5/repository");
    const { evaluateP5RetirementReadiness, P5_RETIREMENT_FLAG_ORDER } = await import("@/lib/admin/p5/evaluator");
    const start = argValue(args, "observation-start");
    const end = argValue(args, "observation-end");
    if (!start || !end) return { implementationStatus: "unknown", evidenceStatus: "unknown", ready: false, reference: null, gates: null };
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const policy = resolveP5OperationalPolicy();
    const evidence = await getP5HealthEvidence({ observationStart: startIso, observationEnd: endIso, policy });
    const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name]) => [name, process.env[name]?.trim().toLowerCase() === "true"]));
    const observationSampleRate = Number(process.env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0");
    const report = evaluateP5RetirementReadiness({
      evidence,
      policy,
      observationStart: startIso,
      observationEnd: endIso,
      flags,
      observationSampleRate,
      signingKey: process.env.ADMIN_P5_REPORT_SIGNING_KEY,
    });
    return {
      implementationStatus: report.implementationStatus,
      evidenceStatus: report.evidenceStatus,
      ready: report.ready,
      reference: boundedReference(argValue(args, "p5-reference")),
      gates: report.gates.map((gate) => ({ key: gate.key, passed: gate.passed })),
    };
  } catch {
    return { implementationStatus: "unknown", evidenceStatus: "unknown", ready: false, reference: null, gates: null };
  }
}

function buildGovernance(args: readonly string[]): M13GovernanceEvidence {
  const defaults = emptyM13GovernanceEvidence();
  const requiredRoles = listArg(args, "approvals-roles") ?? defaults.ownerApprovals.requiredRoles;
  return {
    ownerApprovals: {
      requiredRoles,
      approvedRoles: listArg(args, "approvals-approved-roles") ?? [],
      distinctActorCount: nonNegativeIntegerArg(args, "approvals-actors") ?? 0,
      attestation: flag(args, "approvals-attested"),
      reference: boundedReference(argValue(args, "approvals-reference")),
    },
    legalRetentionReview: {
      attestation: flag(args, "legal-attested"),
      reference: boundedReference(argValue(args, "legal-reference")),
    },
    retirementApproval: {
      attestation: flag(args, "retirement-attested"),
      reference: boundedReference(argValue(args, "retirement-reference")),
    },
  };
}

export function deltaManifestPaths(args: readonly string[]): string[] | null {
  const raw = argValue(args, "delta-manifests");
  if (raw === null) return null;
  const items = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (items.length === 0) throw new Error("--delta-manifests requires a comma-separated list of manifest file paths");
  return items;
}

/**
 * `--source=` (live read-only parity) and `--delta-manifests=` (immutable
 * PRE-SWITCH raw evidence) are mutually exclusive final-delta evidence inputs.
 * Supplying both is ambiguous and rejected rather than silently preferring one.
 */
export function assertDeltaEvidenceInputs(args: readonly string[]): void {
  const manifestPaths = deltaManifestPaths(args);
  const sourceArg = (argValue(args, "source") ?? "").trim();
  if (manifestPaths !== null && sourceArg !== "") {
    throw new Error("--source and --delta-manifests are mutually exclusive; use one final-delta evidence input");
  }
}

function createDeltaSource(args: readonly string[]): { source: PostgresRowSource; close: () => Promise<void> } | null {
  const kind = (argValue(args, "source") ?? "").trim();
  if (kind === "") return null;
  if (kind === "supabase-linked") {
    const source = createSupabaseLinkedRowSource({
      maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
      timeoutMs: positiveIntegerArg(args, "linked-timeout-ms") ?? undefined,
    });
    return { source, close: () => source.close() };
  }
  if (kind === "postgres") {
    const url = (argValue(args, "url") ?? process.env[SOURCE_URL_ENV_VAR] ?? "").trim();
    if (url.length === 0) throw new Error(`postgres export requires --url= or ${SOURCE_URL_ENV_VAR}`);
    const source = createPostgresRowSource({
      connectionString: url,
      sessionRole: argValue(args, "postgres-role") ?? undefined,
    });
    return { source, close: () => source.close() };
  }
  throw new Error(`unknown --source=${kind} (expected postgres|supabase-linked)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const environment = profileOverlay(args);
  const policy = resolveP5OperationalPolicy();

  if (flag(args, "emit-authority-env")) {
    const emission = {
      profile: resolveM13AuthorityProfile(environment),
      forward: buildM13AuthorityEnvProfile("d1"),
      rollback: buildM13AuthorityEnvProfile("supabase"),
      authority: buildM13AuthoritySummary(environment),
    };
    process.stdout.write(`${JSON.stringify(emission, null, 2)}\n`);
    return;
  }

  assertDeltaEvidenceInputs(args);
  const manifestPaths = deltaManifestPaths(args);

  let finalDelta = null;
  if (manifestPaths !== null) {
    finalDelta = evaluateM13FinalDeltaFromManifestFiles(manifestPaths);
  } else {
    const delta = createDeltaSource(args);
    if (delta) {
      try {
        const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
        const executeRemoteQuery = createLazyRemoteQuery({ runner, databases: null });
        const remoteReadFallbackPolicy = resolveReadFallbackPolicy(args);
        const built = await buildM13FinalDeltaManifest({
          runner,
          source: delta.source,
          executeRemoteQuery,
          batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
          remoteReadFallbackPolicy,
        });
        finalDelta = built.report;
      } finally {
        await delta.close();
      }
    }
  }

  const p5Retirement = await buildP5Evidence(args);
  const report = evaluateM13Readiness({
    environment,
    finalDelta,
    observation: buildObservation(args, policy.minimumObservationHours),
    search: buildSearch(args),
    strandedVercelObjects: flag(args, "stranded-resolved") || argValue(args, "stranded-reference")
      ? {
          resolved: flag(args, "stranded-resolved"),
          recovered: nonNegativeIntegerArg(args, "stranded-recovered"),
          inventoriedUnresolved: nonNegativeIntegerArg(args, "stranded-inventoried"),
          reference: boundedReference(argValue(args, "stranded-reference")),
        }
      : null,
    finalSupabaseExport: flag(args, "export-exists") || argValue(args, "export-reference")
      ? { exists: flag(args, "export-exists"), reference: boundedReference(argValue(args, "export-reference")) }
      : null,
    credentialRotation: flag(args, "rotation-complete") || argValue(args, "rotation-reference")
      ? { complete: flag(args, "rotation-complete"), reference: boundedReference(argValue(args, "rotation-reference")) }
      : null,
    drRehearsal: buildDrRehearsal(args),
    p5Retirement,
    governance: buildGovernance(args),
  });

  if (flag(args, "report")) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`M13 retirement readiness: ${report.readyForDestructiveRetirement ? "READY" : "BLOCKED"}`);
    console.log(`  authority profile: ${report.authority.profile} (source ${report.authority.source})`);
    console.log(`  d1 sole authority: ${report.authority.d1SoleAuthority}`);
    for (const gate of report.gates) {
      console.log(`  [${gate.passed ? "PASS" : "BLOCK"}] (${gate.category}) ${gate.key}: ${gate.detail}`);
    }
    if (report.blockers.length > 0) console.log(`  blockers: ${report.blockers.join(", ")}`);
    console.log("  note: destructive retirement requires explicit human attestation and is never authorized by this read-only tool.");
    if (flag(args, "report")) console.log(`  wrote ${REPORT_PATH}`);
  }

  if (!report.readyForDestructiveRetirement) process.exitCode = 1;
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error) => {
    console.error(`m13-readiness failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}

export { REPORT_PATH };
