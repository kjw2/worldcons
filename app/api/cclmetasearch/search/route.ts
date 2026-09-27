import { createCclMetasearchSearchHandler } from "@/lib/cclmetasearch/handler";
import { searchCclMetasearch } from "@/lib/cclmetasearch/search";
import type { CclMetasearchItem } from "@/lib/cclmetasearch/contract";
import { searchCclMetasearchViaRuntimeService } from "@/lib/cloudflare/services/search-service-binding";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const handler = createCclMetasearchSearchHandler({
  search: async (input) => {
    const bound = await searchCclMetasearchViaRuntimeService<CclMetasearchItem>(input);
    return bound ?? searchCclMetasearch(input);
  },
});

export const GET = handler;
