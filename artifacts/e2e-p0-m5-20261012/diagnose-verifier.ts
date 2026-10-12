import {writeFile} from 'node:fs/promises';
import {operatorD1} from './operator-d1';
import {verifySearchRepair} from '../../lib/cloudflare/e2e/search-verification';
const core=operatorD1('worldcons_core'),search=operatorD1('worldcons_search'),events:unknown[]=[];
const rows=(await core.prepare("SELECT o.outbox_id,j.next_attempt_at,j.attempt_count FROM e2e_search_repair_outbox_v1 o JOIN e2e_verification_jobs_v1 j ON j.generation_id=o.generation_id WHERE o.status='pending' ORDER BY o.created_at LIMIT 1").all()).results!;
if(!rows.length)throw Error('diagnostic.no_pending');
for(const db of [core,search]){const prepare=db.prepare.bind(db);db.prepare=(sql)=>{const stmt=prepare(sql);for(const key of ['all','run'] as const){const old=stmt[key]?.bind(stmt);if(old)(stmt as unknown as Record<string,unknown>)[key]=async()=>{try{return await old();}catch(error){events.push({operation:sql.slice(0,80),error:error instanceof Error?error.message:String(error)});throw error;}};}return stmt;};}
const clockResponse=await fetch('https://worldcons-ingest.cclib.workers.dev/health'),date=clockResponse.headers.get('date'),offset=date?Date.parse(date)-Date.now():0;
const fetcher:typeof fetch=async(input,options)=>{try{const r=await fetch(input,options);events.push({url:String(input),status:r.status});return r;}catch(error){events.push({url:String(input),error:error instanceof Error?error.message:String(error)});throw error;}};
const result=await verifySearchRepair(core,search,{schemaVersion:1,type:'e2e-search-repair',outboxId:String(rows[0].outbox_id)},{apiBaseUrl:'https://worldcons.cclib.workers.dev/api/cclrag2',fetch:fetcher,clock:()=>new Date(Date.now()+offset).toISOString(),deploymentRef:'operator-diagnostic:git:007094f968773179ea056bed6dd10133565df98d;worldcons:b445ded5-d60d-41d0-b114-861a32ae3d0a'});
await writeFile('artifacts/e2e-p0-m5-20261012/verifier-diagnostic.json',JSON.stringify({mode:'operator_diagnostic_not_queue',result,events,offset},null,2));console.log(JSON.stringify({result,events,offset}));
