import assert from "node:assert/strict";
import test from "node:test";
import { recordAutomaticApproval, AutomaticApprovalBlocked } from "@/lib/cloudflare/e2e/automatic-approval";
import { sha256Canonical } from "@/lib/cloudflare/e2e/contracts";
import { verifySearchRepair } from "@/lib/cloudflare/e2e/search-verification";
import { consumeSearchRepair } from "@/lib/cloudflare/e2e/search-repair-consumer";
import { handleWorldconsSearchRequest } from "@/lib/integrations/cclrag2/provider-handler";
import { SqliteD1,articleId,publish } from "./helpers/e2e-core-fixture";

import { validSummary } from "./helpers/e2e-m4-summary";
import { consumeE2ESearchRepairBatch } from "../workers/async-pipeline/src/e2e-search-repair-queue";
import { publishStagedApproved } from "../workers/async-pipeline/src/staged-e2e";
async function fixture(t:test.TestContext,source="fr-conseil-constitutionnel") {
  const core=new SqliteD1(),search=new SqliteD1("search");t.after(()=>{core.close();search.close();});
  const url=source.startsWith("fr")?"https://www.conseil-constitutionnel.fr/decision/2026/2026912QPC.htm"
    :"https://hj.tribunalconstitucional.es/es/Resolucion/Show/fixture";
  const title=source.startsWith("fr")?"Décision n° 2026-912 QPC":"Sentencia 99/2026";
  const caseNumber=source.startsWith("fr")?"2026-912 QPC":"99/2026";
  core.db.prepare(`UPDATE articles SET source_key=?,original_title=?,canonical_url=?,original_url=?,cleaned_text=?,summary_json=?,korean_title=?,source_metadata=?`).run(
    source,title,url,url,"official constitutional decision text ".repeat(100),JSON.stringify(validSummary),validSummary.koreanTitle,
    JSON.stringify({caseNumber,collection:{strategy:"fetch",publishable:true,sourceTextAvailable:true,sourceUrlVerified:true,robotsDisallowed:false}}));
  const approval=await recordAutomaticApproval(core,{articleId,sourceKey:source,candidateId:"native:fixture",pipelineRunId:"ingest-stage:fixture",
    sourceArtifactRef:`stages/ingest-crawl/${source}/fixture.json`,sourceArtifactHash:await sha256Canonical({source}),
    cleanedSourceText:String(core.rows("articles")[0].cleaned_text),candidateUrl:url,canonicalUrl:url,candidateTitle:title,now:new Date().toISOString()});
  const first=await publish(core,"m4-first",{e2eApproval:approval});
  const message={schemaVersion:1,type:"e2e-search-repair",outboxId:first.generation!.searchRepairOutboxId};
  assert.equal((await consumeSearchRepair(core,search,message)).status,"awaiting_verification");
  let now=new Date().toISOString();
  const apiBaseUrl="https://fixture.example/api";
  const publicFetch:typeof fetch=async(input)=>handleWorldconsSearchRequest(new Request(String(input)),{
    ENVIRONMENT:"test",PUBLIC_BASE_URL:apiBaseUrl},{coreBinding:core,searchBinding:search});
  const options={apiBaseUrl,fetch:publicFetch,clock:()=>now,deploymentRef:"fixture:local-public-provider"};
  const advance=(seconds=61)=>{now=new Date(Date.parse(now)+seconds*1000).toISOString();};
  const verify=()=>verifySearchRepair(core,search,message,options);
  return {core,search,approval,first,message,options,publicFetch,advance,verify};
}

test("M4 exact Core/P3/Search/FTS and actual public provider verify one generation; duplicate is immutable",async(t)=>{
  const f=await fixture(t);const result=await f.verify();assert.equal(result.status,"completed_verified",JSON.stringify(result));
  const progress=f.core.rows("e2e_generation_progress_v1")[0],evidence=f.core.rows("e2e_verification_evidence_v1")[0];
  assert.equal(progress.state,"completed_verified");assert.ok(progress.verified_at);assert.equal(evidence.result,"completed_verified");
  const document=JSON.parse(String(evidence.evidence_document));assert.equal(document.generationId,f.first.generation!.generationId);
  assert.deepEqual(document.probes.map((p:{status:number})=>p.status),[200,200]);
  assert.equal(document.scope,"single_article");assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
  assert.equal((await f.verify()).status,"already_verified");assert.equal(f.core.rows("e2e_verification_evidence_v1").length,1);
});

test("M4 altered document with unchanged checksum, FTS corruption, duplicate FTS and missing FTS never complete",async(t)=>{
  for (const mutation of ["UPDATE search_documents SET display_title='corrupt'","UPDATE search_fts SET title='corrupt'",
    "INSERT INTO search_fts SELECT * FROM search_fts","DELETE FROM search_fts"]) {
    const f=await fixture(t);
    // Simulates out-of-contract corruption rather than a legitimate guarded writer.
    if (mutation.includes("search_documents")) f.search.db.prepare("INSERT INTO e2e_search_write_authorizations_v1 VALUES (?,?)").run(articleId,"fixture-corruption");
    f.search.db.exec(mutation);f.search.db.exec("DELETE FROM e2e_search_write_authorizations_v1");
    const r=await f.verify();assert.equal(r.status,"retry");assert.equal("errorCode" in r?r.errorCode:null,"e2e.search_content_mismatch");
    assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"search_pending");
    assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
  }
});

test("M4 200/wrong article, title, URL or case number and API outage do not count as completion",async(t)=>{
  for (const field of ["id","title","caseNumber","originalUrl","canonicalUrl","detailApiUrl","unavailable"]) {
    const f=await fixture(t);f.options.fetch=async(input)=>{
      if (field==="unavailable") return Response.json({error:"unavailable"},{status:503});
      const response=await f.publicFetch(input),body=await response.json();
      if (String(input).includes("/search?")) body.items[0][field]="wrong";
      else body[field]="wrong";
      return Response.json(body);
    };
    assert.equal((await f.verify()).status,"retry");assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
    assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
    f.options.fetch=f.publicFetch;f.advance();assert.equal((await f.verify()).status,"completed_verified");
  }
});

test("M4 a B revision during API checks cannot complete A; historical A evidence survives a later B",async(t)=>{
  const f=await fixture(t);let changed=false;f.options.fetch=async(input)=>{
    const response=await f.publicFetch(input);
    if (!changed) {changed=true;await publish(f.core,"m4-b",{captureLegacy:false,versionId:f.first.versionId,
      e2eApproval:{...f.approval,policyVersion:"fixture-next-policy"}});}
    return response;
  };
  assert.equal((await f.verify()).status,"retry");assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
  const stable=await fixture(t);assert.equal((await stable.verify()).status,"completed_verified");
  const evidence=stable.core.rows("e2e_verification_evidence_v1");
  await publish(stable.core,"m4-b-after-success",{captureLegacy:false,versionId:stable.first.versionId,e2eApproval:{...stable.approval,policyVersion:"fixture-next-policy"}});
  assert.deepEqual(stable.core.rows("e2e_verification_evidence_v1"),evidence);
});

test("M4 concurrent validators share a verification owner without changing Search fence",async(t)=>{
  const f=await fixture(t);const results=await Promise.all([f.verify(),f.verify()]);
  assert.equal(results.filter(r=>r.status==="completed_verified").length,1);
  assert.equal(f.core.rows("e2e_verification_jobs_v1")[0].attempt_count,1);
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].fencing_token,1);
});

test("M4 expired verifier and Core late batch failure cannot leave partial evidence/completion",async(t)=>{
  for (const expire of [true,false]) {
    const f=await fixture(t);
    if (expire) f.options.fetch=async(input)=>{const result=await f.publicFetch(input);f.advance(301);return result;};
    else f.core.failAtEnd=true;
    assert.equal((await f.verify()).status,"retry");assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
    assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].status,"pending");
    f.core.failAtEnd=false;f.options.fetch=f.publicFetch;f.advance(301);assert.equal((await f.verify()).status,"completed_verified");
  }
});

test("M4 withdrawal has its own removal result and is never counted as completed public publication",async(t)=>{
  const f=await fixture(t);await f.verify();const withdrawn=await publish(f.core,"m4-withdraw",{
    captureLegacy:false,versionId:f.first.versionId,targetState:"withdrawn",e2eApproval:f.approval});
  const message={...f.message,outboxId:withdrawn.generation!.searchRepairOutboxId};
  await consumeSearchRepair(f.core,f.search,message);
  const result=await verifySearchRepair(f.core,f.search,message,f.options);
  assert.equal(result.status,"withdrawal_verified",JSON.stringify(result));
  assert.deepEqual(f.core.rows("e2e_verification_evidence_v1").map(r=>r.result),["completed_verified","withdrawal_verified"]);
  assert.equal(f.core.rows("e2e_generation_progress_v1")[1].state,"blocked");
});

test("M4 missing approval proof stays fail-closed",async(t)=>{
  const f=await fixture(t);f.core.db.exec("DELETE FROM e2e_approval_evidence_v1");
  assert.equal((await f.verify()).status,"retry");assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
});

test("M4 Spanish official case passes the same approval and public verification contract",async(t)=>{
  const f=await fixture(t,"es-tribunal-constitucional");
  const result=await f.verify();assert.equal(result.status,"completed_verified",JSON.stringify(result));
  const proof=JSON.parse(String(f.core.rows("e2e_approval_evidence_v1")[0].evidence_document));
  assert.equal(proof.caseNumber,"99/2026");
});

test("M4 summary risks, private/review states, source mismatch and incomplete processing require review",async(t)=>{
  for (const mutation of ["risk","private","review","processing","body","host","invalid-summary"]) {
    const f=await fixture(t),article=f.core.rows("articles")[0];
    if (mutation==="risk") f.core.db.prepare("UPDATE articles SET summary_json=?").run(JSON.stringify({...validSummary,riskFlags:["translation_uncertain"]}));
    if (mutation==="invalid-summary") f.core.db.exec("UPDATE articles SET summary_json='{}'");
    if (mutation==="private") f.core.db.exec("UPDATE articles SET review_state='closed_private'");
    if (mutation==="review") f.core.db.exec("UPDATE articles SET lifecycle_review_state='needs_triage'");
    if (mutation==="processing") f.core.db.exec("UPDATE articles SET lifecycle_processing_state='ready'");
    await assert.rejects(()=>recordAutomaticApproval(f.core,{articleId,sourceKey:String(article.source_key),candidateId:"native:quality",
      pipelineRunId:"ingest-stage:quality",sourceArtifactRef:"stages/ingest-crawl/quality.json",sourceArtifactHash:"a".repeat(64),
      cleanedSourceText:mutation==="body"?"mismatched":String(article.cleaned_text),candidateTitle:String(article.original_title),
      candidateUrl:mutation==="host"?"https://unofficial.example/decision":String(article.canonical_url),canonicalUrl:String(article.canonical_url),
      now:new Date().toISOString()}),AutomaticApprovalBlocked);
    assert.equal(f.core.rows("e2e_approval_evidence_v1").length,1);
    assert.equal(f.core.rows("e2e_generations_v1").length,1);
  }
});

test("M4 verification budget stops redispatch atomically and never consumes additional Search attempts",async(t)=>{
  for (const failure of ["eight-failures","expired-final-lease","two-hours"]) {
    const f=await fixture(t);f.options.fetch=async()=>Response.json({error:"unavailable"},{status:503});
    assert.equal((await f.verify()).status,"retry");
    if (failure==="eight-failures") {
      for (let attempt=2;attempt<=8;attempt++) {f.advance(901);assert.equal((await f.verify()).status,attempt===8?"dead_letter":"retry");}
    } else if (failure==="expired-final-lease") {
      f.core.db.exec("UPDATE e2e_verification_jobs_v1 SET attempt_count=8,status='leased'");
      f.core.db.prepare("UPDATE e2e_verification_jobs_v1 SET lease_expires_at=?,next_attempt_at=?").run("2000-01-01T00:00:00Z","2000-01-01T00:00:00Z");
      assert.equal((await f.verify()).status,"dead_letter");
    } else {f.advance(7201);assert.equal((await f.verify()).status,"dead_letter");}
    assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].status,"dead_letter");
    assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
    assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"dead_letter");
    assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
    const count=f.core.rows("e2e_verification_jobs_v1")[0].attempt_count;
    assert.equal((await f.verify()).status,"dead_letter");assert.equal(f.core.rows("e2e_verification_jobs_v1")[0].attempt_count,count);
  }
});

test("M4 final Core CAS catches P3 content or proof mutations after the API probes",async(t)=>{
  for (const mutation of ["UPDATE article_content_versions_p3 SET cleaned_text='changed'",
    "UPDATE e2e_approval_evidence_v1 SET source_artifact_hash='changed'","UPDATE articles SET review_state='closed_private'"]) {
    const f=await fixture(t);let fired=false;
    f.core.beforeBatch=()=>{if (!fired) {fired=true;f.core.db.exec(mutation);}};
    assert.equal((await f.verify()).status,"retry");
    assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
    assert.notEqual(f.core.rows("e2e_generation_progress_v1")[0].state,"completed_verified");
  }
});

test("M4 same approval content with new processing time or publication retry reuses proof, P3 and generation",async(t)=>{
  const f=await fixture(t),article=f.core.rows("articles")[0];
  f.core.db.exec("UPDATE articles SET fetched_at='2026-10-11T01:00:00Z',summarized_at='2026-10-11T02:00:00Z'");
  const context=await recordAutomaticApproval(f.core,{articleId,sourceKey:String(article.source_key),candidateId:"native:repeat",
    pipelineRunId:"ingest-stage:repeat",sourceArtifactRef:"stages/ingest-crawl/repeat.json",sourceArtifactHash:"b".repeat(64),
    cleanedSourceText:String(article.cleaned_text),candidateTitle:String(article.original_title),candidateUrl:String(article.canonical_url),
    canonicalUrl:String(article.canonical_url),now:new Date().toISOString()});
  assert.deepEqual(context,f.approval);
  await publishStagedApproved(f.core,articleId,context);await publishStagedApproved(f.core,articleId,context);
  assert.equal(f.core.rows("article_content_versions_p3").length,1);assert.equal(f.core.rows("e2e_generations_v1").length,1);
  assert.equal(f.core.rows("e2e_approval_evidence_v1").length,1);assert.equal(f.core.rows("e2e_search_apply_receipts_v1").length,1);
});

test("M4 actual Queue wrapper retries API failure, then records completion and acknowledges duplicates",async(t)=>{
  const f=await fixture(t),oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
  const env={WORLDCONS_CORE:f.core,WORLDCONS_SEARCH:f.search,WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED:"true",
    WORLDCONS_E2E_VERIFIER_ENABLED:"true",WORLDCONS_E2E_VERIFIER_API_BASE_URL:f.options.apiBaseUrl,
    WORLDCONS_E2E_DEPLOYMENT_REF:"fixture:queue"};
  let acks=0,retries=0;const messages=[{body:f.message,ack:()=>{acks++;},retry:()=>{retries++;}}];
  f.core.db.exec("UPDATE e2e_search_repair_outbox_v1 SET next_attempt_at='2000-01-01T00:00:00Z'");
  globalThis.fetch=async()=>Response.json({error:"unavailable"},{status:503});
  await consumeE2ESearchRepairBatch(messages,env);assert.equal(acks,0);assert.equal(retries,1);
  assert.equal(f.core.rows("e2e_verification_evidence_v1").length,0);
  f.core.db.exec("UPDATE e2e_verification_jobs_v1 SET next_attempt_at='2000-01-01T00:00:00Z'");
  globalThis.fetch=f.publicFetch;
  await consumeE2ESearchRepairBatch(messages,env);assert.equal(acks,1);
  await consumeE2ESearchRepairBatch(messages,env);assert.equal(acks,2);
  assert.equal(f.core.rows("e2e_verification_evidence_v1").length,1);
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
});

test("M4 historical completed evidence cannot authorize a now-blocked same generation",async(t)=>{
  const f=await fixture(t);assert.equal((await f.verify()).status,"completed_verified");
  const history=f.core.rows("e2e_verification_evidence_v1");
  f.core.db.exec("UPDATE articles SET review_state='closed_private'");
  assert.equal((await f.verify()).status,"blocked");assert.deepEqual(f.core.rows("e2e_verification_evidence_v1"),history);
});
