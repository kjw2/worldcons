import "dotenv/config";
import { randomUUID } from "node:crypto";
import { postgresCaseBackfillRepository } from "@/lib/backfill/repository";
import type { CaseBackfillPhase } from "@/lib/backfill/types";
import {
  assertSpainSentenciaYearEnabled,
  CASE_CATALOG_SPAIN_HISTORY_FLAG,
  SPAIN_SENTENCIA_BASELINE_YEAR,
  SPAIN_SENTENCIA_HISTORY_START_YEAR,
  spainSentenciaExpansionPlan,
  spainSentenciaYearEnabled,
  spainSentenciaYearScope,
} from "@/lib/backfill/spain-scope";
import {
  adminQueueP1CommandAuthorized,
  resolveAdminQueueP1Authority,
  type AdminQueueP1CommandType,
} from "@/lib/admin/command-control-plane/p1-authority";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import { ADMIN_P1_WORKER_EXIT, runAdminCommandWorkerP1 } from "@/lib/admin/command-control-plane/p1-worker";
import { tryRecordWorkflowHeartbeat } from "@/lib/ops/workflow-heartbeat";

const GATE1_PHASES = ["discover", "fetch", "normalize", "verify", "reconcile"] as const;
type Gate1Command = "plan" | "status" | (typeof GATE1_PHASES)[number];

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function command(): Gate1Command {
  const value = process.argv[2] ?? "plan";
  if (!["plan", "status", ...GATE1_PHASES].includes(value as Gate1Command)) throw new Error("invalid_command");
  return value as Gate1Command;
}

function integerArgument(name: string, fallback: number, min: number, max: number) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}

function requiredArgument(name: string) {
  const value = argumentValue(name)?.trim();
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function optionalUuid(name: string) {
  const value = argumentValue(name)?.trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function gate1Plan() {
  const year = integerArgument("year", SPAIN_SENTENCIA_BASELINE_YEAR, SPAIN_SENTENCIA_HISTORY_START_YEAR, SPAIN_SENTENCIA_BASELINE_YEAR);
  const scope = spainSentenciaYearScope(year);
  return {
    gate: year === SPAIN_SENTENCIA_BASELINE_YEAR ? 1 : 5,
    mode: "private-shadow",
    sourceKey: "es-tribunal-constitucional",
    ...scope,
    executionEnabled: spainSentenciaYearEnabled(year),
    requiredHistoryFlag: year < SPAIN_SENTENCIA_BASELINE_YEAR ? CASE_CATALOG_SPAIN_HISTORY_FLAG : null,
    expansionPlan: spainSentenciaExpansionPlan(),
    phases: [...GATE1_PHASES],
    publicCatalogEnabled: false,
    geminiCalls: 0,
    invariants: [
      "closed_manifest_immutable",
      "p1_attempt_fenced_item_claims",
      "item_lease_not_after_attempt_lease",
      "append_only_fetch_and_normalization_artifacts",
      "published_resolution_survives_maintenance",
    ],
  };
}

async function snapshotForDiscovery() {
  const existing = optionalUuid("snapshot");
  if (existing) return existing;
  const year = integerArgument("year", SPAIN_SENTENCIA_BASELINE_YEAR, SPAIN_SENTENCIA_HISTORY_START_YEAR, SPAIN_SENTENCIA_BASELINE_YEAR);
  assertSpainSentenciaYearEnabled(year);
  const scope = spainSentenciaYearScope(year);
  const policyVersion = requiredArgument("policy-version");
  await postgresCaseBackfillRepository.getSourcePolicy("es-tribunal-constitucional", policyVersion);
  return postgresCaseBackfillRepository.openSnapshot({
    sourceKey: "es-tribunal-constitucional",
    scopeFrom: scope.scopeFrom,
    scopeTo: scope.scopeTo,
    documentType: "SENTENCIA",
    discoveryMethod: "official_hj_search_pagination",
    parserVersion: argumentValue("parser-version")?.trim() || "spain-hj-normalize-v1",
    sourcePolicyVersion: policyVersion,
    coverageAssurance: "authoritative_enumerated",
    expectedCount: null,
    expectedCountBasis: null,
    coverageEvidence: {
      method: "official_hj_search_pagination",
      officialUrl: "https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index",
      pending: true,
    },
    exclusions: [],
    createdBy: argumentValue("requested-by")?.trim() || "backfill-corpus-cli",
  });
}

async function submitPhase(phase: (typeof GATE1_PHASES)[number], snapshotId: string) {
  const passNumber = await postgresCaseBackfillRepository.allocatePass(snapshotId, phase);
  const payloadRef = {
    cohort: "catalog-backfill" as const,
    snapshotId,
    passNumber,
    batchLimit: integerArgument("batch-limit", 50, 1, 100),
    parserVersion: argumentValue("parser-version")?.trim() || "spain-hj-normalize-v1",
    normalizationContractVersion: argumentValue("normalization-contract")?.trim() || "case-normalized-v1",
    fetchContractVersion: argumentValue("fetch-contract")?.trim() || "spain-hj-fetch-v1",
  };
  const commandType = `p1.case-backfill.${phase}` as AdminQueueP1CommandType;
  const submitted = await adminCommandService.submit({
    commandType,
    payloadRef,
    idempotencyKey: `backfill-pass:${snapshotId}:${phase}:${passNumber}`,
    dedupeKey: `backfill-active:${snapshotId}:${phase}`,
    requestedBy: argumentValue("requested-by")?.trim() || "backfill-corpus-cli",
    priority: integerArgument("priority", 0, -1000, 1000),
    maxAttempts: integerArgument("max-attempts", 5, 1, 20),
    retryBackoffBaseSeconds: 60,
    retryBackoffCapSeconds: 3600,
    shadowOnly: false,
  });
  if (!submitted.ok) throw new Error(`submit_failed:${submitted.error.code}`);
  output({ event: "case_backfill_submitted", phase, snapshotId, passNumber, ...submitted.data });

  if (!flag("execute")) return 0;
  const authority = resolveAdminQueueP1Authority();
  if (!authority.enabled || !adminQueueP1CommandAuthorized(authority, commandType, payloadRef)) {
    throw new Error("case_backfill_worker_authority_not_enabled");
  }
  await tryRecordWorkflowHeartbeat("catalog_backfill", "running", { snapshotId, phase, passNumber });
  const worker = await runAdminCommandWorkerP1({
    authority,
    maxCommands: 1,
    attemptTimeoutSeconds: 2400,
    workerId: `local-catalog-backfill:${randomUUID()}`,
  });
  const heartbeatStatus = worker.exitCode === ADMIN_P1_WORKER_EXIT.success ? "success" : "failed";
  await tryRecordWorkflowHeartbeat("catalog_backfill", heartbeatStatus, {
    snapshotId,
    phase,
    passNumber,
    claimed: worker.claimed,
    succeeded: worker.succeeded,
    failed: worker.failed,
  });
  output({ event: "case_backfill_worker_finished", snapshotId, phase, passNumber, ...worker });
  return worker.exitCode;
}

async function main() {
  const selected = command();
  if (selected === "plan") {
    output(gate1Plan());
    return 0;
  }
  if (selected === "status") {
    const snapshotId = requiredArgument("snapshot");
    output({ event: "case_backfill_status", ...(await postgresCaseBackfillRepository.getSnapshotStatus(snapshotId)) });
    return 0;
  }
  const snapshotId = selected === "discover" ? await snapshotForDiscovery() : requiredArgument("snapshot");
  return submitPhase(selected as CaseBackfillPhase & (typeof GATE1_PHASES)[number], snapshotId);
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "case_backfill_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
  });
  process.exitCode = 1;
});
