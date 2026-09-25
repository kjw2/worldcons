import { compareRankedIds, type RankedIdParityOptions, type RankedIdParityReport } from "@/lib/cloudflare/search-fts";
import type { RankedSearchPagePayload } from "./types";

/**
 * Evidence-only parity helper: compares an expected ordered id list against the
 * ids carried by a ranked page payload. This is diagnostic only and defines no
 * GO/NO-GO threshold; `search_m7` stays blocked regardless of the output.
 */
export function compareRankedPageIds(
  expected: readonly string[],
  page: RankedSearchPagePayload,
  options: RankedIdParityOptions = {},
): RankedIdParityReport {
  return compareRankedIds(
    expected,
    page.entries.map((entry) => entry.id),
    options,
  );
}
