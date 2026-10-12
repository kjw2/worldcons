/** Authorized rollout rescan of the real official FR/ES windows; no synthetic cases or human approval. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {D1RuntimeDatabase} from '../../lib/cloudflare/d1/runtime-binding';
import {enqueueIngestStageDiscovery,type IngestStageRawBucket} from '../../workers/async-pipeline/src/ingest-stage-handlers';
const run=promisify(execFile),dir='artifacts/e2e-p0-m5-20261012';
function parse(stdout:string){for(const m of stdout.matchAll(/^[\[{]/gm)){try{const value=JSON.parse(stdout.slice(m.index));if(Array.isArray(value))return value;}catch{}}throw Error('seed.invalid_response');}
const ingest:D1RuntimeDatabase={prepare(sql:string){let params:unknown[]=[];const execute=async()=>{
  let index=0;const command=sql.replace(/\?/g,()=>{const v=params[index++];return v==null?'NULL':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";});
  if(index!==params.length)throw Error('seed.parameter_mismatch');
  const r=await run(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','worldcons_ingest','--remote','--json','--config','workers/async-pipeline/wrangler.jsonc','--command',command],{encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
  const value=parse(r.stdout)[0];if(value.success!==true)throw Error('seed.d1_failed');return value;
};return {bind(...values:unknown[]){params=values;return this;},all:execute,run:execute};}};
const bucket:IngestStageRawBucket={async get(){throw Error('seed.bucket_read_not_needed');},async put(key,bytes){
  const file=dir+'/seed-request-'+createHash('sha256').update(key).digest('hex')+'.json';await writeFile(file,bytes);
  await run(process.execPath,['node_modules/wrangler/bin/wrangler.js','r2','object','put','worldcons-artifacts/'+key,'--remote','--file',file,'--content-type','application/json'],{encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
}};
await mkdir(dir,{recursive:true});
const now=new Date().toISOString(),requests=[{sourceKey:'fr-conseil-constitutionnel' as const,limit:1,rangeDays:14,now},{sourceKey:'es-tribunal-constitucional' as const,limit:1,rangeDays:180,now}];
if(!process.argv.includes('--apply'))console.log(JSON.stringify({mode:'dry_run',requests,noHumanApproval:true}));
else {
  const deployed=JSON.parse(await readFile(dir+'/deployment.json','utf8'));
  if(!deployed.asyncVersionId||deployed.gitRef!=='87083a66dd705607106c5a1be77453e4e6698917')throw Error('seed.deployment_evidence_missing');
  const results=[];for(const input of requests)results.push(await enqueueIngestStageDiscovery(ingest,bucket,input));
  const report={at:now,mode:'production_official_discovery_rescan',deployment:deployed,requests,results,noSyntheticCase:true,noHumanApproval:true};
  await writeFile(dir+'/seed-discovery-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
