import { createCclMetasearchSearchHandler } from "@/lib/cclmetasearch/handler";
import { searchCclMetasearchWithEnv } from "@/lib/cclmetasearch/search";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const handler = createCclMetasearchSearchHandler({
  search: async (input) => {
    const coreBinding = getRuntimeD1Binding("worldcons_core");
    const searchBinding = getRuntimeD1Binding("worldcons_search");
    if (coreBinding && searchBinding) {
      return searchCclMetasearchWithEnv(input, {
        PUBLIC_SITE_BASE_URL: "https://worldcons.soltera.dev",
        CORE_BINDING: coreBinding,
        SEARCH_BINDING: searchBinding,
      });
    }
    throw new Error("WorldCons D1 search bindings are unavailable.");
  },
});

export const GET = handler;
