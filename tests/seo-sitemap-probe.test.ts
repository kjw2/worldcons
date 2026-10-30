import assert from "node:assert/strict";
import test from "node:test";
import {
  SITEMAP_PROBE_URL,
  SitemapProbeError,
  probeWorldconsSitemap,
  type SitemapProbeFetch,
} from "../scripts/seo-sitemap-probe";

const ORIGIN = "https://worldcons.cclib.workers.dev";

function absolute(path: string): string {
  return `${ORIGIN}${path}`;
}

function sitemapXml(entries: Array<{ loc: string; lastmod?: string }>): string {
  const body = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : "";
      return `<url><loc>${entry.loc}</loc>${lastmod}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<{ body: string; status?: number; headers?: HeadersInit }>) {
  const requests: RecordedRequest[] = [];
  let call = 0;

  const fetchImpl: SitemapProbeFetch = async (url, init) => {
    requests.push({ url, init });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: response.headers ?? { "content-type": "application/xml; charset=utf-8" },
    });
  };

  return {
    fetchImpl,
    requests,
    get calls() {
      return call;
    },
  };
}

async function expectProbeError(promise: Promise<unknown>, code: string): Promise<SitemapProbeError> {
  let captured: SitemapProbeError | null = null;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SitemapProbeError);
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured);
  return captured;
}

test("probe performs exactly two sequential fixed-endpoint GETs and reports parity", async () => {
  const xml = sitemapXml([
    { loc: absolute("/") },
    { loc: absolute("/list") },
    { loc: absolute("/articles/alpha"), lastmod: "2026-10-01T00:00:00.000Z" },
    { loc: absolute("/articles/beta/"), lastmod: "2026-10-02T00:00:00.000Z" },
  ]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  const report = await probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 });

  assert.equal(mock.calls, 2);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].url, SITEMAP_PROBE_URL);
  assert.equal(new URL(mock.requests[0].url).search, "");
  assert.equal(mock.requests[0].init.method, "GET");
  assert.equal(mock.requests[0].init.redirect, "manual");
  assert.doesNotMatch(JSON.stringify(mock.requests[0].init.headers), /googlebot/iu);

  assert.equal(report.event, "worldcons_seo_sitemap_probe");
  assert.equal(report.endpoint, SITEMAP_PROBE_URL);
  assert.equal(report.runs.length, 2);
  assert.equal(report.bothRunsMatch, true);
  assert.deepEqual(report.mismatchFields, []);
  for (const run of report.runs) {
    assert.equal(run.httpStatus, 200);
    assert.equal(run.urlCount, 4);
    assert.equal(run.articleUrlCount, 2);
    assert.equal(run.uniqueCount, 4);
    assert.equal(run.duplicateCount, 0);
    assert.equal(run.lastmodCount, 2);
    assert.equal(run.xmlValid, true);
    assert.equal(run.canonicalSafe, true);
    assert.equal(run.sameOrigin, true);
    assert.match(run.urlSetSha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(report.runs[0].urlSetSha256, report.runs[1].urlSetSha256);
});

test("probe accepts standard changefreq and priority elements alongside loc and lastmod", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${absolute("/articles/alpha")}</loc><lastmod>2026-10-01T00:00:00.000Z</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url></urlset>`;
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  const report = await probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 });

  assert.equal(report.runs[0].urlCount, 1);
  assert.equal(report.runs[0].articleUrlCount, 1);
  assert.equal(report.runs[0].lastmodCount, 1);
});

test("probe waits the default one-second gap between sequential requests", async () => {
  const xml = sitemapXml([{ loc: absolute("/articles/alpha") }]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);
  const sleeps: number[] = [];

  await probeWorldconsSitemap({
    fetchImpl: mock.fetchImpl,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  assert.deepEqual(sleeps, [1_000]);
});

test("malformed XML fails closed without leaking a response excerpt", async () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>${absolute("/articles/alpha")}</loc></url>`;
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  const error = await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "malformed_xml",
  );

  assert.equal(mock.calls, 2);
  assert.doesNotMatch(error.message, /articles\/alpha/u);
});

test("duplicate normalized URLs fail closed", async () => {
  const duplicate = absolute("/articles/alpha");
  const xml = sitemapXml([{ loc: duplicate }, { loc: `${duplicate}/` }]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  const error = await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "duplicate_urls",
  );

  assert.equal(error.details.duplicateCount, 1);
  assert.doesNotMatch(JSON.stringify(error.details), /alpha/u);
});

test("cross-origin URLs fail closed", async () => {
  const xml = sitemapXml([
    { loc: absolute("/articles/alpha") },
    { loc: "https://foreign.example/articles/beta" },
  ]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  const error = await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "cross_origin",
  );

  assert.equal(error.details.crossOriginUrlCount, 1);
  assert.doesNotMatch(JSON.stringify(error.details), /foreign[.]example/u);
});

test("response size overflow is aborted before parsing", async () => {
  const xml = sitemapXml([{ loc: absolute("/articles/alpha") }]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0, maxResponseBytes: 32 }),
    "response_too_large",
  );
});

test("an otherwise valid sitemap with zero article URLs fails closed", async () => {
  const xml = sitemapXml([{ loc: absolute("/") }, { loc: absolute("/list") }]);
  const mock = mockFetch([{ body: xml }, { body: xml }]);

  await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "no_article_urls",
  );
});

test("non-200 responses fail closed and do not expose the response body", async () => {
  const mock = mockFetch([
    { body: "unexpected upstream failure detail", status: 503 },
    { body: "unexpected upstream failure detail", status: 503 },
  ]);

  const error = await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "http_status",
  );

  assert.equal(error.details.status, 503);
  assert.doesNotMatch(error.message, /unexpected upstream failure detail/u);
});

test("two valid runs with different URL counts or digests fail as a mismatch", async () => {
  const first = sitemapXml([{ loc: absolute("/articles/alpha") }]);
  const second = sitemapXml([{ loc: absolute("/articles/beta") }]);
  const mock = mockFetch([{ body: first }, { body: second }]);

  const error = await expectProbeError(
    probeWorldconsSitemap({ fetchImpl: mock.fetchImpl, gapMs: 0 }),
    "run_mismatch",
  );

  const fields = error.details.mismatchFields as string[];
  assert.ok(fields.includes("urlSetSha256"));
  assert.doesNotMatch(JSON.stringify(error.details), /alpha|beta/u);
});

test("request timeouts are bounded and reported as timeouts", async () => {
  const fetchImpl: SitemapProbeFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });

  await expectProbeError(
    probeWorldconsSitemap({ fetchImpl, gapMs: 0, timeoutMs: 5 }),
    "timeout",
  );
});
