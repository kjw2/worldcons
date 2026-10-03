export const BVERFG_BASE_URL = "https://www.bundesverfassungsgericht.de";

function bverfgPrefixesForProcedure(procedure: string) {
  const normalized = procedure.toLowerCase();
  if (normalized === "bvr") return ["rk", "rs"];
  if (normalized === "bvq") return ["qk", "qs"];
  if (normalized === "bvc") return ["cs"];
  if (normalized === "bvl") return ["ls"];
  if (normalized === "bve") return ["es"];
  if (normalized === "bvf") return ["fs"];
  if (normalized === "bvb") return ["bs"];
  return [];
}

export function bverfgOfficialUrlCandidatesFromDocket(date: string, docket: string) {
  const dateMatch = date.match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);
  const docketMatch = docket.match(/^([12])\s+Bv([A-Za-z]+)\s+(\d+)\/(\d{2,4})/);
  if (!dateMatch || !docketMatch) return [];
  const [, day, month, year] = dateMatch;
  const [, senate, procedureSuffix, number, docketYear] = docketMatch;
  const procedure = `bv${procedureSuffix.toLowerCase()}`;
  const prefixes = bverfgPrefixesForProcedure(procedure);
  if (prefixes.length === 0) return [];
  const casePart = `${senate}${procedure}${number.padStart(4, "0")}${docketYear.length === 4 ? docketYear.slice(-2) : docketYear}`;
  return prefixes.map(
    (prefix) => `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/${year}/${month}/${prefix}${year}${month}${day}_${casePart}.html`,
  );
}

export function isBverfgOfficialDecisionUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.hostname !== "www.bundesverfassungsgericht.de" && parsed.hostname !== "www.bverfg.de") return false;
  return /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/[a-z]{2}\d{8}_[a-z0-9]+\.html$/i.test(parsed.pathname);
}
