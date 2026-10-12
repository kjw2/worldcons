import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync,writeFileSync,readdirSync,rmSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import { recordAutomaticApproval } from "@/lib/cloudflare/e2e/automatic-approval";
import { consumeSearchRepair } from "@/lib/cloudflare/e2e/search-repair-consumer";
import { verifySearchRepair } from "@/lib/cloudflare/e2e/search-verification";
import { sha256Canonical } from "@/lib/cloudflare/e2e/contracts";
import { SqliteD1,articleId,input } from "./helpers/e2e-core-fixture";
import { validSummary } from "./helpers/e2e-m4-summary";

const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("M4 real local workerd public Worker and separated D1 APIs verify actual content and atomic completion",async(t)=>{
  const root=path.resolve(import.meta.dirname,".."),parent=path.resolve(tmpdir());
  const dir=mkdtempSync(path.join(parent,"worldcons-m4-runtime-"));
  t.after(()=>{
    const target=path.resolve(dir);
    assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith("worldcons-m4-runtime-"));
    rmSync(target,{recursive:true,force:true});
  });
  const config=path.join(root,`.e2e-m4-runtime-${crypto.randomUUID()}.json`),output=path.join(dir,"bundle");
  t.after(()=>{assert.equal(path.dirname(config),root);rmSync(config,{force:true});});
  writeFileSync(config,JSON.stringify({name:"worldcons-m4-runtime-fixture",main:"./lib/cloudflare/services/worldcons-search-service.ts",
    compatibility_date:"2026-09-20",compatibility_flags:["nodejs_compat"],tsconfig:"./tsconfig.json"}));
  execFileSync(process.execPath,[path.join(root,"node_modules/wrangler/bin/wrangler.js"),"deploy","--dry-run","--config",config,"--outdir",output],
    {cwd:root,encoding:"utf8",timeout:60000,stdio:"pipe"});
  const script=path.join(output,readdirSync(output).find(name=>name.endsWith(".js"))!);
  const base="https://fixture.example/api";
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:readFileSync(script,"utf8"),compatibilityDate:"2026-09-20",
    compatibilityFlags:["nodejs_compat"],d1Databases:{WORLDCONS_CORE:"m4-local-core",WORLDCONS_SEARCH:"m4-local-search"},
    bindings:{ENVIRONMENT:"test",PUBLIC_BASE_URL:base},cf:false,unsafeRegisterWorker:false}));
  t.after(async()=>{await runtime.dispose();});
  const core:D1RuntimeDatabase=await runtime.getD1Database("WORLDCONS_CORE"),search:D1RuntimeDatabase=await runtime.getD1Database("WORLDCONS_SEARCH");
  const seed=new SqliteD1(),searchSeed=new SqliteD1("search");t.after(()=>{seed.close();searchSeed.close();});
  const url="https://www.conseil-constitutionnel.fr/decision/2026/2026912QPC.htm",title="Décision n° 2026-912 QPC";
  seed.db.prepare("UPDATE articles SET original_url=?,canonical_url=?,original_title=?,korean_title=?,cleaned_text=?,summary_json=?").run(
    url,url,title,validSummary.koreanTitle,"official constitutional decision text ".repeat(100),JSON.stringify(validSummary));
  for (const [db,source] of [[core,seed],[search,searchSeed]] as const) {
    for (const row of source.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) {
      if (!String(row.name).startsWith("search_fts_")) await db.prepare(String(row.sql)).all();
    }
  }
  const article=seed.rows("articles")[0],columns=Object.keys(article);
  await core.prepare(`INSERT INTO articles (${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`).bind(...Object.values(article)).all();
  const approval=await recordAutomaticApproval(core,{articleId,sourceKey:String(article.source_key),candidateId:"native:workerd-m4",
    pipelineRunId:"ingest-stage:workerd-m4",candidateUrl:url,canonicalUrl:url,candidateTitle:title,
    cleanedSourceText:String(article.cleaned_text),sourceArtifactRef:"stages/ingest-crawl/workerd-m4.json",
    sourceArtifactHash:await sha256Canonical({fixture:"workerd-m4"}),now:new Date().toISOString()});
  const result=await transitionArticlePublicationInD1(core,input(seed,"workerd-m4",{e2eApproval:approval}));assert.ok(result.ok,JSON.stringify(result));
  const message={schemaVersion:1,type:"e2e-search-repair",outboxId:result.data.generation!.searchRepairOutboxId};
  assert.equal((await consumeSearchRepair(core,search,message)).status,"awaiting_verification");
  let now=new Date().toISOString();
  const options={apiBaseUrl:base,deploymentRef:"fixture:actual-local-workerd",clock:()=>now,
    fetch:((url,init)=>runtime.dispatchFetch(String(url),init)) as typeof fetch};
  // Actual Search corruption must fail even with a genuine HTTP handler and unchanged checksums.
  const originalFts=(await search.prepare("SELECT title FROM search_fts").all()).results![0];
  await search.prepare("UPDATE search_fts SET title='corrupt'").all();
  const failed=await verifySearchRepair(core,search,message,options);assert.equal(failed.status,"retry");
  assert.equal((await core.prepare("SELECT COUNT(*) AS count FROM e2e_verification_evidence_v1").all()).results![0].count,0);
  await search.prepare("UPDATE search_fts SET title=?").bind(originalFts.title).all();
  now=new Date(Date.parse(now)+61_000).toISOString();
  const verified=await verifySearchRepair(core,search,message,options);assert.equal(verified.status,"completed_verified",JSON.stringify(verified));
  assert.equal((await core.prepare("SELECT state FROM e2e_generation_progress_v1").all()).results![0].state,"completed_verified");
  const evidence=(await core.prepare("SELECT evidence_document FROM e2e_verification_evidence_v1").all()).results![0];
  const verificationDocument=JSON.parse(String(evidence.evidence_document));
  assert.deepEqual(verificationDocument.probes.map((p:{status:number})=>p.status),[200,200]);
  assert.equal(verificationDocument.observed.documentCount,1);assert.equal(verificationDocument.observed.ftsCount,1);
  assert.equal(verificationDocument.expected.documentFingerprint,verificationDocument.observed.documentFingerprint);
  console.log(JSON.stringify({event:"m4_local_runtime_evidence",scope:"synthetic_local_workerd",verificationDocument}));
  assert.equal((await core.prepare("SELECT COUNT(*) AS count FROM e2e_commit_guards_v1").all()).results![0].count,0);
  assert.equal((await verifySearchRepair(core,search,message,options)).status,"already_verified");
});

test("M5 verifier probe runs inside workerd, uses supported manual redirects and rejects redirects before reading a body",async t=>{
 const root=path.resolve(import.meta.dirname,".."),parent=path.resolve(tmpdir()),dir=mkdtempSync(path.join(parent,"worldcons-probe-runtime-"));
 const wrapper=path.join(root,'.e2e-probe-runtime-'+crypto.randomUUID()+'.ts'),config=wrapper+'.json',output=path.join(dir,'bundle');
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert.ok(path.basename(dir).startsWith('worldcons-probe-runtime-'));rmSync(dir,{recursive:true,force:true});for(const file of [wrapper,config]){assert.equal(path.dirname(file),root);rmSync(file,{force:true});}});
 writeFileSync(wrapper,`import {probeVerificationApi} from './lib/cloudflare/e2e/search-verification';export default {async fetch(request,env){try{const url='https://fixture.example'+new URL(request.url).pathname;const result=await probeVerificationApi(url,{apiBaseUrl:'https://fixture.example/api',deploymentRef:'fixture:worker-probe',fetch:(url,init)=>env.PUBLIC.fetch(url,init)},()=>new Date().toISOString());return Response.json(result);}catch(error){return Response.json({error:error.message},{status:502});}}}`);
 writeFileSync(config,JSON.stringify({name:'worldcons-probe-runtime',main:wrapper,compatibility_date:'2026-09-20',compatibility_flags:['nodejs_compat'],tsconfig:path.join(root,'tsconfig.json')}));
 execFileSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',config,'--outdir',output],{cwd:root,encoding:'utf8',timeout:60000,stdio:'pipe'});
 const script=readFileSync(path.join(output,readdirSync(output).find(x=>x.endsWith('.js'))!),'utf8');
 const runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'verifier',modules:true,script,compatibilityDate:'2026-09-20',compatibilityFlags:['nodejs_compat'],serviceBindings:{PUBLIC:'public'}},{name:'public',modules:true,script:`export default {fetch(request){return new URL(request.url).pathname==='/redirect'?new Response(null,{status:302,headers:{location:'https://unexpected.example/'}}):Response.json({items:[]});}}`,compatibilityDate:'2026-09-20'}],cf:false,unsafeRegisterWorker:false}));t.after(async()=>runtime.dispose());
 const ok=await runtime.dispatchFetch('https://fixture.example/api');assert.equal(ok.status,200);assert.equal((await ok.json()).status,200);
 const redirect=await runtime.dispatchFetch('https://fixture.example/redirect');assert.equal(redirect.status,502);assert.equal((await redirect.json()).error,'e2e.api_redirect_rejected');
});
