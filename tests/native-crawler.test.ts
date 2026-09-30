import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveNativeRangeDays,
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
      detail: `<html><main><h1>Beschluss 2 BvR 1234/26</h1>${decisionText}</main></html>`,
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
              id: values[0], canonical_url: values[7], content_hash: values[16], status: values[13], slug: values[14],
              cleaned_text: values[15], source_metadata: values[17], review_state: values[20],
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

  const spain = parseNativeSourceListing("es-tribunal-constitucional", `<a href="/HJ/es/Resolucion/Show/32117">SENTENCIA 4/2026 de 28 septiembre 2026</a>`);
  assert.equal(spain.length, 1);
  assert.equal(spain[0].metadata.hjId, "32117");
});

test("native range floors and Spain cap match collection policy", () => {
  assert.equal(effectiveNativeRangeDays("de-bverfg", 14), 60);
  assert.equal(effectiveNativeRangeDays("us-scotus", 7), 14);
  assert.equal(effectiveNativeRangeDays("fr-conseil-constitutionnel", 7), 14);
  assert.equal(effectiveNativeRangeDays("es-tribunal-constitucional", 14), 180);
  assert.equal(effectiveNativeRangeDays("es-tribunal-constitucional", 900), 730);
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
