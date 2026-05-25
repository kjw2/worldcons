import "dotenv/config";
import { generateGlossaryCandidates, languageLabels } from "@/lib/glossary/candidates";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function positiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function main() {
  const result = await generateGlossaryCandidates({
    minCount: positiveInteger(argValue("min-count")),
    limit: positiveInteger(argValue("limit")),
    persist: process.argv.includes("--persist"),
  });

  console.log(
    JSON.stringify(
      {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          name: candidate.tagName,
          suggestedSlug: candidate.suggestedSlug,
          type: candidate.tagType,
          articleCount: candidate.articleCount,
          sourceLanguages: languageLabels(candidate.sourceLanguages),
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
