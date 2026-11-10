/**
 * Authenticated one-item canary client. It never touches D1 directly; it calls
 * the internal admin route, which requires CRON_SECRET or an admin session.
 * Dry-run by default. Apply requires --confirm-plan-hash from a fresh dry-run.
 */
const BASE_DEFAULT = "https://worldcons.cclib.workers.dev";
const ROUTE = "/api/admin/maintenance/spain-date-only-correction";

function arg(name: string) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const articleId = arg("article-id")?.trim();
  if (!articleId) throw new Error("spain_date_only_canary.requires_--article-id");
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new Error("spain_date_only_canary.requires_CRON_SECRET");
  const baseUrl = (arg("base-url") ?? process.env.WORLDCONS_BASE_URL ?? BASE_DEFAULT).replace(/\/+$/u, "");
  const apply = flag("apply");
  const body: Record<string, unknown> = {
    articleId,
    actorId: arg("actor")?.trim() || "operator:spain-date-only",
    correlationId: arg("correlation-id")?.trim() || `spain-date-only:${articleId}:${Date.now()}`,
    apply,
    ...(apply ? { confirmPlanHash: arg("confirm-plan-hash")?.trim() ?? "" } : {}),
  };
  const operatorAuthorization = arg("operator-authorization");
  if (operatorAuthorization) body.operatorAuthorization = JSON.parse(operatorAuthorization) as unknown;
  const response = await fetch(`${baseUrl}${ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "spain_date_only_canary.unknown_failure");
  process.exitCode = 1;
});

export {};
