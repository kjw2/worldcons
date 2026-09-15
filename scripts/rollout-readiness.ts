import "dotenv/config";
import {
  caseBackfillRolloutReadiness,
  preflightCaseBackfillRollout,
  type CaseBackfillRolloutSelectionInput,
} from "@/lib/backfill/rollout-readiness";

const SOURCE_ALIASES: Record<string, string> = {
  germany: "de-bverfg",
  de: "de-bverfg",
  "de-bverfg": "de-bverfg",
  france: "fr-conseil-constitutionnel",
  fr: "fr-conseil-constitutionnel",
  "fr-conseil-constitutionnel": "fr-conseil-constitutionnel",
  spain: "es-tribunal-constitucional",
  es: "es-tribunal-constitucional",
  "es-tribunal-constitucional": "es-tribunal-constitucional",
  us: "us-constitution-annotated",
  usa: "us-constitution-annotated",
  "us-constitution-annotated": "us-constitution-annotated",
};

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function canonicalSourceKey(value: string) {
  const key = SOURCE_ALIASES[value.trim().toLowerCase()];
  if (!key) throw new Error("invalid_source");
  return key;
}

function selectionFromArguments(): CaseBackfillRolloutSelectionInput | null {
  const sourceRaw = argumentValue("source");
  if (!sourceRaw) return null;
  const yearRaw = argumentValue("year");
  const documentType = argumentValue("document-type");
  if (yearRaw === undefined || documentType === undefined) throw new Error("missing_year_or_document_type");
  const year = Number(yearRaw);
  if (!Number.isInteger(year)) throw new Error("invalid_year");
  return { sourceKey: canonicalSourceKey(sourceRaw), year, documentType };
}

function main() {
  const selectionInput = selectionFromArguments();
  if (!selectionInput) {
    output(caseBackfillRolloutReadiness() as unknown as Record<string, unknown>);
    return 0;
  }
  const preflight = preflightCaseBackfillRollout(selectionInput);
  output({
    reportEvent: "case_backfill_rollout_readiness_selection",
    ...preflight,
  } as unknown as Record<string, unknown>);
  if (!preflight.allowed) {
    return flag("require-authorized") ? 2 : 0;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  output({
    event: "case_backfill_rollout_readiness_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
  });
  process.exitCode = 1;
}
