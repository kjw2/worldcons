import "dotenv/config";
import { runSiteAnalyticsRetention } from "@/lib/analytics/retention";

async function main() {
  const result = await runSiteAnalyticsRetention();
  if (!result.available) {
    console.error(JSON.stringify({ status: "unavailable", ...result }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ status: "completed", ...result }));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
