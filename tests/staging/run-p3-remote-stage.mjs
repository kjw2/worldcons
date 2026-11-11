import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Bounded, isolated Cloudflare Worker canary. NO production D1/R2/asset bindings.
 * The Worker has a one-time cryptographically random authentication token,
 * is named independently of worldcons, and is removed on all exit paths.
 */
const id = randomBytes(5).toString("hex");
const token = randomBytes(32).toString("hex");
const workerName = `worldcons-p3-aig-${id}`;
const configFile = join(process.cwd(), "tests", "staging", `.p3-remote-${id}.jsonc`);
const config = {
  name: workerName,
  main: "./p3-native-ai-worker.ts",
  compatibility_date: "2026-09-20",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  ai: { binding: "AI" },
  vars: {
    P3_LOCAL_TEST_TOKEN: token,
    WORLDCONS_AI_GATEWAY_ID: "default",
    WORLDCONS_AI_GATEWAY_ROUTE: "gemini-flash-fallback",
  },
};
function command(args, timeout = 120000) {
  // Pass SQL as one argv token, avoiding cmd.exe's destructive quote rewriting.
  const wrangler = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
  const r = spawnSync(process.execPath, [wrangler, ...args],
    { cwd: process.cwd(), encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  const output = String(r.stdout || "") + String(r.stderr || "");
  return { ok: r.status === 0, output: output.replaceAll(token, "[redacted]"), stdout: String(r.stdout || ""), code: r.status };
}
const allSamples = [
  { lane: "ingest", id: "afbbb6ef-ad3d-4494-bbf3-563e705efce1", source: "de-bverfg" },
  { lane: "scheduled", id: "864accea-90da-4397-a158-ab4397da7a9c", source: "es-tribunal-constitucional" },
  { lane: "admin", id: "f252de7d-53be-4137-ad80-ea4500d1de02", source: "fr-conseil-constitutionnel" },
  { lane: "us-private", id: "20353a3d-af47-44de-baa3-98d8fca1bdde", source: "us-scotus" },
];
const selectedLanes = new Set((process.env.P3_STAGE_LANES || "ingest,scheduled,admin,us-private").split(","));
const samples = allSamples.filter(sample => selectedLanes.has(sample.lane));
if (samples.length === 0) throw new Error("No P3 validation lane selected");
let deploymentFound = false;
let responseUrl = "";
writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
try {
  const deploy = command(["deploy", "--config", configFile, "--autoconfig=false"], 120000);
  const url = deploy.output.match(/https:\/\/[a-zA-Z0-9._-]+\.workers\.dev/);
  if (!deploy.ok || !url) {
    console.log(JSON.stringify({ step: "deploy", success: false, code: deploy.code, message: deploy.output.slice(-1200) }));
    process.exitCode = 1;
  } else {
    deploymentFound = true;
    responseUrl = url[0];
    console.log(JSON.stringify({ step: "deploy", success: true, workerName, url: responseUrl }));
    const rows = [];
    for (const sample of samples) {
      const sql = `SELECT id,source_key,jurisdiction,institution_name,original_language,canonical_url,original_title,original_published_at,cleaned_text,summary_json,source_metadata FROM articles WHERE id='${sample.id}' LIMIT 1`;
      const d1 = command(["d1", "execute", "worldcons_core", "--remote", "--config", "wrangler.jsonc", "--command", sql, "--json"], 90000);
      if (!d1.ok) {
        const error = (d1.output.match(/(?:Error|ERROR|Failed|Unknown)[^\n]{0,260}/i) || [])[0] || "no_cli_error_detail";
        throw new Error(`Read-only source acquisition failed for ${sample.source}: exit ${d1.code}; ${error}`);
      }
      const query = JSON.parse(d1.stdout);
      rows.push(...(Array.isArray(query) ? query : [query]).flatMap(q => q.results || []));
    }
    if (rows.length !== samples.length) throw new Error("Grounded D1 read-only rows not returned");
    const fixtures = samples.map(sample => {
      const row = rows.find(r => r.id === sample.id && r.source_key === sample.source);
      if (!row || typeof row.cleaned_text !== "string" || row.cleaned_text.length < 3000) throw new Error("Missing full text or bad source ID");
      const metadata = JSON.parse(row.source_metadata || "{}");
      if (sample.lane === "us-private" && (metadata.collection?.publishable !== false || metadata.review?.required !== true)) {
        throw new Error("US private hold missing");
      }
      return {
        lane: sample.lane, id: row.id,
        baselineCorePoints: JSON.parse(row.summary_json || "{}").summary?.coreSummary?.length || 0,
        body: {
          lane: sample.lane,
          sourceKey: row.source_key, jurisdiction: row.jurisdiction,
          institutionName: row.institution_name,
          originalLanguage: row.original_language, originalTitle: row.original_title,
          originalPublishedAt: row.original_published_at, originalUrl: row.canonical_url,
          cleanedText: row.cleaned_text,
        },
      };
    });
    const common = {
      method: "POST",
      headers: { "content-type": "application/json", "x-p3-local-token": token },
    };
    const deadline = Date.now() + 290000;
    const request = async (path, body) => {
      const start = Date.now();
      const remainingMs = deadline - Date.now();
      if (remainingMs < 5000) throw new Error("Stage evaluation budget exhausted");
      const response = await fetch(`${responseUrl}${path}`, {
        ...common, body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(150000, remainingMs)),
      });
      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch {
        json = {
          kind: "non_json",
          chars: raw.length,
          title: (raw.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.slice(0, 120) || null,
        };
      }
      return { http: response.status, elapsedMs: Date.now() - start, result: json };
    };
    let diagnostic;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 3500));
      diagnostic = await request("/p3?diagnostic=1", fixtures[0].body);
      if (diagnostic.http !== 404) break;
    }
    console.log(JSON.stringify({ step: "native-binding", ...diagnostic }));
    if (diagnostic.http === 200 && diagnostic.result?.ok === true) {
      for (const fixture of fixtures) {
        const smoke = await request("/p3", fixture.body);
        console.log(JSON.stringify({
          step: "real-summary-adapter", lane: fixture.lane, articleId: fixture.id,
          sourceChars: fixture.body.cleanedText.length, priorCorePoints: fixture.baselineCorePoints,
          ...smoke,
        }));
        if (smoke.http !== 200 || !smoke.result?.schemaValid) process.exitCode = 1;
      }
    } else {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.log(JSON.stringify({ step: "error", error: error instanceof Error ? error.name : "unknown", message: String(error instanceof Error ? error.message : error).slice(0,240) }));
  process.exitCode = 1;
} finally {
  // Cleanup also if deploy uploaded the script but failed to return a URL.
  const deleted = command(["delete", workerName, "--force"], 90000);
  console.log(JSON.stringify({ step: "delete", workerName, removed: deleted.ok, deploymentFound, failure: deleted.ok ? null : deleted.output.slice(-500) }));
  try { unlinkSync(configFile); } catch {}
  if (!deleted.ok) process.exitCode = 1;
}
