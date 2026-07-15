import { cclMetasearchNotFoundResponse } from "@/lib/cclmetasearch/handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return cclMetasearchNotFoundResponse();
}
