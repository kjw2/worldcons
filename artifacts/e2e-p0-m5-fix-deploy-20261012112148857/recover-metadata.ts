import {writeFile} from 'node:fs/promises';import {operatorD1} from './operator-d1';import {invalidateSearchMetadata,drainSearchMetadataRepairs} from '../../lib/cloudflare/search-projection/metadata-repair';
const core=operatorD1('worldcons_core'),search=operatorD1('worldcons_search');
const ids=['1bb21d1a-abb5-4585-a6ad-e2dd5dbbe20f','8ba82d90-0f28-4731-963b-760805af100d','8f70d967-250d-4935-858f-5b91304b709f','dfb04619-3a7f-4b82-8405-24d171b2abd3','eccd7fae-7606-42e0-808a-2ade103ca0c9'];
const before=(await core.prepare('SELECT article_id,version_id,state,revision FROM article_publications_p3 WHERE article_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY article_id').bind(...ids).all()).results!;
if(process.argv.includes('--apply')){for(const id of ids)await invalidateSearchMetadata(core,id);}
const result=process.argv.includes('--apply')?await drainSearchMetadataRepairs({WORLDCONS_CORE:core,WORLDCONS_SEARCH:search},30):{dryRun:true};
const after=(await core.prepare('SELECT article_id,version_id,state,revision FROM article_publications_p3 WHERE article_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY article_id').bind(...ids).all()).results!;
const journal=(await core.prepare('SELECT * FROM search_metadata_repairs_v1 ORDER BY article_id').all()).results!,attempts=(await core.prepare('SELECT * FROM search_metadata_attempts_v1 ORDER BY started_at').all()).results!;
const evidence={at:new Date().toISOString(),result,before,after,p3Unchanged:JSON.stringify(before)===JSON.stringify(after),journal,attempts,noNewContentApproval:true};await writeFile('artifacts/e2e-p0-m5-fix-deploy-20261012112148857/metadata-recovery.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));if(!evidence.p3Unchanged||('failed' in result&&result.failed))process.exitCode=1;
