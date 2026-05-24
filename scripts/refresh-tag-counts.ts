import "dotenv/config";
import { runRefreshTagCounts } from "@/lib/ingest/run";

async function main() {
  const deleteOrphans = process.argv.includes("--delete-orphans");
  const result = await runRefreshTagCounts({ deleteOrphans });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
