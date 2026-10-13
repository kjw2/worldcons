import { extractText, getDocumentProxy } from "unpdf";
import {
  isOfficialScotusPdfUrl,
  normalizeScotusDocket as normalizeDocket,
  scotusBodyDocketMatches,
} from "../../../lib/ingest/official-source-verify";

/** Bounded PDF.js work for the M8 SCOTUS collector (not a publication gate). */
export const SCOTUS_PDF_MAX_BYTES = 8 * 1024 * 1024;
const SCOTUS_PDF_MAX_PAGES = 80;
const SCOTUS_TEXT_MAX_CHARS = 1_000_000;
const SCOTUS_TEXT_MIN_CHARS = 800;

// Re-export the shared official-URL validator so existing crawler/probe imports
// keep working while the identity contract lives in one runtime-neutral module.
export { isOfficialScotusPdfUrl };

export async function extractOfficialScotusPdf(bytes: Uint8Array, docket: string): Promise<{ text: string; pageCount: number }> {
  if (bytes.byteLength < 100 || bytes.byteLength > SCOTUS_PDF_MAX_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("scotus.invalid_pdf_bytes");
  }
  const expected = normalizeDocket(docket);
  if (!expected) throw new Error("scotus.docket_unverified");
  // unpdf bundles PDF.js for Cloudflare Workers; this is not Node pdf-parse.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > SCOTUS_PDF_MAX_PAGES) {
      throw new Error("scotus.pdf_page_limit");
    }
    const { text: extracted } = await extractText(pdf, { mergePages: true });
    const text = String(extracted).replace(/\0/g, "").trim();
    if (text.length < SCOTUS_TEXT_MIN_CHARS || text.length > SCOTUS_TEXT_MAX_CHARS) throw new Error("scotus.pdf_text_insufficient");
    // A listing link alone is not a docket match. Verify the PDF text itself.
    // Application dockets include a letter and may omit the hyphen ("No. 26A388"),
    // while certiorari dockets are hyphenated ("No. 24-43"); both render with
    // optional spaces around the hyphen. The shared contract normalizes both.
    if (!scotusBodyDocketMatches(text, expected)) throw new Error("scotus.pdf_docket_mismatch");
    return { text, pageCount: pdf.numPages };
  } finally {
    const maybeDisposable = pdf as unknown as { destroy?: () => Promise<void> };
    await maybeDisposable.destroy?.();
  }
}
