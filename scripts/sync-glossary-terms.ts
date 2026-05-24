import "dotenv/config";
import { getSupabaseAdmin } from "@/lib/db/client";
import { glossaryTermsSeed } from "@/lib/glossary/terms";

async function main() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new Error("Supabase 환경변수가 없어 glossary_terms 동기화를 실행할 수 없습니다.");
  }

  const rows = glossaryTermsSeed.map((term) => ({
    slug: term.slug,
    term: term.term,
    korean_term: term.koreanTerm,
    definition: term.definition,
    jurisdiction: term.jurisdiction,
    related_tags: term.relatedTags,
  }));

  const { error } = await supabase.from("glossary_terms").upsert(rows, { onConflict: "slug" });
  if (error) throw new Error(error.message);

  console.log(JSON.stringify({ synced: rows.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
