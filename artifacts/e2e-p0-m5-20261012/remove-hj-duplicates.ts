/** Withdraw only URL aliases with an older identical official HJ owner; never approves legal meaning. */
import {readFile,writeFile} from 'node:fs/promises';
import {operatorD1} from './operator-d1';
import {readArticlePublicationSnapshotFromD1,transitionArticlePublicationInD1} from '../../lib/cloudflare/core-write/authority';
const dir='artifacts/e2e-p0-m5-20261012',core=operatorD1('worldcons_core'),plan=JSON.parse(await readFile(dir+'/duplicate-removal-plan.json','utf8'));
const results:unknown[]=[];for(const group of plan.groups){for(const alias of group.aliases.filter((x:{state:string})=>x.state==='published')){
 if(!process.argv.includes('--apply')){results.push({mode:'dry_run',articleId:alias.id,officialId:group.officialId,keepArticleId:group.keep.id});continue;}
 const owner=(await core.prepare('SELECT canonical_url FROM articles WHERE id=?').bind(group.keep.id).all<{canonical_url:string}>()).results?.[0];
 if(!owner?.canonical_url.includes('/Show/'+group.officialId)||!alias.canonical_url.includes('/Show/'+group.officialId))throw Error('duplicate.owner_identity_changed');
 const snapshot=await readArticlePublicationSnapshotFromD1(core,alias.id);if(!snapshot.ok)throw Error('duplicate.snapshot_unavailable');
 const result=await transitionArticlePublicationInD1(core,{articleId:alias.id,expectedVersionRevision:snapshot.data.versionRevision,expectedPublicationRevision:snapshot.data.publicationRevision,expectedLegacyUpdatedAt:snapshot.data.legacyUpdatedAt,idempotencyKey:'official-hj-duplicate:'+alias.id+':'+group.keep.id,targetState:'withdrawn',captureLegacy:false,versionId:alias.version_id,actorType:'system',actorId:'e2e-p0-official-identity-repair',reason:'Withdraw duplicate official HJ '+group.officialId+' URL alias; original article '+group.keep.id+' and all snapshots retained'});
 results.push({articleId:alias.id,officialId:group.officialId,keepArticleId:group.keep.id,result});await writeFile(dir+'/duplicate-removal-result.json',JSON.stringify({at:new Date().toISOString(),mode:'production_remove_only',results,noHumanApproval:true},null,2));if(!result.ok)throw Error('duplicate.removal_failed:'+result.error.code);
}}console.log(JSON.stringify({count:results.length,results,noHumanApproval:true}));
