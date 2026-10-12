/** Read-only Production corpus audit. A passing corpus audit does not close P0. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {SOURCE_SQL,readTagsForArticleIds,buildSearchProjectionInputFromEligibleRows} from "../lib/cloudflare/search-projection/d1-sync";
import {buildSearchProjection} from "../lib/cloudflare/search-projection/build";
import {projectionFingerprints} from "../lib/cloudflare/e2e/search-generation-guard";
import {sha256Canonical} from "../lib/cloudflare/e2e/contracts";
import type {D1RuntimeDatabase} from "../lib/cloudflare/d1/runtime-binding";

const run=promisify(execFile);
type Row=Record<string,unknown>;
function parseResponse(stdout:string):Array<{success:boolean;results:Row[]}> {
  for(const match of stdout.matchAll(/^[\[{]/gm)) {
    try {const value=JSON.parse(stdout.slice(match.index));
      if(Array.isArray(value)&&value.every(x=>x.success===true&&Array.isArray(x.results)))return value;
    } catch { /* Wrangler may prepend non-JSON status text. */ }
  }
  throw Error("e2e.audit_invalid_d1_response");
}
function database(name:string):D1RuntimeDatabase {
  return {prepare(sql:string) {let values:unknown[]=[];return {
    bind(...params:unknown[]) {values=params;return this;},
    async all<T>() {
      if(!/^SELECT\s/i.test(sql.trim()))throw Error("e2e.audit_read_only");
      let index=0;
      const query=sql.replace(/\?/g,()=>{const value=values[index++];
        return value==null?"NULL":typeof value==="number"&&Number.isFinite(value)?String(value):"'"+String(value).replaceAll("'","''")+"'";});
      if(index!==values.length)throw Error("e2e.audit_parameter_mismatch");
      const {stdout}=await run(process.execPath,["node_modules/wrangler/bin/wrangler.js","d1","execute",name,
        "--remote","--json","--config","workers/async-pipeline/wrangler.jsonc","--command",query],
        {encoding:"utf8",timeout:45000,maxBuffer:32*1024*1024});
      return {success:true,results:parseResponse(stdout).flatMap(x=>x.results) as T[]};
    },
  };}};
}
const core=database("worldcons_core"),search=database("worldcons_search");
const rows=async(db:D1RuntimeDatabase,sql:string,...values:unknown[])=>
  (await db.prepare(sql).bind(...values).all<Row>()).results!;
async function boundary() {
  // Content is immutable in P3. Include the mutable eligibility and tag inputs.
  const queries=[
    "SELECT * FROM article_publications_p3 ORDER BY article_id",
    "SELECT * FROM legacy_version_freshness_classifications_v4 ORDER BY version_id",
    "SELECT * FROM case_catalog_publications_v1 ORDER BY article_id",
    "SELECT id,review_state FROM articles ORDER BY id",
    "SELECT * FROM article_tags ORDER BY article_id,tag_id",
    "SELECT * FROM tags ORDER BY id",
  ];
  const state=await Promise.all(queries.map(sql=>rows(core,sql)));
  return sha256Canonical(state);
}
async function main() {
  const startedAt=new Date().toISOString(),before=await boundary();
  const expectedIds:string[]=[],mismatches:Row[]=[],fingerprints:Row[]=[];
  let after="",pages=0;
  for(;;) {
    const page=await rows(core,`${SOURCE_SQL.replace(/ORDER BY p\.article_id\s*$/u,"")}\nAND p.article_id>? ORDER BY p.article_id LIMIT 50`,after);
    if(!page.length)break;
    const ids=page.map(row=>String(row.article_id)),placeholders=ids.map(()=>"?").join(",");
    const [tags,docs,fts]=await Promise.all([
      readTagsForArticleIds(core,ids),
      rows(search,`SELECT * FROM search_documents WHERE article_id IN (${placeholders})`,...ids),
      rows(search,`SELECT * FROM search_fts WHERE article_id IN (${placeholders})`,...ids),
    ]);
    const desired=buildSearchProjection(buildSearchProjectionInputFromEligibleRows(page as never,tags));
    for(const document of desired.documents) {
      const id=document.article_id,expectedFts=desired.ftsDocuments.find(x=>x.article_id===id)!;
      expectedIds.push(id);
      const documents=docs.filter(x=>x.article_id===id),ftsRows=fts.filter(x=>x.article_id===id);
      const expected=await projectionFingerprints(document,expectedFts);
      const actual=await projectionFingerprints(documents.length===1?documents[0] as never:null,ftsRows.length===1?ftsRows[0] as never:null);
      const exact=documents.length===1&&ftsRows.length===1&&expected.documentFingerprint===actual.documentFingerprint&&expected.ftsFingerprint===actual.ftsFingerprint;
      fingerprints.push({articleId:id,expected,actual,exact});
      if(!exact)mismatches.push({articleId:id,documentCount:documents.length,ftsCount:ftsRows.length,expected,actual});
    }
    after=ids.at(-1)!;pages++;
    console.log(JSON.stringify({event:"corpus_audit_page",pages,eligible:expectedIds.length,mismatches:mismatches.length}));
  }
  const [documentIds,ftsIds,generations,progress,outbox,verificationJobs,referenceErrors,drift,ingestJobs,afterBoundary]=await Promise.all([
    rows(search,"SELECT article_id,COUNT(*) AS count FROM search_documents GROUP BY article_id ORDER BY article_id"),
    rows(search,"SELECT article_id,COUNT(*) AS count FROM search_fts GROUP BY article_id ORDER BY article_id"),
    rows(core,"SELECT source_key,COUNT(*) AS count FROM e2e_generations_v1 GROUP BY source_key ORDER BY source_key"),
    rows(core,"SELECT state,COUNT(*) AS count FROM e2e_generation_progress_v1 GROUP BY state ORDER BY state"),
    rows(core,"SELECT status,COUNT(*) AS count,MIN(created_at) AS oldest_created_at FROM e2e_search_repair_outbox_v1 GROUP BY status ORDER BY status"),
    rows(core,"SELECT status,COUNT(*) AS count FROM e2e_verification_jobs_v1 GROUP BY status ORDER BY status"),
    rows(core,"SELECT p.article_id,p.version_id FROM article_publications_p3 p LEFT JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id WHERE v.id IS NULL ORDER BY p.article_id"),
    rows(core,"SELECT a.id AS article_id,a.source_key,a.original_title,a.review_state,a.lifecycle_review_state,p.version_id,p.revision AS publication_revision,CASE WHEN a.cleaned_text IS v.cleaned_text THEN 1 ELSE 0 END AS text_equal,CASE WHEN a.summary_json IS v.summary_json THEN 1 ELSE 0 END AS summary_equal,CASE WHEN a.korean_title IS v.korean_title THEN 1 ELSE 0 END AS title_equal FROM article_publications_p3 p JOIN articles a ON a.id=p.article_id JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id WHERE p.state='published' AND (a.cleaned_text IS NOT v.cleaned_text OR a.summary_json IS NOT v.summary_json OR a.korean_title IS NOT v.korean_title OR a.canonical_url IS NOT v.canonical_url) ORDER BY a.id"),
    rows(database("worldcons_ingest"),"SELECT source_key,stage,status,COUNT(*) AS count FROM ingest_stage_jobs GROUP BY source_key,stage,status ORDER BY source_key,stage,status"),
    boundary(),
  ]);
  const expectedSet=new Set(expectedIds);
  const missing=(found:Row[])=>expectedIds.filter(id=>!found.some(x=>x.article_id===id));
  const extra=(found:Row[])=>found.filter(x=>!expectedSet.has(String(x.article_id))).map(x=>x.article_id);
  const duplicates=(found:Row[])=>found.filter(x=>Number(x.count)!==1);
  const differences={missingDocuments:missing(documentIds),missingFts:missing(ftsIds),extraDocuments:extra(documentIds),extraFts:extra(ftsIds),duplicateDocuments:duplicates(documentIds),duplicateFts:duplicates(ftsIds),contentMismatches:mismatches};
  const verified=before===afterBoundary&&Object.values(differences).every(x=>x.length===0)&&referenceErrors.length===0;
  const report={schema:"worldcons.production-corpus-audit.v1",mode:"production_read_only",startedAt,finishedAt:new Date().toISOString(),
    coreBoundaryBefore:before,coreBoundaryAfter:afterBoundary,coreInputsStable:before===afterBoundary,pages,
    counts:{eligible:expectedIds.length,documents:documentIds.reduce((n,x)=>n+Number(x.count),0),fts:ftsIds.reduce((n,x)=>n+Number(x.count),0)},
    differences,referenceErrors,unreviewedCoreP3Drift:drift,generations,progress,outbox,verificationJobs,ingestJobs,fingerprints,
    corpusVerified:verified,p0Completed:false,
    limitations:["Point-in-time comparison across separate D1 databases; not a global atomic snapshot.",
      "No legal-meaning approval, Discovery coverage, all-writer certification, FR/ES new-case proof or 48-hour observation is inferred from this audit."]};
  const outputArg=process.argv.find(arg=>arg.startsWith("--output-dir="));
  const dir=resolve(outputArg?.slice("--output-dir=".length)??"artifacts/e2e-p0-release");await mkdir(dir,{recursive:true});
  await writeFile(resolve(dir,"corpus-audit.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({corpusVerified:verified,counts:report.counts,differences,driftCount:drift.length,generations,progress}));
  if(!verified)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.message:"e2e.audit_failed");process.exitCode=1;});
