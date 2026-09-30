import { getRuntimeD1Binding, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { adminCommandError } from "@/lib/admin/command-control-plane/errors";
import type {
  AbortAdminCommandRunInput,
  AbortedAdminCommandRun,
  AdminCommandLease,
  AdminCommandRepository,
  AdminCommandResult,
  AdminCommandRunStatus,
  AdminCommandTransition,
  ClaimAdminCommandInput,
  ClaimedAdminCommandAttempt,
  FailAdminCommandAttemptInput,
  RetriedAdminCommandRun,
  SubmitAdminCommandInput,
  SubmittedAdminCommand,
} from "@/lib/admin/command-control-plane/types";

type Row = Record<string, unknown>;

function binding() {
  return getRuntimeD1Binding("worldcons_ops");
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function nullableText(value: unknown) { return typeof value === "string" ? value : null; }
function num(value: unknown) { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function json(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  return {};
}

async function rows<T extends Row>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) throw new Error(result?.error || "admin_command_d1.read_failed");
  return result.results;
}

async function run(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = db.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("admin_command_d1.write_unavailable");
  const result = await statement.run();
  if (!result || result.success === false || result.error) throw new Error(result?.error || "admin_command_d1.write_failed");
  return result;
}

async function batch(db: D1RuntimeDatabase, statements: D1RuntimePreparedStatement[]) {
  if (!db.batch) {
    for (const statement of statements) {
      if (!statement.run) throw new Error("admin_command_d1.batch_unavailable");
      const result = await statement.run();
      if (result.success === false || result.error) throw new Error(result.error || "admin_command_d1.batch_failed");
    }
    return;
  }
  const results = await db.batch(statements);
  if (results.some((result) => result.success === false || result.error)) throw new Error("admin_command_d1.batch_failed");
}

function decimalId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return (BigInt(Date.now()) * 10_000_000n + BigInt(random)).toString();
}

function event(db: D1RuntimeDatabase, input: { commandId: string; runId?: string | null; attemptId?: string | null; type: string; actorType: string; actorId?: string | null; details?: Record<string, unknown> }) {
  return db.prepare("INSERT INTO admin_command_events (id,command_id,run_id,attempt_id,event_type,actor_type,actor_id,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(decimalId(), input.commandId, input.runId ?? null, input.attemptId ?? null, input.type, input.actorType, input.actorId ?? null, JSON.stringify(input.details ?? {}), new Date().toISOString());
}

function unavailable<T>(): AdminCommandResult<T> { return { ok: false, error: adminCommandError("unavailable") }; }
function internal<T>(): AdminCommandResult<T> { return { ok: false, error: adminCommandError("internal") }; }
function code<T>(value: Parameters<typeof adminCommandError>[0]): AdminCommandResult<T> { return { ok: false, error: adminCommandError(value) }; }

async function findRun(db: D1RuntimeDatabase, runId: string) {
  return (await rows<Row>(db, "SELECT * FROM admin_command_runs WHERE id=? LIMIT 1", [runId]))[0] ?? null;
}

async function findAttempt(db: D1RuntimeDatabase, attemptId: string) {
  return (await rows<Row>(db, "SELECT * FROM admin_command_attempts WHERE id=? LIMIT 1", [attemptId]))[0] ?? null;
}

function fence() { return decimalId(); }

export const d1AdminCommandRepository: AdminCommandRepository = {
  async submit(input: SubmitAdminCommandInput): Promise<AdminCommandResult<SubmittedAdminCommand>> {
    const db = binding(); if (!db) return unavailable();
    try {
      const existing = (await rows<Row>(db, "SELECT c.id AS command_id,r.id AS run_id,r.status FROM admin_commands c JOIN admin_command_runs r ON r.command_id=c.id WHERE c.command_type=? AND c.idempotency_key=? ORDER BY r.run_number DESC LIMIT 1", [input.commandType, input.idempotencyKey]))[0];
      if (existing) {
        await run(db, "INSERT INTO admin_command_events (id,command_id,run_id,event_type,actor_type,actor_id,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?,?)", [decimalId(), existing.command_id, existing.run_id, "command_deduplicated", "system", input.requestedBy ?? null, JSON.stringify({ reason: "idempotency" }), new Date().toISOString()]);
        return { ok: true, data: { commandId: text(existing.command_id), runId: text(existing.run_id), runStatus: text(existing.status) as AdminCommandRunStatus, created: false, deduplicated: true } };
      }
      if (!input.shadowOnly) {
        const active = (await rows<Row>(db, "SELECT c.id AS command_id,r.id AS run_id,r.status FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id WHERE r.dedupe_key=? AND r.status IN ('queued','running','retry_wait') LIMIT 1", [input.dedupeKey]))[0];
        if (active) {
          await run(db, "INSERT INTO admin_command_events (id,command_id,run_id,event_type,actor_type,actor_id,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?,?)", [decimalId(), active.command_id, active.run_id, "command_deduplicated", "system", input.requestedBy ?? null, JSON.stringify({ reason: "active_dedupe" }), new Date().toISOString()]);
          return { ok: true, data: { commandId: text(active.command_id), runId: text(active.run_id), runStatus: text(active.status) as AdminCommandRunStatus, created: false, deduplicated: true } };
        }
      }
      const now = new Date().toISOString();
      const commandId = crypto.randomUUID(); const runId = crypto.randomUUID();
      const status = input.shadowOnly ? "shadowed" : "queued";
      const base = Math.max(1, Math.min(input.retryBackoffBaseSeconds ?? 15, 86400));
      const cap = Math.max(base, Math.min(input.retryBackoffCapSeconds ?? 900, 604800));
      await batch(db, [
        db.prepare("INSERT INTO admin_commands (id,command_type,payload_ref,idempotency_key,requested_by,priority,created_at) VALUES (?,?,?,?,?,?,?)").bind(commandId,input.commandType,JSON.stringify(input.payloadRef ?? {}),input.idempotencyKey,input.requestedBy ?? null,input.priority ?? 0,now),
        db.prepare("INSERT INTO admin_command_runs (id,command_id,run_number,status,dedupe_key,priority,available_at,max_attempts,retry_backoff_base_seconds,retry_backoff_cap_seconds,retry_count,current_attempt_id,finished_at,result_summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL,?,'{}',?,?)").bind(runId,commandId,1,status,input.dedupeKey,input.priority ?? 0,now,Math.max(1,Math.min(input.maxAttempts ?? 3,100)),base,cap,input.shadowOnly ? now : null,now,now),
        event(db,{commandId,runId,type:"command_accepted",actorType:input.shadowOnly?"compatibility":"admin",actorId:input.requestedBy}),
        event(db,{commandId,runId,type:input.shadowOnly?"compatibility_shadowed":"run_queued",actorType:input.shadowOnly?"compatibility":"system",actorId:input.requestedBy}),
      ]);
      return { ok: true, data: { commandId, runId, runStatus: status, created: true, deduplicated: false } };
    } catch { return internal(); }
  },

  async claim(input: ClaimAdminCommandInput): Promise<AdminCommandResult<ClaimedAdminCommandAttempt | null>> {
    const db = binding(); if (!db) return unavailable();
    try {
      const now = new Date(); const nowIso = now.toISOString();
      const types = input.commandTypes ?? [];
      const typeClause = types.length ? `AND c.command_type IN (${types.map(()=>"?").join(",")})` : "";
      for (let scan=0; scan<10; scan+=1) {
        const candidate = (await rows<Row>(db, `SELECT r.*,c.command_type,c.payload_ref FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id LEFT JOIN admin_command_attempts a ON a.id=r.current_attempt_id WHERE r.abort_requested_at IS NULL ${typeClause} AND ((r.status IN ('queued','retry_wait') AND r.available_at<=?) OR (r.status='running' AND a.status='running' AND a.lease_expires_at<=?)) ORDER BY CASE WHEN r.status='running' THEN 0 ELSE 1 END,r.priority DESC,r.available_at,r.created_at LIMIT 1`, [...types,nowIso,nowIso]))[0];
        if (!candidate) return { ok:true,data:null };
        const runId=text(candidate.id), commandId=text(candidate.command_id);
        let reclaimed=false;
        if (candidate.status === "running") {
          const previous=await findAttempt(db,text(candidate.current_attempt_id));
          if (previous) {
            const attemptNumber=num(previous.attempt_number);
            await batch(db,[
              db.prepare("UPDATE admin_command_attempts SET status='lease_expired',finished_at=?,failure_disposition='lease_expired',error_code='lease_expired',error_message='Worker lease expired before terminalization.',updated_at=? WHERE id=? AND status='running'").bind(nowIso,nowIso,previous.id),
              event(db,{commandId,runId,attemptId:text(previous.id),type:"lease_reclaimed",actorType:"system",details:{attemptNumber}}),
            ]);
            if (attemptNumber >= num(candidate.max_attempts)) {
              await batch(db,[db.prepare("UPDATE admin_command_runs SET status='failed',finished_at=?,terminal_error_code='lease_attempts_exhausted',terminal_error_message='Maximum attempts exhausted after lease expiry.',updated_at=? WHERE id=?").bind(nowIso,nowIso,runId),event(db,{commandId,runId,type:"run_failed",actorType:"system",details:{errorCode:"lease_attempts_exhausted"}})]);
              continue;
            }
            reclaimed=true;
          }
        }
        const [{ next_attempt = 1 } = {}] = await rows<{next_attempt:number}>(db,"SELECT COALESCE(MAX(attempt_number),0)+1 AS next_attempt FROM admin_command_attempts WHERE run_id=?",[runId]);
        const attemptId=crypto.randomUUID(); const fencingToken=fence();
        const leaseExpiresAt=new Date(now.getTime()+Math.max(1,Math.min(input.leaseSeconds??60,86400))*1000).toISOString();
        await batch(db,[
          db.prepare("INSERT INTO admin_command_attempts (id,run_id,attempt_number,status,worker_id,fencing_token,lease_expires_at,heartbeat_at,started_at,result_summary,created_at,updated_at) VALUES (?,?,?,'running',?,?,?,?,?,'{}',?,?)").bind(attemptId,runId,next_attempt,input.workerId,fencingToken,leaseExpiresAt,nowIso,nowIso,nowIso,nowIso),
          db.prepare("UPDATE admin_command_runs SET status='running',current_attempt_id=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?").bind(attemptId,nowIso,nowIso,runId),
          event(db,{commandId,runId,attemptId,type:"attempt_claimed",actorType:"worker",actorId:input.workerId,details:{attemptNumber:next_attempt,reclaimed}}),
        ]);
        return {ok:true,data:{commandId,runId,attemptId,commandType:text(candidate.command_type),payloadRef:json(candidate.payload_ref),attemptNumber:next_attempt,fencingToken,leaseExpiresAt,abortRequestedAt:nullableText(candidate.abort_requested_at)}};
      }
      return {ok:true,data:null};
    } catch { return internal(); }
  },

  async heartbeat(attemptId, fencingToken, leaseSeconds=60): Promise<AdminCommandResult<AdminCommandLease>> {
    const db=binding(); if(!db)return unavailable();
    try {
      const attempt=await findAttempt(db,attemptId); if(!attempt)return code("not_found");
      const runRow=await findRun(db,text(attempt.run_id)); if(!runRow)return code("not_found");
      if(text(attempt.fencing_token)!==fencingToken || text(runRow.current_attempt_id)!==attemptId)return code("stale_fence");
      const now=new Date(); if(runRow.status!=="running"||attempt.status!=="running"||Date.parse(text(attempt.lease_expires_at))<=now.getTime())return code("lease_lost");
      if(runRow.abort_requested_at)return code("aborted");
      const heartbeatAt=now.toISOString(); const leaseExpiresAt=new Date(now.getTime()+Math.max(1,Math.min(leaseSeconds,86400))*1000).toISOString();
      await batch(db,[db.prepare("UPDATE admin_command_attempts SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND fencing_token=? AND status='running'").bind(heartbeatAt,leaseExpiresAt,heartbeatAt,attemptId,fencingToken),event(db,{commandId:text(runRow.command_id),runId:text(runRow.id),attemptId,type:"heartbeat",actorType:"worker",actorId:text(attempt.worker_id),details:{attemptNumber:num(attempt.attempt_number)}})]);
      return {ok:true,data:{attemptId,runId:text(runRow.id),fencingToken,heartbeatAt,leaseExpiresAt}};
    } catch{return internal();}
  },

  async complete(attemptId,fencingToken,resultSummary={}): Promise<AdminCommandResult<AdminCommandTransition>> {
    const db=binding(); if(!db)return unavailable();
    try {
      const attempt=await findAttempt(db,attemptId); if(!attempt)return code("not_found"); const runRow=await findRun(db,text(attempt.run_id)); if(!runRow)return code("not_found");
      if(text(attempt.fencing_token)!==fencingToken||text(runRow.current_attempt_id)!==attemptId)return code("stale_fence");
      if(runRow.abort_requested_at||runRow.status==="aborted")return code("aborted");
      const now=new Date().toISOString(); if(runRow.status!=="running"||attempt.status!=="running"||Date.parse(text(attempt.lease_expires_at))<=Date.now())return code("lease_lost");
      await batch(db,[db.prepare("UPDATE admin_command_attempts SET status='succeeded',finished_at=?,result_summary=?,updated_at=? WHERE id=?").bind(now,JSON.stringify(resultSummary),now,attemptId),db.prepare("UPDATE admin_command_runs SET status='succeeded',finished_at=?,result_summary=?,terminal_error_code=NULL,terminal_error_message=NULL,updated_at=? WHERE id=?").bind(now,JSON.stringify(resultSummary),now,runRow.id),event(db,{commandId:text(runRow.command_id),runId:text(runRow.id),attemptId,type:"attempt_succeeded",actorType:"worker",actorId:text(attempt.worker_id),details:{attemptNumber:num(attempt.attempt_number)}})]);
      return {ok:true,data:{runId:text(runRow.id),runStatus:"succeeded",attemptId,attemptStatus:"succeeded"}};
    }catch{return internal();}
  },

  async fail(input: FailAdminCommandAttemptInput): Promise<AdminCommandResult<AdminCommandTransition>> {
    const db=binding(); if(!db)return unavailable();
    try {
      const attempt=await findAttempt(db,input.attemptId); if(!attempt)return code("not_found"); const runRow=await findRun(db,text(attempt.run_id)); if(!runRow)return code("not_found");
      if(text(attempt.fencing_token)!==input.fencingToken||text(runRow.current_attempt_id)!==input.attemptId)return code("stale_fence");
      if(runRow.abort_requested_at||runRow.status==="aborted")return code("aborted");
      if(runRow.status!=="running"||attempt.status!=="running"||Date.parse(text(attempt.lease_expires_at))<=Date.now())return code("lease_lost");
      const now=new Date(); const retryable=input.disposition==="retryable"&&num(attempt.attempt_number)<num(runRow.max_attempts); let retryAt:string|null=null;
      if(retryable){const delay=Math.min(num(runRow.retry_backoff_cap_seconds),num(runRow.retry_backoff_base_seconds)*2**Math.max(num(attempt.attempt_number)-1,0));retryAt=new Date(now.getTime()+delay*1000).toISOString();}
      const nowIso=now.toISOString(); const summary=JSON.stringify(input.resultSummary??{});
      const statements=[db.prepare("UPDATE admin_command_attempts SET status='failed',finished_at=?,failure_disposition=?,error_code=?,error_message=?,result_summary=?,updated_at=? WHERE id=?").bind(nowIso,input.disposition,input.errorCode.slice(0,160),input.errorMessage?.trim().slice(0,500)??null,summary,nowIso,input.attemptId)];
      if(retryable){statements.push(db.prepare("UPDATE admin_command_runs SET status='retry_wait',available_at=?,retry_count=retry_count+1,current_attempt_id=NULL,updated_at=? WHERE id=?").bind(retryAt,nowIso,runRow.id),event(db,{commandId:text(runRow.command_id),runId:text(runRow.id),attemptId:input.attemptId,type:"retry_scheduled",actorType:"worker",actorId:text(attempt.worker_id),details:{attemptNumber:num(attempt.attempt_number),errorCode:input.errorCode.slice(0,160)}}));}
      else{statements.push(db.prepare("UPDATE admin_command_runs SET status='failed',finished_at=?,terminal_error_code=?,terminal_error_message=?,result_summary=?,updated_at=? WHERE id=?").bind(nowIso,input.errorCode.slice(0,160),input.errorMessage?.trim().slice(0,500)??null,summary,nowIso,runRow.id),event(db,{commandId:text(runRow.command_id),runId:text(runRow.id),attemptId:input.attemptId,type:"run_failed",actorType:"worker",actorId:text(attempt.worker_id),details:{attemptNumber:num(attempt.attempt_number),errorCode:input.errorCode.slice(0,160),disposition:input.disposition}}));}
      await batch(db,statements); return {ok:true,data:{runId:text(runRow.id),runStatus:retryable?"retry_wait":"failed",attemptId:input.attemptId,attemptStatus:"failed",retryAt}};
    }catch{return internal();}
  },

  async abort(input: AbortAdminCommandRunInput): Promise<AdminCommandResult<AbortedAdminCommandRun>> {
    const db=binding(); if(!db)return unavailable();
    try {const runRow=await findRun(db,input.runId);if(!runRow)return code("not_found"); if(["succeeded","failed","aborted","shadowed"].includes(text(runRow.status)))return {ok:true,data:{runId:input.runId,runStatus:text(runRow.status) as AdminCommandRunStatus,abortRequestedAt:nullableText(runRow.abort_requested_at)??text(runRow.finished_at),finishedAt:text(runRow.finished_at)}};
      const now=new Date().toISOString(); const statements:D1RuntimePreparedStatement[]=[]; if(runRow.current_attempt_id)statements.push(db.prepare("UPDATE admin_command_attempts SET status='aborted',finished_at=?,failure_disposition='aborted',error_code='aborted',error_message='Execution was aborted by an administrator.',updated_at=? WHERE id=? AND status='running'").bind(now,now,runRow.current_attempt_id));
      statements.push(db.prepare("UPDATE admin_command_runs SET abort_requested_at=COALESCE(abort_requested_at,?),abort_requested_by=?,abort_reason=?,status='aborted',finished_at=?,terminal_error_code='aborted',terminal_error_message='Execution was aborted by an administrator.',updated_at=? WHERE id=?").bind(now,input.requestedBy,input.reason??null,now,now,input.runId),event(db,{commandId:text(runRow.command_id),runId:input.runId,attemptId:nullableText(runRow.current_attempt_id),type:"abort_requested",actorType:"admin",actorId:input.requestedBy,details:{hadActiveAttempt:Boolean(runRow.current_attempt_id)}}),event(db,{commandId:text(runRow.command_id),runId:input.runId,attemptId:nullableText(runRow.current_attempt_id),type:"run_aborted",actorType:"system",actorId:input.requestedBy})); await batch(db,statements);
      return {ok:true,data:{runId:input.runId,runStatus:"aborted",abortRequestedAt:now,finishedAt:now}};
    }catch{return internal();}
  },

  async retry(runId,requestedBy,reason): Promise<AdminCommandResult<RetriedAdminCommandRun>> {
    const db=binding(); if(!db)return unavailable();
    try {const previous=await findRun(db,runId);if(!previous)return code("not_found");if(!["failed","aborted"].includes(text(previous.status)))return code("not_retryable");
      const active=(await rows<Row>(db,"SELECT id FROM admin_command_runs WHERE dedupe_key=? AND status IN ('queued','running','retry_wait') LIMIT 1",[previous.dedupe_key]))[0];if(active)return code("active_duplicate");
      const [{next_number=1}={}] = await rows<{next_number:number}>(db,"SELECT COALESCE(MAX(run_number),0)+1 AS next_number FROM admin_command_runs WHERE command_id=?",[previous.command_id]);
      const id=crypto.randomUUID();const now=new Date().toISOString();await batch(db,[db.prepare("INSERT INTO admin_command_runs (id,command_id,run_number,status,dedupe_key,priority,available_at,max_attempts,retry_backoff_base_seconds,retry_backoff_cap_seconds,retry_count,result_summary,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?,?,?,0,'{}',?,?)").bind(id,previous.command_id,next_number,previous.dedupe_key,previous.priority,now,previous.max_attempts,previous.retry_backoff_base_seconds,previous.retry_backoff_cap_seconds,now,now),event(db,{commandId:text(previous.command_id),runId:id,type:"manual_retry_queued",actorType:"admin",actorId:requestedBy,details:{previousRunId:runId,reasonPresent:Boolean(reason?.trim())}})]);return {ok:true,data:{commandId:text(previous.command_id),runId:id,runNumber:next_number,runStatus:"queued"}};
    }catch{return internal();}
  },
};
