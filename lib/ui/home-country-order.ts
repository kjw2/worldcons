export const HOME_COUNTRY_ORDER = ["Germany", "United States", "France", "Spain"] as const;

const HOME_COUNTRY_RANK = new Map<string, number>(
  HOME_COUNTRY_ORDER.map((jurisdiction, index) => [jurisdiction, index]),
);

export function compareHomeCountries(left: string, right: string) {
  const leftRank = HOME_COUNTRY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = HOME_COUNTRY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;

  return leftRank - rightRank || left.localeCompare(right, "en");
}
