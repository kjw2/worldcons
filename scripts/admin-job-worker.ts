import "dotenv/config";
import { runAdminJobWorker } from "@/lib/admin/admin-job-runner";

process.env.CRAWLEE_WORKER = "true";

async function main() {
  const result = await runAdminJobWorker({
    workerId: `admin-job-direct:${process.env.GITHUB_RUN_ID ?? Date.now()}`,
    maxJobs: 2,
    leaseSeconds: 1200,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === "unavailable") throw new Error(`Admin job queue unavailable: ${result.error}`);
  if (result.failed > 0) throw new Error(`${result.failed} admin job(s) failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
