import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4MiniflareOptions } from "miniflare";
import { generationProjectionHash } from "../lib/cloudflare/e2e/generation-state";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_SOURCE = join(REPO_ROOT, "scripts", "fixtures", "worldcons-sitemap-runtime-worker.ts");
const LOCAL_D1_BINDING = "WORLDCONS_CORE";
const LOCAL_D1_DATABASE_ID = "worldcons-local-sitemap-harness";
const HARNESS_ORIGIN = "http://worldcons-harness.test";
const BASE_URL = "https://worldcons.test";
const NOW = "2026-01-01T00:00:00.000Z";
const PUBLISHABLE = JSON.stringify({ collection: { publishable: true } });

const SITEMAP_SWITCH_MATRIX = [
  { label: "fastSitemap=false,jsonGuard=false", fastSitemap: false, jsonGuard: false },
  { label: "fastSitemap=true,jsonGuard=false", fastSitemap: true, jsonGuard: false },
  { label: "fastSitemap=false,jsonGuard=true", fastSitemap: false, jsonGuard: true },
  { label: "fastSitemap=true,jsonGuard=true", fastSitemap: true, jsonGuard: true },
] as const;

export interface WorkersSitemapHarnessOptions {
  basePublished?: number;
  timeoutMs?: number;
}

export interface SitemapRunReport {
  label: string;
  fastSitemap: boolean;
  jsonGuard: boolean;
  status: number;
  entries: number;
  xmlBytes: number;
  xmlSha256: string;
  normalizedSha256: string;
  statements: number;
  rowsRead: number | null;
  rowsReadAvailable: boolean;
  workerElapsedMs: number;
}

export interface NegativeRunReport {
  label: string;
  status: number;
  pendingWithheld: boolean;
  sameXmlAsBaseline: boolean;
}

export interface WorkersSitemapHarnessReport {
  dataset: {
    basePublished: number;
    totalArticles: number;
    visibleArticles: number;
    withheldFixtures: string[];
  };
  runs: SitemapRunReport[];
  parity: {
    allNormalizedSetsEqual: boolean;
    allXmlBytesEqual: boolean;
    baselineNormalizedSha256: string;
  };
  negative: NegativeRunReport[];
  safety: {
    localD1Binding: string;
    localDatabaseId: string;
    outboundNetworkDisabled: boolean;
    tempDirRemoved: boolean;
    seedFetches: number;
    matrixFetches: number;
    negativeFetches: number;
    workerFetches: number;
    totalElapsedMs: number;
  };
}

function sqlString(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function articleInsert(
  id: string,
  options: {
    publishedAt?: string | null;
    discoveredAt?: string | null;
    fetchedAt?: string | null;
    summarizedAt?: string | null;
    status?: string;
    stale?: number;
    metadata?: string;
  } = {},
): string {
  const publishedAt = options.publishedAt === undefined ? NOW : options.publishedAt;
  const discoveredAt = options.discoveredAt === undefined ? "2026-01-02T00:00:00.000Z" : options.discoveredAt;
  const fetchedAt = options.fetchedAt === undefined ? "2026-01-02T00:00:00.000Z" : options.fetchedAt;
  const summarizedAt = options.summarizedAt === undefined ? "2026-01-03T00:00:00.000Z" : options.summarizedAt;
  return `INSERT INTO articles(id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,status,slug,summary_json,source_metadata,catalog_ai_stale_v4,content_hash,created_at,updated_at) VALUES (${[
    sqlString(id),
    sqlString("us-scotus"),
    sqlString("United States"),
    sqlString("SCOTUS"),
    sqlString("opinion"),
    sqlString(`https://example.test/${id}`),
    sqlString(`https://example.test/${id}`),
    sqlString("en"),
    sqlString(`Title ${id}`),
    sqlString(`Korean title ${id}`),
    sqlString(publishedAt),
    sqlString(discoveredAt),
    sqlString(fetchedAt),
    sqlString(summarizedAt),
    sqlString(options.status ?? "summarized"),
    sqlString(id),
    sqlString(JSON.stringify({ summary: { coreSummary: ["Summary"] }, koreanTitle: `Korean title ${id}` })),
    sqlString(options.metadata ?? PUBLISHABLE),
    String(options.stale ?? 0),
    sqlString(`hash-${id}`),
    sqlString(NOW),
    sqlString("2026-01-03T00:00:00.000Z"),
  ].join(",")});`;
}

function publicationInsert(id: string, state = "published", versionId = `pub-${id}`): string {
  return `INSERT INTO article_publications_p3(id,article_id,state,version_id,revision,decided_by_type,reason,created_at,updated_at) VALUES (${[
    sqlString(`p-${id}`),
    sqlString(id),
    sqlString(state),
    sqlString(versionId),
    sqlString("1"),
    sqlString("human"),
    sqlString("test"),
    sqlString(NOW),
    sqlString(NOW),
  ].join(",")});`;
}

function versionInsert(
  id: string,
  options: {
    versionId?: string;
    publishedAt?: string | null;
    versionRole?: string | null;
    anchor?: string | null;
    enrichmentHash?: string | null;
    sourceHash?: string | null;
  } = {},
): string {
  const versionId = options.versionId ?? `pub-${id}`;
  const publishedAt = options.publishedAt === undefined ? NOW : options.publishedAt;
  return `INSERT INTO article_content_versions_p3(id,article_id,revision,content_hash,provenance_actor_type,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,created_at,version_role,source_anchor_version_id,enrichment_source_content_hash,source_content_hash,original_published_at,source_metadata) VALUES (${[
    sqlString(versionId),
    sqlString(id),
    sqlString("1"),
    sqlString(`hash-${id}`),
    sqlString("human"),
    sqlString(id),
    sqlString("us-scotus"),
    sqlString("United States"),
    sqlString("SCOTUS"),
    sqlString("opinion"),
    sqlString(`https://example.test/${id}`),
    sqlString(`https://example.test/${id}`),
    sqlString("en"),
    sqlString(NOW),
    sqlString(options.versionRole ?? null),
    sqlString(options.anchor ?? null),
    sqlString(options.enrichmentHash ?? null),
    sqlString(options.sourceHash ?? null),
    sqlString(publishedAt),
    sqlString(PUBLISHABLE),
  ].join(",")});`;
}

function classificationInsert(id: string): string {
  return `INSERT INTO legacy_version_freshness_classifications_v4(version_id,article_id,freshness,freshness_basis,evidence,classified_at,classified_by) VALUES (${[
    sqlString(`pub-${id}`),
    sqlString(id),
    sqlString("current"),
    sqlString("legacy_same_version"),
    sqlString("{}"),
    sqlString(NOW),
    sqlString("test"),
  ].join(",")});`;
}

function catalogInsert(id: string, anchor = `anchor-${id}`): string {
  return `INSERT INTO case_catalog_publications_v1(id,article_id,state,source_anchor_version_id,revision,source_policy_version,decided_by_type,reason,created_at,updated_at) VALUES (${[
    sqlString(`cat-${id}`),
    sqlString(id),
    sqlString("published"),
    sqlString(anchor),
    sqlString("1"),
    sqlString("v1"),
    sqlString("human"),
    sqlString("test"),
    sqlString(NOW),
    sqlString(NOW),
  ].join(",")});`;
}

function generationInsert(id: string, projectionInputHash: string): string[] {
  const generationId = `gen-${id}`;
  const versionId = `pub-${id}`;
  const publicationId = `p-${id}`;
  return [
    `INSERT INTO e2e_generations_v1(generation_id,article_id,generation_seq,source_key,source_content_hash,approval_key,approval_snapshot_hash,approval_hash_schema,projection_input_hash,projection_input_schema,expected_version_id,expected_version_revision,expected_publication_id,expected_publication_revision,expected_publication_state,approval_mode,policy_version,approval_evidence_ref,source_evidence_ref,created_at) VALUES (${[
      sqlString(generationId),
      sqlString(id),
      "1",
      sqlString("us-scotus"),
      sqlString(`source-${id}`),
      sqlString(`approval-key-${generationId}`),
      sqlString(`approval-${id}`),
      sqlString("worldcons.approval.v2"),
      sqlString(projectionInputHash),
      sqlString("worldcons.projection-input.v1"),
      sqlString(versionId),
      "1",
      sqlString(publicationId),
      "1",
      sqlString("published"),
      sqlString("automatic"),
      sqlString("policy-v1"),
      sqlString("evidence"),
      sqlString("source-evidence"),
      sqlString(NOW),
    ].join(",")});`,
    `INSERT INTO e2e_generation_heads_v1(article_id,generation_id,generation_seq,updated_at) VALUES (${[
      sqlString(id),
      sqlString(generationId),
      "1",
      sqlString(NOW),
    ].join(",")});`,
    `INSERT INTO article_version_heads_p3(article_id,current_version_id,current_revision,updated_at) VALUES (${[
      sqlString(id),
      sqlString(versionId),
      "1",
      sqlString(NOW),
    ].join(",")});`,
  ];
}

function matrixBaseArticle(index: number): string[] {
  const id = `matrix-${String(index).padStart(4, "0")}`;
  const day = (index % 28) + 1;
  const publishedAt = `2026-01-${pad(day)}T00:00:00.000Z`;
  const summarizedAt = index % 11 === 0 ? null : `2026-02-${pad(day)}T${pad(index % 24)}:00:00.000Z`;
  const fetchedAt = index % 17 === 0 ? null : `2026-01-${pad(day)}T12:00:00.000Z`;
  const discoveredAt = `2026-01-${pad(day)}T00:00:00.000Z`;
  return [
    articleInsert(id, { publishedAt, discoveredAt, fetchedAt, summarizedAt }),
    publicationInsert(id),
    versionInsert(id, { publishedAt }),
  ];
}

function chunkStatements(statements: readonly string[], size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < statements.length; index += size) {
    chunks.push(statements.slice(index, index + size).join("\n"));
  }
  return chunks;
}

async function readMigration(name: string): Promise<string> {
  const sql = await readFile(join(REPO_ROOT, "d1", "worldcons_core", name), "utf8");
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function parseSitemapXml(xml: string): Array<{ loc: string; lastModified: string | null }> {
  const entries: Array<{ loc: string; lastModified: string | null }> = [];
  const pattern = /<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g;
  for (const match of xml.matchAll(pattern)) {
    entries.push({ loc: unescapeXml(match[1]), lastModified: match[2] ? unescapeXml(match[2]) : null });
  }
  return entries;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedHash(xml: string): { hash: string; entries: Array<{ loc: string; lastModified: string | null }> } {
  const entries = parseSitemapXml(xml).sort((left, right) => left.loc.localeCompare(right.loc));
  const lines = entries.map((entry) => `${entry.loc}\t${entry.lastModified ?? ""}`);
  return { hash: sha256Hex(lines.join("\n")), entries };
}

interface HarnessResponseHeaders {
  headers: { get(name: string): string | null };
}

function headerNumber(response: HarnessResponseHeaders, name: string): number {
  const value = Number(response.headers.get(name));
  assert.ok(Number.isFinite(value), `missing numeric harness header ${name}`);
  return value;
}

function headerBoolean(response: HarnessResponseHeaders, name: string): boolean {
  return response.headers.get(name) === "true";
}

function assertVisibleAndWithheld(xml: string, expectedVisible: number): void {
  const { entries } = normalizedHash(xml);
  assert.equal(entries.length, expectedVisible, "visible sitemap entry count");
  const locs = new Set(entries.map((entry) => entry.loc));
  assert.equal(locs.has(`${BASE_URL}/articles/matrix-withdrawn`), false, "withdrawn fixture must be withheld");
  assert.equal(locs.has(`${BASE_URL}/articles/matrix-catalog-mismatch`), false, "catalog mismatch must be withheld");
  assert.equal(locs.has(`${BASE_URL}/articles/matrix-metadata-approved`), true, "approved metadata must stay visible");
  assert.equal(locs.has(`${BASE_URL}/articles/matrix-protected-generation`), true, "current generation must stay visible");
  assert.equal(locs.has(`${BASE_URL}/articles/matrix-0000`), true);
  assert.ok(entries.some((entry) => entry.loc.endsWith("/matrix-0000") && entry.lastModified === "2026-01-01T00:00:00.000Z"));
  assert.ok(entries.some((entry) => entry.loc.endsWith("/matrix-0001") && entry.lastModified === "2026-02-02T01:00:00.000Z"));
}

async function bundleWorker(outfile: string): Promise<void> {
  await build({
    entryPoints: [WORKER_SOURCE],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["worker", "browser"],
    alias: { "@": REPO_ROOT },
    logLevel: "silent",
    absWorkingDir: REPO_ROOT,
  });
}

export async function runWorkersSitemapAcceptanceGate(
  options: WorkersSitemapHarnessOptions = {},
): Promise<WorkersSitemapHarnessReport> {
  const basePublished = options.basePublished ?? 2237;
  assert.ok(Number.isInteger(basePublished) && basePublished > 0, "basePublished must be a positive integer");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  const tempDir = await mkdtemp(join(tmpdir(), "worldcons-sitemap-worker-"));
  const bundlePath = join(tempDir, "worldcons-sitemap-runtime-worker.mjs");
  let miniflare: Miniflare | null = null;
  let report: WorkersSitemapHarnessReport | null = null;
  let seedFetches = 0;
  let matrixFetches = 0;
  let negativeFetches = 0;

  try {
    await bundleWorker(bundlePath);

    const workerOptions: V4MiniflareOptions = {
      modules: true,
      scriptPath: bundlePath,
      compatibilityDate: "2026-09-20",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { [LOCAL_D1_BINDING]: LOCAL_D1_DATABASE_ID },
      outboundService: async () => {
        throw new Error("harness_network_disabled");
      },
      log: new Log(LogLevel.NONE),
    };
    miniflare = new Miniflare(convertV4MiniflareOptions(workerOptions));
    await miniflare.ready;

    const seed = async (sql: string): Promise<void> => {
      seedFetches += 1;
      const response = await miniflare!.dispatchFetch(`${HARNESS_ORIGIN}/__seed`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: sql,
      });
      if (response.status !== 200) throw new Error(`local seed request failed: ${(await response.text()).slice(0, 300)}`);
    };

    await seed(await readMigration("0001_init.sql"));
    await seed(await readMigration("0004_e2e_generations.sql"));

    const baseStatements: string[] = [];
    for (let index = 0; index < basePublished; index += 1) baseStatements.push(...matrixBaseArticle(index));
    for (const chunk of chunkStatements(baseStatements, 600)) await seed(chunk);

    const withdrawn = "matrix-withdrawn";
    const catalogMismatch = "matrix-catalog-mismatch";
    const metadataApproved = "matrix-metadata-approved";
    const protectedGeneration = "matrix-protected-generation";
    const extraStatements: string[] = [
      articleInsert(withdrawn),
      publicationInsert(withdrawn, "withdrawn"),
      versionInsert(withdrawn),
      articleInsert(catalogMismatch),
      publicationInsert(catalogMismatch),
      versionInsert(catalogMismatch),
      catalogInsert(catalogMismatch, "official-matrix"),
      articleInsert(metadataApproved),
      publicationInsert(metadataApproved),
      versionInsert(metadataApproved),
      classificationInsert(metadataApproved),
      articleInsert(protectedGeneration),
      publicationInsert(protectedGeneration),
      versionInsert(protectedGeneration),
      classificationInsert(protectedGeneration),
    ];
    const generationHash = await generationProjectionHash(
      {
        article_id: protectedGeneration,
        expected_version_id: `pub-${protectedGeneration}`,
        expected_version_revision: 1,
        approval_snapshot_hash: `approval-${protectedGeneration}`,
        expected_publication_id: `p-${protectedGeneration}`,
        expected_publication_revision: 1,
        expected_publication_state: "published",
        policy_version: "policy-v1",
      },
      [],
      null,
    );
    extraStatements.push(...generationInsert(protectedGeneration, generationHash));
    await seed(extraStatements.join("\n"));

    await seed(await readMigration("0011_search_metadata_repair.sql"));
    await seed("UPDATE search_metadata_policy_v1 SET public_read_required=1 WHERE id=1;");
    await seed(
      `INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token,updated_at) VALUES (${[
        sqlString(metadataApproved),
        "1",
        "1",
        sqlString("verified"),
        "0",
        sqlString(NOW),
      ].join(",")});`,
    );

    const expectedVisible = basePublished + 2;
    const runs: SitemapRunReport[] = [];
    for (const combo of SITEMAP_SWITCH_MATRIX) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("workers_sitemap_harness_timeout");
      matrixFetches += 1;
      const url = new URL(`${HARNESS_ORIGIN}/sitemap`);
      url.searchParams.set("fastSitemap", String(combo.fastSitemap));
      url.searchParams.set("jsonGuard", String(combo.jsonGuard));
      const response = await miniflare.dispatchFetch(url.toString());
      const body = await response.text();
      assert.equal(response.status, 200, `${combo.label}: sitemap request failed`);
      assert.equal(response.headers.get("content-type"), "application/xml; charset=utf-8");
      assert.equal(response.headers.get("x-worldcons-fast-sitemap"), String(combo.fastSitemap));
      assert.equal(response.headers.get("x-worldcons-json-guard"), String(combo.jsonGuard));
      const normalized = normalizedHash(body);
      assert.equal(headerNumber(response, "x-worldcons-entry-count"), normalized.entries.length);
      assert.equal(response.headers.get("x-worldcons-normalized-sha256"), normalized.hash);
      assertVisibleAndWithheld(body, expectedVisible);
      const rowsReadAvailable = headerBoolean(response, "x-worldcons-rows-read-available");
      runs.push({
        label: combo.label,
        fastSitemap: combo.fastSitemap,
        jsonGuard: combo.jsonGuard,
        status: response.status,
        entries: normalized.entries.length,
        xmlBytes: Buffer.byteLength(body, "utf8"),
        xmlSha256: sha256Hex(body),
        normalizedSha256: normalized.hash,
        statements: headerNumber(response, "x-worldcons-statements"),
        rowsRead: rowsReadAvailable ? headerNumber(response, "x-worldcons-rows-read") : null,
        rowsReadAvailable,
        workerElapsedMs: headerNumber(response, "x-worldcons-elapsed-ms"),
      });
    }

    const baseline = runs[0];
    for (const run of runs) {
      assert.equal(run.normalizedSha256, baseline.normalizedSha256, `${run.label}: normalized URL set must match baseline`);
      assert.equal(run.xmlSha256, baseline.xmlSha256, `${run.label}: exact XML bytes must match baseline`);
    }

    await seed(
      [
        articleInsert("matrix-pending", {
          publishedAt: "2026-01-15T00:00:00.000Z",
          discoveredAt: "2026-01-15T00:00:00.000Z",
          fetchedAt: "2026-01-15T00:00:00.000Z",
          summarizedAt: "2026-01-15T00:00:00.000Z",
        }),
        publicationInsert("matrix-pending"),
        versionInsert("matrix-pending", { publishedAt: "2026-01-15T00:00:00.000Z" }),
      ].join("\n"),
    );
    await seed(
      `INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token,updated_at) VALUES (${[
        sqlString("matrix-pending"),
        "2",
        "1",
        sqlString("pending"),
        "4",
        sqlString(NOW),
      ].join(",")}) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision,applied_revision=excluded.applied_revision,status=excluded.status,fencing_token=excluded.fencing_token,updated_at=excluded.updated_at;`,
    );

    const negative: NegativeRunReport[] = [];
    for (const combo of SITEMAP_SWITCH_MATRIX) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("workers_sitemap_harness_timeout");
      negativeFetches += 1;
      const url = new URL(`${HARNESS_ORIGIN}/sitemap`);
      url.searchParams.set("fastSitemap", String(combo.fastSitemap));
      url.searchParams.set("jsonGuard", String(combo.jsonGuard));
      const response = await miniflare.dispatchFetch(url.toString());
      const body = await response.text();
      assert.equal(response.status, 200, `${combo.label}: unrelated sitemap entries must remain available`);
      const entries = normalizedHash(body).entries;
      assert.equal(entries.some((entry) => entry.loc === `${BASE_URL}/articles/matrix-pending`), false);
      assert.equal(sha256Hex(body), baseline.xmlSha256, `${combo.label}: withheld repair must not change the safe baseline XML`);
      negative.push({ label: combo.label, status: response.status, pendingWithheld: true, sameXmlAsBaseline: true });
    }

    report = {
      dataset: {
        basePublished,
        totalArticles: basePublished + 4,
        visibleArticles: expectedVisible,
        withheldFixtures: ["withdrawn", "catalog_mismatch"],
      },
      runs,
      parity: {
        allNormalizedSetsEqual: runs.every((run) => run.normalizedSha256 === baseline.normalizedSha256),
        allXmlBytesEqual: runs.every((run) => run.xmlSha256 === baseline.xmlSha256),
        baselineNormalizedSha256: baseline.normalizedSha256,
      },
      negative,
      safety: {
        localD1Binding: LOCAL_D1_BINDING,
        localDatabaseId: LOCAL_D1_DATABASE_ID,
        outboundNetworkDisabled: true,
        tempDirRemoved: false,
        seedFetches,
        matrixFetches,
        negativeFetches,
        workerFetches: seedFetches + matrixFetches + negativeFetches,
        totalElapsedMs: Date.now() - startedAt,
      },
    };
    assert.ok(report.safety.totalElapsedMs <= timeoutMs, "workers sitemap harness must finish inside its bound");
    return report;
  } finally {
    if (miniflare) await miniflare.dispose().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (report) report.safety.tempDirRemoved = !existsSync(tempDir);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(import.meta.url) === entry;
}

if (isMainModule()) {
  runWorkersSitemapAcceptanceGate()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      process.exitCode = 1;
    });
}



