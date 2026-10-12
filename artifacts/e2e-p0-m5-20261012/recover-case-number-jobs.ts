/** Resume only diagnosed real-case dead letters through the existing fenced, rate-limited operator ledger. */
import {readFile,writeFile} from 'node:fs/promises';
import {operatorD1} from './operator-d1';
import {redriveIngestStageDeadLetter} from '../../lib/cloudflare/ingest-stages/redrive';
const dir='artifacts/e2e-p0-m5-20261012',plan=JSON.parse(await readFile(dir+'/genuine-recovery-plan.json','utf8')),results:unknown[]=[];
for(const job of plan.jobs){if(!process.argv.includes('--apply')){results.push({mode:'dry_run',jobId:job.id,articleId:job.article_id});continue;}
 const result=await redriveIngestStageDeadLetter(operatorD1('worldcons_ingest'),{stage:'public-judgment',jobId:job.id,operatorId:'e2e-p0-case-metadata-repair',reason:'Retry the original official-source job after fixing omitted Spanish caseNumber; retain all approval gates and original R2 source',expectedFencingToken:job.claimed_fencing_token,now:new Date().toISOString()});results.push({articleId:job.article_id,result});await writeFile(dir+'/genuine-recovery-result.json',JSON.stringify({at:new Date().toISOString(),results,noSyntheticCase:true,noHumanApproval:true},null,2));if(result.outcome!=='redriven')throw Error('recovery.denied:'+result.outcome);
}console.log(JSON.stringify({count:results.length,results}));
