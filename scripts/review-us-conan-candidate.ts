import "dotenv/config";
import fs from "node:fs";
import {
  inspectUsConanCandidateReview,
  reviewUsConanCandidate,
} from "@/lib/backfill/us-conan-review-service";

const MAX_INPUT_BYTES = 256 * 1024;

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const inputPath = argumentValue("input");
  const candidateId = argumentValue("candidate-id");
  if (Boolean(inputPath) === Boolean(candidateId)) throw new Error("provide_exactly_one_of_input_or_candidate-id");
  if (candidateId) {
    if (flag("execute")) throw new Error("inspect_mode_is_read_only");
    output({ event: "us_conan_candidate_review_context", ...await inspectUsConanCandidateReview(candidateId) });
    return;
  }
  if (!inputPath) throw new Error("missing_input");
  const stats = fs.statSync(inputPath);
  if (!stats.isFile() || stats.size < 2 || stats.size > MAX_INPUT_BYTES) throw new Error("invalid_input_file");
  const input: unknown = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = await reviewUsConanCandidate(input, flag("execute"));
  output({ event: result.review ? "us_conan_candidate_reviewed" : "us_conan_candidate_review_plan", inputPath, ...result });
}

main().catch((error) => {
  output({
    event: "us_conan_candidate_review_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
  });
  process.exitCode = 1;
});
