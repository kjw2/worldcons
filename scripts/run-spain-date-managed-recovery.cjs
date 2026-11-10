/**
 * Official Spanish decision-date recovery through Cloudflare IAM Workflows.
 *
 * This is a production operator CLI, not a Worker HTTP endpoint. It never reads
 * or fabricates CRON_SECRET/admin cookies. Both phases are triggered with the
 * operator's existing Cloudflare OAuth permissions. Exactly one approved P3
 * version per workflow, with official heading/date evidence and CAS guards.
 *
 * Default is read-only. To run a controlled tranche:
 *   node scripts/run-spain-date-managed-recovery.cjs --apply --limit=5
 */
const { spawnSync } = require("node:child_process");

const CLI = "node_modules/wrangler/bin/wrangler.js";
const CONFIG = "workers/async-pipeline/wrangler.jsonc";
const FLOW = "worldcons-spain-date-operator-v1";
const LEGACY_APPROVAL_STATEMENT = "authorize official-date-only correction of this verified published Spanish court decision";
const CLOUD_IAM_OPERATOR_ACTOR = "operator:cloudflare-iam-spain-date";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const apply = process.argv.includes("--apply");
const legacy = process.argv.includes("--legacy");
if (legacy && apply && !process.argv.includes("--authorize-legacy")) {
  throw new Error("Legacy P3 date-only corrections require explicit --authorize-legacy with Cloudflare account OAuth");
}
const limitOption = process.argv.find(v => v.startsWith("--limit="));
const limit = Number(limitOption?.slice(8) ?? "5");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
  throw new Error("Only a 1-10 case tranche is allowed");
}

function cli(...args) {
  const command = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 90000, maxBuffer: 10 * 1024 * 1024,
  });
  if (command.error || command.status !== 0) {
    throw new Error(`Cloudflare operator command failed: ${(command.error?.message ?? command.stderr ?? "").slice(0, 500)}`);
  }
  try { return JSON.parse(command.stdout); }
  catch { throw new Error("Cloudflare operator command returned invalid JSON"); }
}

function workflow(...args) {
  return cli("workflows", ...args, "--config", CONFIG, "--json");
}

function rows() {
  const sql = `SELECT a.id,a.original_title,p.version_id
    FROM articles a
    JOIN article_publications_p3 p ON p.article_id=a.id AND p.state='published'
    JOIN article_content_versions_p3 v ON v.id=p.version_id
    LEFT JOIN e2e_generation_heads_v1 h ON h.article_id=a.id
    LEFT JOIN e2e_generations_v1 g ON g.generation_id=h.generation_id
    WHERE a.source_key='es-tribunal-constitucional'
      AND v.original_published_at IS NULL
      AND ${legacy ? "h.article_id IS NULL" : "g.expected_version_id=p.version_id AND g.expected_publication_state='published'"}
    ORDER BY a.original_title DESC LIMIT ${limit}`;
  const result = cli("d1", "execute", "worldcons_core", "--remote", "--yes",
    "--json", "--config", CONFIG, "--command", sql);
  if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true) {
    throw new Error("Unable to obtain official-source current P3 cohort");
  }
  return result[0].results;
}

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function execute(instanceId) {
  for (let n = 0; n < 30; n++) {
    const result = workflow("instances", "describe", FLOW, instanceId);
    if (["complete", "errored", "terminated"].includes(result.status)) return result;
    await pause(2000);
  }
  return { status: "pending", output: null };
}

async function runOne(candidate) {
  if (!UUID.test(candidate.id) || !UUID.test(candidate.version_id)) {
    return { title: candidate.original_title, status: "invalid_snapshot" };
  }
  const previewInstance = workflow("trigger", FLOW, JSON.stringify({
    schemaVersion: 1, mode: "preview", articleId: candidate.id,
  }));
  const preview = await execute(previewInstance.id);
  const p = preview.output;
  if (preview.status !== "complete" || preview.success !== true || p?.status !== "planned"
    || p.articleId !== candidate.id || p.previousVersionId !== candidate.version_id
    || p.authorizationBasis !== (legacy ? "operator_authorization" : "managed_generation") || !HASH.test(p.planHash)
    || !HASH.test(p.evidenceSha256) || !/^20\d{2}-\d{2}-\d{2}T00:00:00\.000Z$/.test(p.correctedOriginalPublishedAt)) {
    return { title: candidate.original_title, status: "preview_blocked",
      detail: p?.status ?? preview.status };
  }
  if (!apply) {
    return { title: candidate.original_title, status: "verified_preview",
      date: p.correctedOriginalPublishedAt };
  }
  const applyInput = {
    schemaVersion: 1, mode: legacy ? "apply-legacy" : "apply", articleId: candidate.id,
    expectedVersionId: candidate.version_id, confirmPlanHash: p.planHash,
    ...(legacy ? {
      approvalStatement: LEGACY_APPROVAL_STATEMENT,
      operatorAuthorization: {
        actorId: CLOUD_IAM_OPERATOR_ACTOR,
        approvedAt: new Date().toISOString(),
        articleId: candidate.id,
        currentVersionId: candidate.version_id,
        correctedOriginalPublishedAt: p.correctedOriginalPublishedAt,
        evidenceSha256: p.evidenceSha256,
      },
    } : {}),
  };
  const applyInstance = workflow("trigger", FLOW, JSON.stringify(applyInput));
  const applied = await execute(applyInstance.id);
  if (applied.status !== "complete" || applied.success !== true || applied.output?.status !== "applied") {
    return { title: candidate.original_title, status: "apply_not_confirmed",
      detail: applied.output?.status ?? applied.status };
  }
  return { title: candidate.original_title, status: "applied",
    date: p.correctedOriginalPublishedAt,
    search: applied.output.search?.verify ?? "pending" };
}

async function main() {
  const candidates = rows();
  console.log(JSON.stringify({ mode: apply ? "apply" : "preview", cohort: legacy ? "legacy-operator-authorized" : "managed-generation", selected: candidates.length }));
  const results = [];
  for (const candidate of candidates) {
    try { results.push(await runOne(candidate)); }
    catch (error) { results.push({ title: candidate.original_title, status: "error",
      detail: String(error).slice(0, 240) }); }
    console.log(JSON.stringify(results.at(-1)));
  }
  const summary = Object.fromEntries([...new Set(results.map(v => v.status))]
    .map(status => [status, results.filter(v => v.status === status).length]));
  console.log(JSON.stringify({ summary, total: results.length }));
  if (results.some(v => v.status === "error" || v.status === "apply_not_confirmed")) process.exitCode = 2;
}

main().catch(error => { console.error(String(error).slice(0, 600)); process.exitCode = 1; });
