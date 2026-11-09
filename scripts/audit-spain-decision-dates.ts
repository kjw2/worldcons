/** Read-only/dry-run P0-1 Spain decision-date recovery audit. Never writes or applies SQL. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpainDateRecoveryPlan,
  fetchSpainOfficialDateEvidence,
  type SpainRecoveryCoreRow,
  type SpainRecoveryPublishedVersionRow,
} from "@/lib/ingest/spain-decision-date-recovery";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_KEY = "es-tribunal-constitucional";

export const SPAIN_DATE_RECOVERY_CORE_SQL = `SELECT id,canonical_url,original_url,original_published_at,fetched_at,content_hash,source_metadata FROM articles WHERE source_key='${SOURCE_KEY}' AND original_published_at IS NULL ORDER BY id`;

export const SPAIN_DATE_RECOVERY_VERSION_SQL = `SELECT a.id AS article_id,p.version_id,p.revision AS publication_revision,v.revision AS version_revision,v.original_published_at AS version_original_published_at,v.content_hash AS version_content_hash,v.source_content_hash AS source_content_hash,a.canonical_url,a.original_published_at AS article_original_published_at,a.fetched_at AS article_fetched_at FROM articles a JOIN article_publications_p3 p ON p.article_id=a.id AND p.state='published' JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id WHERE a.source_key='${SOURCE_KEY}' AND v.original_published_at IS NULL ORDER BY a.id`;

function arg(name: string) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function readRemote(query: string) {
  const cli = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
  const response = spawnSync(process.execPath, [cli, "d1", "execute", "worldcons_core", "--remote", "--yes", "--json", "--config", config, "--command", query], { cwd: ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (response.error || response.status !== 0) {
    throw new Error(`spain_date_recovery.production_read_failed: ${response.error?.message ?? String(response.stderr).slice(0, 400)}`);
  }
  const payload = JSON.parse(response.stdout) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>;
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true) {
    throw new Error("spain_date_recovery.production_read_incomplete");
  }
  return payload[0].results ?? [];
}

function readInput(path: string) {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, path), "utf8").replace(/^\uFEFF/, "")) as { coreRows?: unknown; versionRows?: unknown };
  if (!Array.isArray(parsed.coreRows) || !Array.isArray(parsed.versionRows)) {
    throw new Error("spain_date_recovery.input_must_contain_coreRows_and_versionRows_arrays");
  }
  return { coreRows: parsed.coreRows as SpainRecoveryCoreRow[], versionRows: parsed.versionRows as SpainRecoveryPublishedVersionRow[] };
}

async function main() {
  if (flag("apply") || flag("write")) throw new Error("spain_date_recovery.apply_not_supported_read_only_only");
  const inputPath = arg("input");
  const remote = flag("remote");
  if (!inputPath && !remote) throw new Error("spain_date_recovery.requires_--input=<json>_or_--remote");
  if (inputPath && remote) throw new Error("spain_date_recovery.choose_one_of_--input_or_--remote");
  const maxOfficialFetches = Math.max(0, Math.trunc(Number(arg("max-fetches") ?? 500)));
  const delayMs = Math.max(0, Math.trunc(Number(arg("delay-ms") ?? 2_000)));
  const rows = inputPath
    ? readInput(inputPath)
    : { coreRows: readRemote(SPAIN_DATE_RECOVERY_CORE_SQL) as unknown as SpainRecoveryCoreRow[], versionRows: readRemote(SPAIN_DATE_RECOVERY_VERSION_SQL) as unknown as SpainRecoveryPublishedVersionRow[] };
  const plan = await buildSpainDateRecoveryPlan({
    coreRows: rows.coreRows,
    versionRows: rows.versionRows,
    maxOfficialFetches,
    fetchEvidence: (hjId, canonicalUrl) => fetchSpainOfficialDateEvidence(hjId, canonicalUrl, { delayMs }),
  });
  process.stdout.write(`${JSON.stringify({ ...plan, source: inputPath ? `input:${inputPath}` : "production-read-only" }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "spain_date_recovery.unknown_failure");
    process.exitCode = 1;
  });
}
