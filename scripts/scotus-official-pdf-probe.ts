/**
 * Real-origin SCOTUS official PDF probe (bounded, read-only).
 *
 * Runs the actual production crawl path (`crawlNativeStageCandidate` ->
 * `fetchScotusPdf` -> robots/redirect/MIME/size checks -> `extractOfficialScotusPdf`)
 * against a genuine supremecourt.gov slip-opinion PDF, using a temporary
 * in-memory R2 bucket. It performs no Production D1/R2 write and no publication.
 *
 * Usage:
 *   pnpm exec tsx scripts/scotus-official-pdf-probe.ts [pdfUrl] [docket]
 * Defaults to the real eligible 2025-term application PDF (26A388).
 */
import {
  crawlNativeStageCandidate,
  type NativeCrawlerBindings,
  type NativeStageCandidate,
} from "../workers/async-pipeline/src/native-crawler";
import { isOfficialScotusPdfUrl } from "../workers/async-pipeline/src/scotus-pdf";

const DEFAULT_URL = "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf";
const DEFAULT_DOCKET = "26A388";
const LISTING_URL = "https://www.supremecourt.gov/opinions/slipopinion/25";

async function main() {
  const url = process.argv[2] ?? DEFAULT_URL;
  const docket = process.argv[3] ?? DEFAULT_DOCKET;
  if (!isOfficialScotusPdfUrl(url)) throw new Error(`not_an_official_scotus_pdf_url:${url}`);

  const written = new Map<string, { bytes: Uint8Array; sha256: string; contentType: string | null }>();
  const bindings = {
    WORLDCONS_CORE: {} as never,
    WORLDCONS_INGEST: {} as never,
    WORLDCONS_RAW: {
      async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
        const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", value as BufferSource)).toString("hex");
        written.set(key, { bytes: value, sha256, contentType: options?.httpMetadata?.contentType ?? null });
      },
    },
  } as unknown as NativeCrawlerBindings;

  const candidate: NativeStageCandidate = {
    sourceKey: "us-scotus",
    url,
    title: "probe",
    contentType: "opinion",
    metadata: { docket, listingUrl: LISTING_URL, collection: {} },
  };

  const result = await crawlNativeStageCandidate(candidate, bindings, { fetch });
  const provenance = (result.candidate.metadata.officialPdf ?? null) as Record<string, unknown> | null;
  const stored = provenance ? written.get(String(provenance.r2Key)) : undefined;
  const summary = {
    mode: "real_origin_in_memory_bucket",
    production_write: false,
    url,
    docket,
    fetched: result.fetched,
    status: result.status,
    finalUrl: provenance?.url ?? null,
    pageCount: provenance?.pageCount ?? null,
    docketVerified: provenance?.docketVerified ?? false,
    extractor: provenance?.extractor ?? null,
    pdfSha256: provenance?.sha256 ?? null,
    r2Key: provenance?.r2Key ?? null,
    r2OriginalWritten: Boolean(stored),
    r2StoredShaMatches: stored ? stored.sha256 === provenance?.sha256 : false,
    textLength: result.text.length,
    textHead: result.text.slice(0, 160),
    review: result.candidate.metadata.review ?? null,
    collection: result.candidate.metadata.collection ?? null,
    error: (result.candidate.metadata.pdfExtractionError as string | undefined) ?? null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.fetched) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
