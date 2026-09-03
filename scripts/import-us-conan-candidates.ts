import "dotenv/config";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { importUsConanCandidateGraph } from "@/lib/backfill/us-conan-import";
import { constitutionAnnotatedDiscoveryEnabled } from "@/lib/backfill/us-constitution-annotated";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function requiredArgument(name: string) {
  const value = argumentValue(name);
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function loadPriorityCitations() {
  const path = argumentValue("priority-citations-file");
  if (!path) return new Set<string>();
  const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || entry.length > 300)) {
    throw new Error("invalid_priority_citations_file");
  }
  return new Set(value);
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const inputPath = requiredArgument("input");
  const stats = fs.statSync(inputPath);
  if (!stats.isFile() || stats.size < 1 || stats.size > MAX_INPUT_BYTES) throw new Error("invalid_input_file");
  const html = fs.readFileSync(inputPath, "utf8");
  const payloadHash = createHash("sha256").update(html).digest("hex");
  const execute = flag("execute");
  const result = await importUsConanCandidateGraph({
    html,
    payloadHash,
    parserVersion: argumentValue("parser-version") || "us-conan-table-v1",
    observedAt: requiredArgument("observed-at"),
    sourcePolicyVersion: argumentValue("policy-version") || null,
    createdBy: argumentValue("requested-by") || "us-conan-import-cli",
    execute,
    priorityCitations: loadPriorityCitations(),
  });
  output({
    event: execute ? "us_conan_candidate_imported" : "us_conan_candidate_plan",
    inputPath,
    payloadHash,
    executionEnabled: constitutionAnnotatedDiscoveryEnabled(),
    candidateCount: result.candidateCount,
    classifications: result.classifications,
    prioritizedCount: result.prioritizedCount,
    snapshot: result.snapshot,
    constitutionalRelevanceStatus: "candidate",
    publicCatalogEnabled: false,
    geminiCalls: 0,
  });
}

main().catch((error) => {
  output({
    event: "us_conan_candidate_import_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
  });
  process.exitCode = 1;
});
