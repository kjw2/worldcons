import "dotenv/config";
import { postgresArticleRawExternalizationRepository } from "@/lib/article-raw/externalization-repository";
import { postgresArticleRawReadinessRepository } from "@/lib/article-raw/readiness-repository";
import { postgresArticleRawRestoreRepository } from "@/lib/article-raw/restore-repository";
import {
  articleRawPreflightErrorCode,
  runArticleRawRolloutPreflight,
} from "@/lib/article-raw/rollout-preflight";

/**
 * `pnpm preflight:article-raw` — read-only M6F rollout preflight.
 *
 * It runs the three bounded reads per carrier table (M6D-A operator candidates
 * limit 1, M6D-B aggregate readiness, M6E restore candidates limit 1), reports
 * booleans/counts/sanitized error codes only, and takes no execute or acknowledgement
 * flag. A database outage fails closed: the probes are recorded as sanitized error
 * codes, the gates turn off, and no fallback path is taken.
 *
 * `--require=migration|read|write|restore` (repeatable) asserts a gate and exits 2
 * when it is not ready. No flag is required, so a bare run only reports.
 */

const REQUIREMENTS = ["migration", "read", "write", "restore"] as const;
type Requirement = (typeof REQUIREMENTS)[number];

function requiredGates(): Requirement[] {
  const values = process.argv
    .filter((argument) => argument.startsWith("--require="))
    .map((argument) => argument.slice("--require=".length).trim().toLowerCase());
  const required: Requirement[] = [];
  for (const value of values) {
    if (!(REQUIREMENTS as readonly string[]).includes(value)) throw new Error("invalid_require");
    const requirement = value as Requirement;
    if (!required.includes(requirement)) required.push(requirement);
  }
  return required;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const required = requiredGates();
  const report = await runArticleRawRolloutPreflight(
    {},
    {
      operatorCandidates: postgresArticleRawExternalizationRepository,
      aggregateReadiness: postgresArticleRawReadinessRepository,
      restoreCandidates: postgresArticleRawRestoreRepository,
      environment: process.env,
    },
  );

  output(report as unknown as Record<string, unknown>);

  const gateReady: Record<Requirement, boolean> = {
    migration: report.gates.migrationSafe,
    read: report.gates.readEnableSafe,
    write: report.gates.writeEnableSafe,
    restore: report.gates.restoreCanarySafe,
  };
  if (required.some((requirement) => !gateReady[requirement])) return 2;
  return 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "article_raw_rollout_preflight_failed",
    errorCode: articleRawPreflightErrorCode(error),
    readOnly: true,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
    storageRefsEmitted: 0,
    perRowPayloadsEmitted: 0,
  });
  process.exitCode = 1;
});
