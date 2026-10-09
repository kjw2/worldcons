import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveNativeRangeDays,
  crawlNativeStageCandidate,
  parseNativeSourceListing,
  runNativeSourceCollection,
  type NativeCrawlerBindings,
  type NativeCrawlerSource,
} from "../workers/async-pipeline/src/native-crawler";

const now = new Date("2026-09-30T00:00:00.000Z");
const robots = "User-agent: *\nAllow: /\nCrawl-delay: 0";

function response(body: string, status = 200, contentType = "text/html") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function fixture(source: NativeCrawlerSource) {
  const decisionText = "Official judgment text on constitutional rights and the governing legal principles. ".repeat(25);
  if (source === "de-bverfg") {
    const listing = `<a href="/SharedDocs/Entscheidungen/DE/2026/09/rs20260920_2bvr123426.html">Beschluss vom 20.09.2026 - 2 BvR 1234/26</a>`;
    return {
      listingUrl: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
      listing,
      detail: `<html><main><h1>Beschluss 2 BvR 1234/26</h1><p>ECLI:DE:BVerfG:2026:rs20260920.2bvr123426</p>${decisionText}</main></html>`,
      detailPath: "/SharedDocs/Entscheidungen/DE/2026/09/rs20260920_2bvr123426.html",
    };
  }
  if (source === "fr-conseil-constitutionnel") {
    const listing = `<a href="/decision/2026/2026912QPC.htm">Décision n° 2026-912 QPC du 28 septembre 2026</a>`;
    return {
      listingUrl: "https://www.conseil-constitutionnel.fr/les-decisions",
      listing,
      detail: `<html><main><h1>Décision n° 2026-912 QPC</h1>${decisionText}</main></html>`,
      detailPath: "/decision/2026/2026912QPC.htm",
    };
  }
  if (source === "es-tribunal-constitucional") {
    return {
      listingUrl: "https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index",
      listing: `<a href="/HJ/es/Resolucion/Show/32117">SENTENCIA 4/2026 de 28 septiembre 2026</a>`,
      detail: "<html><main>Official listing record</main></html>",
      detailPath: "/HJ/es/Resolucion/Show/32117",
      apiPath: "/HJ/Resolucion/Api/json/32117",
      api: JSON.stringify({
        TIPO_RESOLUCION: "SENTENCIA",
        NUMERO_RESOLUCION: 4,
        ANNO_RESOLUCION: 2026,
        FECHA_REGISTRO: "28/09/2026",
        RESOLUCIONES_FUNDAMENTOS: [{ TEXTO: decisionText.repeat(2) }],
      }),
    };
  }
  return {
    listingUrl: "https://www.supremecourt.gov/opinions/slipopinion/25",
    listing: `<table><tr><td>Opinion</td><td>9/28/26</td><td>26-100</td><td><a href="/opinions/25pdf/26-100.pdf">Opinion of the Court</a></td></tr></table>`,
    detail: "",
    detailPath: "",
  };
}

function memoryBindings() {
  const runs = new Map<string, Record<string, unknown>>();
  const articles = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const blobs = new Map<string, Uint8Array>();
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = (kind: "core" | "ingest") => ({
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        query: sql,
        get values() { return values; },
        bind(...args: unknown[]) { values = args; return this; },
        async first<T>() {
          if (sql.includes("SELECT id, content_hash")) return (articles.get(String(values[0])) ?? null) as T | null;
          if (sql.includes("SELECT id FROM articles WHERE content_hash")) return null;
          if (sql.includes("SELECT id FROM sources")) return { id: "source-id" } as T;
          if (sql.includes("SELECT status, metadata FROM ingestion_runs")) return (runs.get(String(values[0])) ?? null) as T | null;
          if (sql.includes("MAX(CAST(json_extract(source_metadata,'$.hjId') AS INTEGER))")) return { max_hj_id: 32140 } as T;
          return null;
        },
        async all<T>() {
          if (kind === "core" && sql.includes("SELECT * FROM articles WHERE id = ?")) {
            const article = [...articles.values()].find((row) => row.id === values[0]);
            return { results: article ? [article as T] : [] };
          }
          if (kind === "core" && sql.includes("SELECT id,lifecycle_revision")) {
            const article = [...articles.values()].find((row) => row.id === values[0]);
            return { results: article ? [{
              id: article.id,
              lifecycle_revision: article.lifecycle_revision ?? 0,
              lifecycle_collection_state: article.lifecycle_collection_state ?? null,
              lifecycle_processing_state: article.lifecycle_processing_state ?? null,
              lifecycle_review_state: article.lifecycle_review_state ?? null,
              lifecycle_attention_state: article.lifecycle_attention_state ?? null,
              lifecycle_attention_code: article.lifecycle_attention_code ?? null,
              lifecycle_attention_retryable: article.lifecycle_attention_retryable ?? null,
              lifecycle_attention_severity: article.lifecycle_attention_severity ?? null,
              lifecycle_attention_source: article.lifecycle_attention_source ?? null,
            } as T] : [] };
          }
          return { results: [] as T[] };
        },
        async run() {
          assert.equal((sql.match(/\?/g) ?? []).length, values.length, `SQL bind count mismatch: ${sql}`);
          statements.push({ sql, values });
          if (kind === "core" && sql.includes("INSERT INTO articles")) {
            articles.set(String(values[7]), {
              id: values[0], canonical_url: values[7], content_hash: values[17], status: values[13], slug: values[14],
              translation_status: values[15], cleaned_text: values[16], source_metadata: values[18], review_state: values[21],
              lifecycle_revision: 0, raw_text_blob_size: values[24],
            });
          }
          if (kind === "core" && sql.includes("UPDATE articles SET review_state=?")) {
            const article = [...articles.values()].find((row) => row.id === values[1]);
            assert.ok(article, "legacy review state update targets the inserted article");
            article.review_state = values[0];
          }
          if (kind === "ingest" && sql.includes("INSERT INTO source_url_candidates")) {
            candidates.set(String(values[2]), { source_key: values[1], url: values[2], status: values[3], last_error_code: values[5] });
          }
          if (kind === "ingest" && sql.includes("INSERT INTO ingestion_runs")) {
            runs.set(String(values[0]), { id: values[0], source_key: values[1], started_at: values[2], status: "running", metadata: values[3] });
          }
          if (kind === "ingest" && sql.includes("UPDATE ingestion_runs SET finished_at")) {
            const current = runs.get(String(values[7]))!;
            runs.set(String(values[7]), { ...current, finished_at: values[0], status: values[1], discovered_count: values[2], fetched_count: values[3], failed_count: values[4], error_message: values[5], metadata: values[6] });
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    async batch(batchStatements: Array<{ query: string; values: unknown[] }>) {
      const results = [];
      for (const statement of batchStatements) {
        const prepared = statement as unknown as { query: string; values: unknown[] };
        assert.equal((prepared.query.match(/\?/g) ?? []).length, prepared.values.length, `SQL bind count mismatch: ${prepared.query}`);
        statements.push({ sql: prepared.query, values: prepared.values });
        if (prepared.query.includes("UPDATE articles SET lifecycle_collection_state=")) {
          const values = prepared.values;
          const article = [...articles.values()].find((row) => row.id === values.at(-2));
          assert.ok(article, "lifecycle transition targets the inserted article");
          Object.assign(article, {
            lifecycle_collection_state: values[0], lifecycle_processing_state: values[1], lifecycle_review_state: values[2],
            lifecycle_attention_state: values[3], lifecycle_attention_code: values[4], lifecycle_attention_retryable: values[5],
            lifecycle_attention_severity: values[6], lifecycle_attention_source: values[7], lifecycle_revision: values[10],
          });
        }
        results.push({ success: true, meta: { changes: 1 } });
      }
      return results;
    },
  });
  return {
    bindings: {
      WORLDCONS_CORE: db("core"),
      WORLDCONS_INGEST: db("ingest"),
      WORLDCONS_RAW: { async put(key: string, bytes: Uint8Array) { blobs.set(key, bytes); } },
    } as unknown as NativeCrawlerBindings,
    runs,
    articles,
    candidates,
    blobs,
    statements,
  };
}

test("native source parser discovers only official records for all four sources", () => {
  const bverfg = parseNativeSourceListing("de-bverfg", `<a href="/SharedDocs/Entscheidungen/DE/2026/09/rs20260920_2bvr123426.html">Beschluss vom 20.09.2026 - 2 BvR 1234/26</a><a href="https://evil.example/SharedDocs/Entscheidungen/DE/2026/09/rs20260920_2bvr123426.html">external</a>`);
  assert.equal(bverfg.length, 1);
  assert.equal(bverfg[0].sourceKey, "de-bverfg");
  assert.equal(bverfg[0].metadata.caseNumber, "2 BvR 1234/26");

  const scotus = parseNativeSourceListing("us-scotus", `<table class="table"><tr><td>Opinion</td><td>9/28/26</td><td>26-100</td><td><a href="/opinions/25pdf/26-100.pdf">Opinion of the Court</a></td></tr></table>`, "https://www.supremecourt.gov/opinions/slipopinion/25");
  assert.equal(scotus.length, 1);
  assert.equal(scotus[0].contentType, "opinion");
  assert.equal(scotus[0].metadata.docket, "26-100");
  assert.equal((scotus[0].metadata.collection as Record<string, unknown>).publishable, false);
  assert.equal((scotus[0].metadata.review as Record<string, unknown>).required, true);

  const france = parseNativeSourceListing("fr-conseil-constitutionnel", `<a href="/decision/2026/2026912QPC.htm">Décision n° 2026-912 QPC du 28 septembre 2026</a><a href="https://example.net/decision/2026/2026913DC.htm">other</a>`);
  assert.equal(france.length, 1);
  assert.equal(france[0].metadata.decisionNumber, "n° 2026-912 QPC");
  const franceL = parseNativeSourceListing("fr-conseil-constitutionnel", `<a href="/decision/2026/2026335L.htm">Décision n° 2026-335 L du 8 octobre 2026</a>`);
  assert.equal(franceL.length, 1);
  assert.equal(franceL[0].metadata.decisionNumber, "n° 2026-335 L");

  const spain = parseNativeSourceListing("es-tribunal-constitucional", `<a href="/HJ/es/Resolucion/Show/32117">SENTENCIA 4/2026 de 28 septiembre 2026</a>`);
  assert.equal(spain.length, 1);
  assert.equal(spain[0].metadata.hjId, "32117");
  const spainWithPlaceholder = parseNativeSourceListing("es-tribunal-constitucional", `<a href="/HJ/es/Resolucion/Show/0">placeholder</a><a href="/HJ/es/Resolucion/Show/32117">SENTENCIA 4/2026</a>`);
  assert.equal(spainWithPlaceholder.length, 1, "Show/0 must not consume a one-item staged canary");
  assert.equal(spainWithPlaceholder[0].metadata.hjId, "32117");
});

test("targeted staged crawl preserves the actually fetched BVerfG official URL variant", async () => {
  const store = memoryBindings();
  const firstUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260917_2bvr170226.html";
  const verifiedUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rs20260917_2bvr170226.html";
  const candidate = {
    sourceKey: "de-bverfg" as const,
    url: firstUrl,
    title: "BVerfG 2 BvR 1702/26",
    contentType: "decision" as const,
    metadata: {
      discoveryIndex: "openlegaldata",
      ecli: "ECLI:DE:BVerfG:2026:rk20260917.2bvr170226",
      officialUrlCandidates: [firstUrl, verifiedUrl],
      collection: { strategy: "api", sourceUrlVerified: false, sourceTextAvailable: false, publishable: false },
    },
  };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return response(robots);
    if (url === firstUrl) return response("not published", 404);
    if (url === verifiedUrl) return response(`<html><main><p>ECLI:DE:BVerfG:2026:rs20260917.2bvr170226</p>${"Official verified decision text. ".repeat(30)}</main></html>`);
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await crawlNativeStageCandidate(candidate, store.bindings, { fetch: fetcher });
  assert.equal(result.fetched, true);
  assert.equal(result.canonicalUrl, verifiedUrl);
  assert.equal(result.candidate.url, verifiedUrl);
  assert.equal((result.candidate.metadata.collection as Record<string, unknown>).sourceUrlVerified, true);
  assert.equal(result.candidate.metadata.ecli, "ECLI:DE:BVerfG:2026:rs20260917.2bvr170226");
  assert.equal(result.candidate.metadata.discoveryEcli, "ECLI:DE:BVerfG:2026:rk20260917.2bvr170226");
  assert.equal(result.candidate.publishedAt, "2026-09-17T00:00:00.000Z");
  assert.equal(result.candidate.metadata.officialIdentityVerification, "bverfg-ecli-exact-v1");
});

test("BVerfG staged crawl rejects HTTP 200 pages without the exact official decision ECLI", async () => {
  const store = memoryBindings();
  const url = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260901_2bvr128625.html";
  const candidate = {
    sourceKey: "de-bverfg" as const,
    url,
    title: "BVerfG 2 BvR 1286/25",
    contentType: "decision" as const,
    metadata: { discoveryIndex: "official-listing", collection: { sourceUrlVerified: false, sourceTextAvailable: false, publishable: false } },
  };
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return response(robots);
    if (String(input) === url) return response(`<html><main><p>ECLI:DE:BVerfG:2026:rk20260901.2bvr999925</p>${"Generic court navigation text. ".repeat(60)}</main></html>`);
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  await assert.rejects(crawlNativeStageCandidate(candidate, store.bindings, { fetch: fetcher }), /crawler\.bverfg_official_identity_mismatch/);
  assert.equal((candidate.metadata.collection as Record<string, unknown>).sourceUrlVerified, false);
  assert.equal(store.articles.size, 0);
  assert.equal(store.blobs.size, 0);
});

test("BVerfG official redirects retain the verified final decision URL and ECLI", async () => {
  const store = memoryBindings();
  const originalUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260901_2bvr128625.html";
  const finalUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rs20260901_2bvr128625.html";
  const candidate = {
    sourceKey: "de-bverfg" as const,
    url: originalUrl,
    title: "BVerfG 2 BvR 1286/25",
    contentType: "decision" as const,
    metadata: { discoveryIndex: "official-listing", collection: { sourceUrlVerified: false, sourceTextAvailable: false, publishable: false } },
  };
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return response(robots);
    if (String(input) === originalUrl) {
      const result = response(`<html><main><p>ECLI:DE:BVerfG:2026:rs20260901.2bvr128625</p>${"Official court decision text. ".repeat(40)}</main></html>`);
      Object.defineProperty(result, "url", { value: finalUrl });
      return result;
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  const result = await crawlNativeStageCandidate(candidate, store.bindings, { fetch: fetcher });
  assert.equal(result.canonicalUrl, finalUrl);
  assert.equal(result.candidate.url, finalUrl);
  assert.equal((result.candidate.metadata.collection as Record<string, unknown>).sourceUrlVerified, true);
});

test("targeted staged crawl carries corrected Spanish official JSON metadata into normalize", async () => {
  const store = memoryBindings();
  const candidate = parseNativeSourceListing("es-tribunal-constitucional", `<a href="/HJ/es/Resolucion/Show/32117">Undated listing</a>`)[0];
  assert.ok(candidate);
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return response(robots);
    if (/\/(?:HJ\/)?Resolucion\/Api\/json\/32117$/.test(url)) {
      return response(JSON.stringify({
        TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 4, ANNO_RESOLUCION: 2026,
        FECHA_REGISTRO: "28/09/2026", RESOLUCIONES_FUNDAMENTOS: [{ TEXTO: "Official court judgment text. ".repeat(120) }],
      }), 200, "application/json");
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await crawlNativeStageCandidate(candidate, store.bindings, { fetch: fetcher });
  assert.equal(result.fetched, true);
  assert.match(result.candidate.title, /SENTENCIA 4\/2026/);
  assert.equal(result.candidate.publishedAt, "2026-09-28T00:00:00.000Z");
  const collection = result.candidate.metadata.collection as Record<string, unknown>;
  assert.equal(collection.sourceUrlVerified, true);
  assert.equal(collection.sourceTextAvailable, true);
});

test("native range floors and Spain cap match collection policy", () => {
  assert.equal(effectiveNativeRangeDays("de-bverfg", 14), 60);
  assert.equal(effectiveNativeRangeDays("us-scotus", 7), 14);
  assert.equal(effectiveNativeRangeDays("fr-conseil-constitutionnel", 7), 14);
  assert.equal(effectiveNativeRangeDays("es-tribunal-constitucional", 14), 180);
  assert.equal(effectiveNativeRangeDays("es-tribunal-constitucional", 900), 730);
});

test("one synthetic collection request persists one pending case but DOES NOT automatically translate or publish", async () => {
  const source = "fr-conseil-constitutionnel";
  const data = fixture(source);
  const store = memoryBindings();
  const requested: string[] = [];
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => now.getTime() + tick++ * 10_000;
  try {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === data.listingUrl) return response(data.listing);
      if (url.endsWith(data.detailPath)) return response(data.detail);
      throw new Error(`unexpected mocked fetch ${url}`);
    };
    const requestId = "fake-collection-one-france-20260930";
    const run = await runNativeSourceCollection(source, store.bindings, {
      now, limit: 1, fetch: fetcher, idempotencyKey: requestId,
    });
    assert.deepEqual({discovered:run.discoveredCount,fetched:run.fetchedCount,inserted:run.insertedCount,failed:run.failedCount},
      {discovered:1,fetched:1,inserted:1,failed:0});
    assert.equal(run.outcome,"success");
    assert.equal(store.articles.size,1);
    assert.equal(store.blobs.size,1,"raw source must be persisted in R2 (mock)");
    const [article] = store.articles.values();
    assert.equal(article.status,"cleaned","collection stops at cleaned");
    assert.equal(article.translation_status,"pending","separate translation cron is still required");
    assert.equal(store.statements.some(x=>/INSERT INTO article_publications_p3|UPDATE articles SET status='summarized'/u.test(x.sql)),false,
      "crawler must not secretly publish or translate via an implicit write");
    const replay = await runNativeSourceCollection(source,store.bindings,{now,limit:1,fetch:fetcher,idempotencyKey:requestId});
    assert.equal(replay.replayed,true,"same fake request must be idempotent");
    assert.equal(store.articles.size,1);
    assert.ok(requested.every(x=>x.startsWith("https://www.conseil-constitutionnel.fr/")),"fake transport must stay on the simulated official domain");
  } finally { Date.now=originalNow; }
});

test("native collection keeps source-specific publication and review gates", async () => {
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  try {
    for (const source of ["de-bverfg", "us-scotus", "fr-conseil-constitutionnel", "es-tribunal-constitucional"] as const) {
      const data = fixture(source);
      const store = memoryBindings();
      let browserCalls = 0;
      const fetcher: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return response(robots);
        if (source === "fr-conseil-constitutionnel" && url === data.listingUrl) return response(data.listing, 403);
        if (url === data.listingUrl) return response(data.listing);
        if ("apiPath" in data && typeof data.apiPath === "string" && typeof data.api === "string" && url.endsWith(data.apiPath)) return response(data.api, 200, "application/json");
        if (url.endsWith(data.detailPath)) return response(data.detail);
        throw new Error(`unexpected fetch ${url}`);
      };
      const browserNavigate = async ({ url }: { url: string }) => {
        browserCalls += 1;
        return { html: data.listing, finalUrl: url, status: 200, headers: { "content-type": "text/html" } };
      };
      const result = await runNativeSourceCollection(source, store.bindings, {
        now,
        limit: 20,
        fetch: fetcher,
        browserNavigate,
        idempotencyKey: `m8:crawler-daily:${source}:2026-09-30T00:00:00.000Z`,
      });
      assert.equal(result.status, "completed", source);
      assert.equal(result.failedCount, 0, `${JSON.stringify(result)} ${JSON.stringify([...store.runs.values()])}`);
      assert.equal(store.articles.size, 1, source);
      assert.equal(store.runs.size, 1, source);
      assert.equal(store.candidates.size, 1, source);
      assert.equal(store.blobs.size, 1, source);
      const article = [...store.articles.values()][0];
      const metadata = JSON.parse(String(article.source_metadata)) as { collection: { publishable: boolean; sourceTextAvailable: boolean } };
      if (source === "us-scotus") {
        assert.equal(article.status, "metadata_only");
        assert.equal(article.review_state, "needs_triage");
        assert.equal(article.lifecycle_collection_state, "metadata_only");
        assert.equal(article.lifecycle_processing_state, "not_ready");
        assert.equal(article.lifecycle_review_state, "needs_review");
        assert.equal(metadata.collection.publishable, false);
        assert.equal(browserCalls, 0);
        assert.equal([...store.candidates.values()][0].status, "retrying");
      } else {
        assert.equal(article.status, "cleaned", source);
        assert.equal(article.lifecycle_collection_state, "source_text_ready", source);
        assert.equal(article.lifecycle_processing_state, "ready", source);
        assert.equal(metadata.collection.publishable, true, source);
        assert.equal(metadata.collection.sourceTextAvailable, true, source);
        assert.equal(browserCalls, source === "fr-conseil-constitutionnel" ? 1 : 0);
        assert.equal([...store.candidates.values()][0].status, "fetched", source);
      }
      assert.equal(typeof article.raw_text_blob_size, "string", "D1 bigint values use decimal text");
    }
  } finally {
    Date.now = originalNow;
  }
});

test("BVerfG native discovery falls back to OpenLegalData candidates but fetches only official source text", async () => {
  const store = memoryBindings();
  const requested: string[] = [];
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  try {
    const firstOfficialUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260917_2bvr170226.html";
    const officialUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rs20260917_2bvr170226.html";
    const officialText = `ECLI:DE:BVerfG:2026:rs20260917.2bvr170226\n${"Verified official BVerfG decision text on constitutional rights. ".repeat(20)}`;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html") return response("<html><main>No decision links on landing page</main></html>");
      if (url.startsWith("https://de.openlegaldata.io/api/cases/")) return response(JSON.stringify({ next: null, results: [{ file_number: "2 BvR 1702/26", date: "2026-09-17", type: "Einstweilige Anordnung", ecli: "ECLI:DE:BVerfG:2026:rk20260917.2bvr170226" }] }), 200, "application/json");
      if (url === firstOfficialUrl) return response("not published", 404);
      if (url === officialUrl) return response(`<html><main>${officialText}</main></html>`);
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await runNativeSourceCollection("de-bverfg", store.bindings, { now, limit: 20, fetch: fetcher, idempotencyKey: "m8:crawler-daily:bverfg-live-fallback" });
    assert.equal(result.discoveredCount, 1);
    assert.equal(result.fetchedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.ok(requested.some((url) => url.startsWith("https://de.openlegaldata.io/api/cases/")));
    assert.ok(requested.includes(firstOfficialUrl));
    assert.ok(requested.includes(officialUrl));
    const article = [...store.articles.values()][0];
    assert.equal(article.canonical_url, officialUrl);
    const metadata = JSON.parse(String(article.source_metadata)) as { discoveryIndex?: string; collection: { sourceUrlVerified: boolean; publishable: boolean } };
    assert.equal(metadata.discoveryIndex, "openlegaldata");
    assert.equal(metadata.collection.sourceUrlVerified, true);
    assert.equal(metadata.collection.publishable, true);
  } finally {
    Date.now = originalNow;
  }
});

test("BVerfG unpublished official variants remain a bounded retry candidate instead of failing the source run", async () => {
  const store = memoryBindings();
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  try {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html") return response("<html><main>No decision links</main></html>");
      if (url.startsWith("https://de.openlegaldata.io/api/cases/")) return response(JSON.stringify({ next: null, results: [{ file_number: "2 BvR 1702/26", date: "2026-09-17", type: "Einstweilige Anordnung", ecli: "ECLI:DE:BVerfG:2026:rk20260917.2bvr170226" }] }), 200, "application/json");
      if (/\/SharedDocs\/Entscheidungen\/DE\/2026\/09\/(?:rk|rs)20260917_2bvr170226\.html$/.test(url)) return response("not published", 404);
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await runNativeSourceCollection("de-bverfg", store.bindings, { now, limit: 20, fetch: fetcher, idempotencyKey: "m8:crawler-daily:bverfg-unpublished" });
    assert.equal(result.status, "completed");
    assert.equal(result.discoveredCount, 1);
    assert.equal(result.fetchedCount, 0);
    assert.equal(result.uncollectedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(result.outcome,"degraded","a successful Workflow envelope must not conceal an official-source 404");
    assert.equal(store.articles.size, 0);
    assert.equal([...store.candidates.values()][0].last_error_code, "BVERFG_OFFICIAL_VARIANTS_404");
  } finally {
    Date.now = originalNow;
  }
});

test("BVerfG transient official 5xx falls back to discovery and remains uncollected instead of failing the source run", async () => {
  const store = memoryBindings();
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  try {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html") {
        return response("temporary tls/origin failure", 525);
      }
      if (url.startsWith("https://de.openlegaldata.io/api/cases/")) {
        return response(JSON.stringify({
          next: null,
          results: [{
            file_number: "2 BvR 1702/26",
            date: "2026-09-17",
            type: "Einstweilige Anordnung",
            ecli: "ECLI:DE:BVerfG:2026:rk20260917.2bvr170226",
          }],
        }), 200, "application/json");
      }
      if (/\/SharedDocs\/Entscheidungen\/DE\/2026\/09\/(?:rk|rs)20260917_2bvr170226\.html$/.test(url)) {
        return response("temporary tls/origin failure", 525);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await runNativeSourceCollection("de-bverfg", store.bindings, {
      now,
      limit: 20,
      fetch: fetcher,
      idempotencyKey: "m8:crawler-daily:bverfg-transient-525",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.discoveredCount, 1);
    assert.equal(result.fetchedCount, 0);
    assert.equal(result.uncollectedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(store.articles.size, 0);
    assert.equal([...store.candidates.values()][0].last_error_code, "BVERFG_OFFICIAL_TRANSIENT_5XX");
  } finally {
    Date.now = originalNow;
  }
});

test("BVerfG OpenLegalData 429 records degraded discovery without failing the daily source step", async () => {
  const store = memoryBindings();
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  try {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html") {
        return response("temporary tls/origin failure", 525);
      }
      if (url.startsWith("https://de.openlegaldata.io/api/cases/")) {
        return response("rate limited", 429, "application/json");
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await runNativeSourceCollection("de-bverfg", store.bindings, {
      now,
      limit: 20,
      fetch: fetcher,
      idempotencyKey: "m8:crawler-daily:bverfg-discovery-429",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.discoveredCount, 0);
    assert.equal(result.fetchedCount, 0);
    assert.equal(result.uncollectedCount, 0);
    assert.equal(result.failedCount, 0);
    const run = [...store.runs.values()][0];
    assert.equal(run.error_message, "BVERFG_DISCOVERY_RATE_LIMITED_429");
    const metadata = JSON.parse(String(run.metadata)) as { outcome?: string; discoveryUnavailableCode?: string | null };
    assert.equal(metadata.outcome, "degraded");
    assert.equal(metadata.discoveryUnavailableCode, "BVERFG_DISCOVERY_RATE_LIMITED_429");
  } finally {
    Date.now = originalNow;
  }
});

test("Spain native discovery probes official JSON ids after the D1 HJ tail and stops after three empty ids", async () => {
  const store = memoryBindings();
  const requestedIds: number[] = [];
  const browserIds: number[] = [];
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  const substantive = "Texto oficial de la resolución constitucional. ".repeat(60);
  try {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url === "https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index") return response("<html><main>search shell without result links</main></html>");
      const idMatch = url.match(/\/(?:HJ\/)?Resolucion\/Api\/json\/(\d+)$/);
      if (idMatch) {
        const id = Number(idMatch[1]);
        requestedIds.push(id);
        if (id === 32141 && url.includes("/HJ/Resolucion/")) throw new TypeError("simulated Worker fetch transport failure");
        if (id === 32141) return response(JSON.stringify({ TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 61, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "29/09/2026", RESOLUCIONES_FUNDAMENTOS: [{ TEXTO: substantive }] }), 200, "application/json");
        if (id === 32142) return response(JSON.stringify({ TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: id - 32080, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "30/09/2026", RESOLUCIONES_FUNDAMENTOS: [{ TEXTO: substantive }] }), 200, "application/json");
        return response("{}", 404, "application/json");
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const browserNavigate = async ({ url }: { url: string }) => {
      const id = Number(url.match(/\/(?:HJ\/)?Resolucion\/Api\/json\/(\d+)$/)?.[1] ?? 0);
      browserIds.push(id);
      return { html: "<html><body></body></html>", finalUrl: url, status: 404, headers: { "content-type": "text/html" } };
    };
    const result = await runNativeSourceCollection("es-tribunal-constitucional", store.bindings, { now, limit: 20, fetch: fetcher, browserNavigate, idempotencyKey: "m8:crawler-daily:spain-tail" });
    assert.equal(result.discoveredCount, 2);
    assert.equal(result.fetchedCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual([...new Set(requestedIds)].slice(0, 5), [32141, 32142, 32143, 32144, 32145]);
    assert.ok(browserIds.includes(32141), "the first official API path can fall back through Browser Rendering before the alternate API path succeeds");
    assert.equal(store.articles.size, 2);
    for (const article of store.articles.values()) {
      const metadata = JSON.parse(String(article.source_metadata)) as { collection: { publishable: boolean; sourceTextAvailable: boolean } };
      assert.equal(metadata.collection.publishable, true);
      assert.equal(metadata.collection.sourceTextAvailable, true);
    }
  } finally {
    Date.now = originalNow;
  }
});

test("Spain native discovery uses the authenticated official search session before tail probing", async () => {
  const store = memoryBindings();
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => Date.parse(now.toISOString()) + tick++ * 10_000;
  const token = "csrf-test-token";
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return response(robots);
      if (url.endsWith("/HJ/es/Busqueda/Index")) return new Response(`<input name="__RequestVerificationToken" type="hidden" value="${token}" />`, { status: 200, headers: { "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=session-test; Path=/; HttpOnly" } });
      if (url.endsWith("/HJ/es/Busqueda/BuscarAjax")) {
        assert.equal(init?.method, "POST");
        const headers = new Headers(init?.headers);
        assert.match(headers.get("cookie") ?? "", /ASP\.NET_SessionId=session-test/);
        assert.match(String(init?.body ?? ""), new RegExp(`__RequestVerificationToken=${token}`));
        return response('{"success":"1"}', 200, "application/json");
      }
      if (url.endsWith("/HJ/es/Resolucion/List?page=1")) return response('<a href="/HJ/es/Resolucion/Show/32141">SENTENCIA 62/2026</a>');
      if (url.endsWith("/HJ/es/Resolucion/List?page=2")) return response("<html></html>");
      if (/\/(?:HJ\/)?Resolucion\/Api\/json\/32141$/.test(url)) return response(JSON.stringify({ TIPO_RESOLUCION: "SENTENCIA", NUMERO_RESOLUCION: 62, ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "22/09/2026 0:00:00", CONTENIDO_IRRELEVANTE_PARA_INTERNET: false, AVISO: "Este auto no incorpora doctrina constitucional." }), 200, "application/json");
      if (url.includes("/Busqueda/BuscarAjax")) return response('{"success":"0","message":"No se han encontrado resultados"}', 200, "application/json");
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await runNativeSourceCollection("es-tribunal-constitucional", store.bindings, { now, limit: 20, fetch: fetcher, idempotencyKey: "m8:crawler-daily:spain-search-session" });
    assert.equal(result.status, "completed");
    assert.equal(result.discoveredCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(store.articles.size, 1);
    const article = [...store.articles.values()][0];
    assert.equal(article.status, "metadata_only");
    assert.equal(article.review_state, "needs_triage");
    const metadata = JSON.parse(String(article.source_metadata)) as { discoveryIndex?: string; hjId?: string };
    assert.equal(metadata.discoveryIndex, "official-search");
    assert.equal(metadata.hjId, "32141");
  } finally {
    Date.now = originalNow;
  }
});
