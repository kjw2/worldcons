const FRANCE_SOURCE_KEY = "fr-conseil-constitutionnel";
const DILA_STOCK_PREFIX = "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/";
const OPEN_LICENCE_URL = "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0";

export type PublicSourceAttribution = {
  provider: "DILA";
  providerLabel: string;
  datasetLabel: string;
  authorityLabel: string;
  dilaId: string;
  ecli: string | null;
  decisionNumber: string;
  stockFilename: string;
  stockUrl: string;
  stockTimestamp: string;
  stockLastModified: string | null;
  stockSha256: string;
  licenseId: "licence-ouverte-2.0";
  licenseLabel: string;
  licenseUrl: typeof OPEN_LICENCE_URL;
  notice: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown) {
  return value === null ? null : string(value);
}

function sourceInventory(metadata: Record<string, unknown> | null | undefined) {
  const direct = record(metadata?.sourceInventory);
  if (direct) return direct;
  return record(record(metadata?.case)?.sourceInventory);
}

function exactPublicUrl(value: string, expected: string) {
  try {
    const url = new URL(value);
    return url.toString() === expected
      && url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function publicSourceAttribution(
  sourceKey: string,
  sourceMetadata: Record<string, unknown> | null | undefined,
): PublicSourceAttribution | null {
  if (sourceKey !== FRANCE_SOURCE_KEY) return null;

  const inventory = sourceInventory(sourceMetadata);
  const dila = record(inventory?.dila);
  const stock = record(inventory?.stock);
  const license = record(inventory?.license);
  if (!inventory || !dila || !stock || !license) return null;

  const dilaId = string(dila.id);
  const ecli = nullableString(dila.ecli);
  const decisionNumber = string(dila.decisionNumber);
  const stockFilename = string(stock.filename);
  const stockUrl = string(stock.url);
  const stockTimestamp = string(stock.extractedAt);
  const stockLastModified = nullableString(stock.lastModified);
  const stockSha256 = string(stock.sha256);
  const licenseId = string(license.id);
  const licenseUrl = string(license.url);
  const attribution = string(license.attribution);
  const contentLength = stock.contentLength;

  if (
    !dilaId?.match(/^CONSTEXT\d{12}$/u)
    || (ecli !== null && !ecli.match(/^ECLI:FR:CC:/u))
    || !decisionNumber
    || !stockFilename?.match(/^Freemium_constit_global_\d{8}-\d{6}[.]tar[.]gz$/u)
    || !stockUrl
    || !exactPublicUrl(stockUrl, `${DILA_STOCK_PREFIX}${stockFilename}`)
    || !stockTimestamp?.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]000Z$/u)
    || !Number.isInteger(contentLength)
    || Number(contentLength) < 1
    || Number(contentLength) > 33_554_432
    || !stockSha256?.match(/^[0-9a-f]{64}$/u)
    || licenseId !== "licence-ouverte-2.0"
    || licenseUrl !== OPEN_LICENCE_URL
    || !exactPublicUrl(licenseUrl, OPEN_LICENCE_URL)
    || attribution !== "DILA"
  ) return null;

  return {
    provider: "DILA",
    providerLabel: "프랑스 법률·행정정보국(DILA)",
    datasetLabel: "DILA CONSTIT 헌법재판 결정 공개데이터",
    authorityLabel: "프랑스 헌법위원회(Conseil constitutionnel)",
    dilaId,
    ecli,
    decisionNumber,
    stockFilename,
    stockUrl,
    stockTimestamp,
    stockLastModified,
    stockSha256,
    licenseId,
    licenseLabel: "공공데이터 개방 라이선스 2.0 (Licence Ouverte 2.0)",
    licenseUrl: OPEN_LICENCE_URL,
    notice: "이 출처 정보와 공식 원문은 AI 생성물이 아닙니다. 한국어 요약이 표시되는 경우에만 AI가 만든 참고자료입니다. 이 데이터의 재이용은 DILA 또는 프랑스 헌법위원회의 보증을 의미하지 않습니다.",
  };
}
