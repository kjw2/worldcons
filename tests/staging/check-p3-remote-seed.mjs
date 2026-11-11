import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync(":memory:");
const folder=join(process.cwd(),"d1","worldcons_core");
const files=readdirSync(folder).filter(x=>/^\d+.*\.sql$/.test(x)).sort();
for(const file of files) db.exec(readFileSync(join(folder,file),"utf8"));
const sql="INSERT INTO articles(id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,discovered_at,fetched_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const now=new Date().toISOString();
const inputs=[
  ["g1", "e760950f-8a54-4d1f-b2ca-240b9219c1e1", "de-bverfg", "cleaned", "source_text_ready", "ready", "unreviewed", "clear", "pending"],
  ["g2", "e760950f-8a54-4d1f-b2ca-240b9219c1e2", "es-tribunal-constitucional", "cleaned", "source_text_ready", "ready", "unreviewed", "clear", "pending"],
  ["g3", "e760950f-8a54-4d1f-b2ca-240b9219c1e3", "fr-conseil-constitutionnel", "cleaned", "source_text_ready", "ready", "unreviewed", "clear", "pending"],
  ["g4", "e760950f-8a54-4d1f-b2ca-240b9219c1e4", "us-scotus", "metadata_only", "metadata_only", "not_ready", "needs_review", "active", "not_required"],
  ["g1-429", "e760950f-8a54-4d1f-b2ca-240b9219c1e5", "de-bverfg", "cleaned", "source_text_ready", "ready", "unreviewed", "clear", "pending"],
];
for(const [lane,id,source,status,collection,processing,review,attention,translation] of inputs) {
  const privateCase=lane==="g4";
  const meta=privateCase
    ? {collection:{publishable:false,sourceTextAvailable:true,sourceUrlVerified:true,strategy:"official-pdf"},review:{required:true}}
    : {collection:{publishable:true,sourceTextAvailable:true,sourceUrlVerified:true,strategy:"fetch"}};
  try {
    const url="https://example.test/case/"+lane;
    db.prepare(sql).run(
      id, source, "Germany", "Bundesverfassungsgericht", "opinion",
      url, url, "de", "Official title", "2026-10-15",
      now, now, status, "p3-"+lane, "Official document text. ".repeat(35), null,
      JSON.stringify(meta), now, now, collection, processing, review, attention, translation,
      privateCase ? "needs_triage" : null
    );
    console.log(JSON.stringify({lane,ok:true}));
  } catch(error) {
    console.log(JSON.stringify({lane,ok:false,error:String(error).slice(0,320)}));
    process.exitCode=1;
  }
}
db.close();
