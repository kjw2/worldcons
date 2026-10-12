import type {D1RuntimeDatabase} from '../d1/runtime-binding';
import {currentGenerations,e2eRows} from './generation-state';
import {CURRENT_OUTBOX_SQL} from './search-repair-dispatcher';
/** Operator recovery preserves approval/P3/Search receipts and the previous failure budget. */
export async function redriveSearchVerification(core:D1RuntimeDatabase,input:{outboxId:string;expectedVerificationFence:number;expectedOutboxFence:number;operatorId:string;reason:string;now:string}) {
 if(!/^[a-f0-9]{64}$/.test(input.outboxId)||!input.operatorId.trim()||input.operatorId.length>160||input.reason.trim().length<8||input.reason.length>500||!Number.isFinite(Date.parse(input.now)))throw Error('e2e.redrive_invalid');
 const row=(await e2eRows(core,'SELECT * FROM e2e_search_repair_outbox_v1 WHERE outbox_id=?',input.outboxId))[0];
 if(!row)throw Error('e2e.redrive_missing');const job=(await e2eRows(core,'SELECT * FROM e2e_verification_jobs_v1 WHERE generation_id=?',row.generation_id))[0];
 const receipt=(await e2eRows(core,'SELECT * FROM e2e_search_apply_receipts_v1 WHERE generation_id=?',row.generation_id))[0];
 const g=(await currentGenerations(core,[String(row.article_id)])).get(String(row.article_id));
 if(!job||!receipt||Number(receipt.fencing_token)!==Number(row.fencing_token)||!g?.input_current||g.generation_id!==row.generation_id||!['retry_wait','dead_letter'].includes(String(job.status))||!['pending','retry_wait','dead_letter'].includes(String(row.status))
  ||Number(job.verification_fence)!==input.expectedVerificationFence||Number(row.fencing_token)!==input.expectedOutboxFence)throw Error('e2e.redrive_stale');
 const recent=(await e2eRows(core,'SELECT count(*) n FROM e2e_verification_redrive_v1 WHERE operator_id=? AND created_at>=?',input.operatorId,new Date(Date.parse(input.now)-3600000).toISOString()))[0];
 if(Number(recent.n)>=20)throw Error('e2e.redrive_rate_limited');if(!core.batch)throw Error('e2e.redrive_batch_missing');
 const token=crypto.randomUUID(),recordId=crypto.randomUUID();
 const prior=JSON.stringify({outbox:row,verificationJob:job,noNewContentApproval:true});
 const results=await core.batch([
  core.prepare(`INSERT INTO e2e_commit_guards_v1(token,assertion) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM e2e_search_repair_outbox_v1 o JOIN e2e_verification_jobs_v1 j ON j.generation_id=o.generation_id WHERE o.outbox_id=? AND o.fencing_token=? AND o.status=? AND j.verification_fence=? AND j.status=? AND ${CURRENT_OUTBOX_SQL}) THEN 1 ELSE 0 END)`).bind(token,input.outboxId,input.expectedOutboxFence,row.status,input.expectedVerificationFence,job.status),
  core.prepare('INSERT INTO e2e_verification_redrive_v1 VALUES (?,?,?,?,?,?,?)').bind(recordId,row.generation_id,input.operatorId,input.reason,input.expectedVerificationFence,prior,input.now),
  core.prepare("UPDATE e2e_verification_jobs_v1 SET status='pending',attempt_count=0,first_failure_at=NULL,next_attempt_at=?,last_error_code=NULL,claimed_by=NULL,lease_expires_at=NULL,verification_fence=verification_fence+1,updated_at=? WHERE generation_id=?").bind(input.now,input.now,row.generation_id),
  core.prepare("UPDATE e2e_search_repair_outbox_v1 SET status='pending',next_attempt_at=?,next_dispatch_at=?,claimed_by=NULL,lease_expires_at=NULL,dispatch_owner=NULL,dispatch_token=NULL,dispatch_lease_expires_at=NULL,dispatch_fence=dispatch_fence+1,last_error_code=NULL,updated_at=? WHERE outbox_id=?").bind(input.now,input.now,input.now,input.outboxId),
  core.prepare("UPDATE e2e_generation_progress_v1 SET state='search_pending',last_error_code=NULL,updated_at=? WHERE generation_id=? AND state<>'completed_verified'").bind(input.now,row.generation_id),
  core.prepare('DELETE FROM e2e_commit_guards_v1 WHERE token=?').bind(token)]);
 if(results.length!==6||results.some(r=>r.success===false||r.error))throw Error('e2e.redrive_failed');
 return {recordId,generationId:String(row.generation_id),outboxId:input.outboxId,previousAttempts:Number(job.attempt_count),noNewContentApproval:true};
}
