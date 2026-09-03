import "dotenv/config";
import fs from "node:fs";
import {
  classifyUsCaseCitation,
  type ConstitutionAnnotatedCandidate,
} from "@/lib/backfill/us-constitution-annotated";
import { resolveGovInfoUsReportsAuthority } from "@/lib/crawlee/us-govinfo-reports-resolver";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function requiredArgument(name: string) {
  const value = argumentValue(name);
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function probeInput() {
  const path = argumentValue("input");
  if (!path) return { citation: requiredArgument("citation"), caseName: requiredArgument("case-name") };
  const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { citation?: unknown }).citation !== "string"
    || typeof (value as { caseName?: unknown }).caseName !== "string"
  ) throw new Error("invalid_probe_input");
  const citation = (value as { citation: string }).citation.trim();
  const caseName = (value as { caseName: string }).caseName.trim();
  if (!citation || citation.length > 300 || !caseName || caseName.length > 500) throw new Error("invalid_probe_input");
  return { citation, caseName };
}

async function main() {
  const { citation, caseName } = probeInput();
  const candidate: Pick<ConstitutionAnnotatedCandidate, "caseName" | "citation" | "courtClassification"> = {
    caseName,
    citation,
    courtClassification: classifyUsCaseCitation(citation),
  };
  const result = await resolveGovInfoUsReportsAuthority(candidate);
  output({
    event: "us_reports_authority_probe",
    ...result,
    constitutionalRelevanceStatus: "candidate",
    reviewWritten: false,
    publicCatalogEnabled: false,
    geminiCalls: 0,
  });
  return result.status === "verified" ? 0 : 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "us_reports_authority_probe_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
  });
  process.exitCode = 1;
});
