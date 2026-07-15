import { handleCclMetasearchSearch } from "@/lib/cclmetasearch/handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = handleCclMetasearchSearch;
