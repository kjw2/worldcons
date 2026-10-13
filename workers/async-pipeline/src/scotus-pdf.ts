import { extractText, getDocumentProxy } from "unpdf";

/** Bounded PDF.js work for the M8 SCOTUS collector (not a publication gate). */
export const SCOTUS_PDF_MAX_BYTES = 8 * 1024 * 1024;
const SCOTUS_PDF_MAX_PAGES = 80;
const SCOTUS_TEXT_MAX_CHARS = 1_000_000;
const SCOTUS_TEXT_MIN_CHARS = 800;

export function isOfficialScotusPdfUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:"
      && !url.username && !url.password && !url.port
      && (url.hostname.toLowerCase() === "supremecourt.gov" || url.hostname.toLowerCase().endsWith(".supremecourt.gov"))
      && /^\/opinions\/\d{2}pdf\/[^/]+\.pdf$/i.test(url.pathname)
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeDocket(value: string): string | null {
  const canonical = value.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, "").toUpperCase();
  // Certiorari/appeal/original dockets use a hyphenated number (24-43).
  if (/^\d{1,3}-\d{1,6}$/.test(canonical)) return canonical;
  // In-chambers applications and comparable letter dockets omit the hyphen
  // (26A388, 25A1314); these are real official slip opinions during rollover.
  if (/^\d{1,3}[A-Z]\d{1,6}$/.test(canonical)) return canonical;
  return null;
}

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
    // optional spaces around the hyphen. Normalize the separator before comparing.
    const header = text.slice(0, 12_000).replace(/[\u2010-\u2015\u2212]/g, "-");
    const docketMatches = [...header.matchAll(/\bNos?\.\s*(\d{1,3})\s*-?\s*([A-Z]?\d{1,6})\b/gi)];
    if (!docketMatches.some((match) => `${match[1]}-${match[2]}`.replace(/-([A-Z])/, "$1").toUpperCase() === expected)) throw new Error("scotus.pdf_docket_mismatch");
    return { text, pageCount: pdf.numPages };
  } finally {
    const maybeDisposable = pdf as unknown as { destroy?: () => Promise<void> };
    await maybeDisposable.destroy?.();
  }
}
