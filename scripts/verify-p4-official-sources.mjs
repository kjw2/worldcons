import { createHash } from "node:crypto";

/**
 * Read-only official-source identity/holding smoke test for P4.
 *
 * Run manually with: node scripts/verify-p4-official-sources.mjs
 * Uses HTTP GET only; it does not read or write production D1/R2/Workers.
 * Its PASS is NOT a Korean legal-accuracy or publication signoff.
 */
const sources = [
  {
    id: "de-bverfg",
    // Official short-link resolves to the canonical decision page. The old
    // query-string variant intermittently timed out from the test machine.
    url: "https://www.bverfg.de/e/rk20261015_2bvr173526",
    contentType: "text/html",
    required: [
      /2\s+BvR\s+1735\/26/i,
      /Die Abschiebung der Beschwerdeführerin wird/i,
      /längstens für die Dauer von sechs Monaten/i,
      /§\s*32 Abs\.\s*1/i,
    ],
  },
  {
    id: "es-tribunal-constitucional",
    url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32133",
    contentType: "text/html",
    required: [
      /AUTO\s+48\/2026/i,
      /art\.\s*219\.1\s*e\)\s*LOPJ\s*\[\s*sic\b/i,
      /No admitir a trámite la recusación/i,
      /José María Macías Castaño/i,
    ],
  },
  {
    id: "fr-conseil-constitutionnel",
    url: "https://www.conseil-constitutionnel.fr/decision/2026/20261230_1231QPC.htm",
    contentType: "text/html",
    required: [
      /2026-1230\/1231\s*QPC/i,
      /date de la publication de la présente décision/i,
      /toutes les affaires non jugées définitivement/i,
      /la seconde phrase du deuxième alinéa du paragraphe I de l'article 13/i,
    ],
  },
  {
    id: "us-scotus",
    url: "https://www.supremecourt.gov/opinions/26pdf/26a560_onkq.pdf",
    contentType: "application/pdf",
    expectedBytes: 64875,
    expectedSha256: "c8dcdbba8c419cded45bd9e042b8b53ab8c7b3002a3345633700994c10e7327b",
  },
];

function readableText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&shy;/gi, "")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ");
}

let failures = 0;
for (const source of sources) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(source.url, {
      headers: { "User-Agent": "WorldCons-P4-Official-Source-Check/1.0" },
      signal: controller.signal,
    });
    const mime = response.headers.get("content-type") ?? "";
    if (!response.ok || !mime.includes(source.contentType)) {
      throw new Error("http_or_content_type_mismatch");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if ("expectedSha256" in source) {
      const digest = createHash("sha256").update(body).digest("hex");
      if (body.length !== source.expectedBytes || digest !== source.expectedSha256
        || body.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("official_pdf_hash_or_format_mismatch");
      }
    } else {
      const plain = readableText(body.toString("utf8"));
      if (!source.required.every(pattern => pattern.test(plain))) {
        throw new Error("official_holding_or_identity_anchor_missing");
      }
    }
    console.log(JSON.stringify({ source: source.id, http: response.status,
      bytes: body.length, identityAndHoldingAnchorsPass: true,
      legalAccuracyVerified: false, productionMutations: 0 }));
  } catch (error) {
    failures++;
    const transportFailure=error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
      || error?.name === "AbortError" || error?.name === "TimeoutError";
    console.log(JSON.stringify({source: source.id,
      errorCode: transportFailure ? "official_source_network_timeout"
        : error?.message === "official_holding_or_identity_anchor_missing"
        ? error.message
        : error?.message === "official_pdf_hash_or_format_mismatch"
          ? error.message : "source_unreachable_or_changed",
      identityAndHoldingAnchorsPass: false }));
  } finally {
    clearTimeout(timeout);
  }
}

console.log(JSON.stringify({sourcesChecked:sources.length,failed:failures,
  legalAccuracyVerified:false,productionMutations:0}));
if(failures>0)process.exitCode=1;
