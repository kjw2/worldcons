import "dotenv/config";
import { resolveUsConanCandidateAuthority } from "@/lib/backfill/us-conan-authority-service";

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
  const candidateId = argumentValue("candidate-id");
  if (!candidateId) throw new Error("missing_candidate-id");
  const result = await resolveUsConanCandidateAuthority({
    candidateId,
    record: flag("execute"),
  });
  output({ event: result.artifactId ? "us_conan_authority_recorded" : "us_conan_authority_probe", ...result });
  return result.resolution.status === "verified" ? 0 : 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "us_conan_authority_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
  });
  process.exitCode = 1;
});
