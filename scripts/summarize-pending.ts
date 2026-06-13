import "dotenv/config";
import { runSummarizePending } from "@/lib/ingest/summary";

async function main() {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
  const sourceKey = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1];
  const limit = limitArg ? Number(limitArg) : undefined;

  const result = await runSummarizePending({ limit, sourceKey });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
