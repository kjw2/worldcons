import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { adminStateLabel, commandStage, lifecycleStage } from "@/lib/admin/p4/labels";
import type {
  AdminWorkFilters,
  AdminWorkItem,
  AdminWorkItemDetail,
  AdminWorkQueueSnapshot,
  AdminWorkSlaFilter,
  AdminWorkTimelineEvent,
  AdminWorkType,
} from "@/lib/admin/p4/types";
import { redactAdminAuditText } from "@/lib/security/audit-redaction";
import {
  BVERFG_LIVE_DISCOVERY_EMPTY,
  BVERFG_OFFICIAL_DETAIL_404,
  BVERFG_OFFICIAL_VARIANTS_404,
} from "@/lib/ui/candidate-tracking-labels";

type Row = Record<string, unknown>;
const MAX_ROWS_PER_DOMAIN = 500;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>'"`]+/gi;

function text(row: Row, key: string) { return typeof row[key] === "string" ? row[key] as string : null; }
function number(row: Row, key: string) { const parsed = typeof row[key] === "number" ? row[key] as number : Number(row[key]); return Number.isFinite(parsed) ? parsed : 0; }
function dateOrNow(value?: string | null) { const date = value ? new Date(value) : new Date(); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }
function addMinutes(value: string, minutes: number) { return new Date(new Date(value).getTime() + minutes * 60_000).toISOString(); }
function slaState(dueAt: string, now = Date.now()) { const due = Date.parse(dueAt); if (!Number.isFinite(due) || due <= now) return "breached" as const; if (due - now <= 3_600_000) return "due" as const; return "healthy" as const; }
function rowLimit(filters: AdminWorkFilters) { return Math.min(MAX_ROWS_PER_DOMAIN, filters.page * filters.pageSize + filters.pageSize + 1); }
function ageCutoff(age: AdminWorkFilters["age"]) { const ms = age === "1h" ? 3_600_000 : age === "24h" ? 86_400_000 : age === "7d" ? 604_800_000 : age === "30d" ? 2_592_000_000 : null; return ms ? Date.now() - ms : null; }
function matchesSla(item: AdminWorkItem, filter: AdminWorkSlaFilter) { return filter === "all" || item.slaState === filter; }

export function redactOperationalText(value?: string | null) {
  if (!value) return null;
  return redactAdminAuditText(value, 300).replace(URL_PATTERN, "[redacted-url]");
}

async function rows<T extends Row>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) throw new Error(result?.error || "admin_p4_d1.read_failed");
  return result.results;
}

function executionItem(row: Row): AdminWorkItem {
  const id = text(row,"id") ?? "unknown";
  const status = text(row,"status") ?? "unknown";
  const commandType = text(row,"command_type") ?? "관리자 명령";
  const updatedAt = dateOrNow(text(row,"updated_at") ?? text(row,"created_at"));
  const dueAt = addMinutes(updatedAt,status === "running" ? 5 : 30);
  const lease = text(row,"lease_expires_at");
  const stale = status === "running" && Boolean(lease && Date.parse(lease) <= Date.now());
  return {
    id,type:"execution",stage:commandStage(commandType),title:commandType,target:`실행 ${number(row,"run_number") || 1}`,
    source:null,owner:text(row,"worker_id") ?? text(row,"requested_by"),execution:adminStateLabel(stale ? "lease_expired" : status),
    lifecycle:adminStateLabel(),publication:adminStateLabel(),attention:stale || ["failed","aborted"].includes(status) || Boolean(text(row,"abort_requested_at")),
    attentionCode:stale ? "lease_expired" : text(row,"error_code") ?? text(row,"terminal_error_code"),createdAt:dateOrNow(text(row,"created_at")),updatedAt,
    slaDueAt:dueAt,slaState:slaState(dueAt),latestError:redactOperationalText(text(row,"error_message") ?? text(row,"terminal_error_message")),
    attempts:Math.max(number(row,"attempt_number"),number(row,"retry_count")),compatibility:status === "shadowed",detailHref:`/admin/work/execution/${encodeURIComponent(id)}`,
    safeAction:["queued","running","retry_wait"].includes(status) ? "abort" : ["failed","aborted"].includes(status) ? "retry" : null,
    actionDisabledReason:status === "shadowed" ? "호환 기록은 종료 상태이므로 실행할 수 없습니다." : null,
  };
}

function lifecycleValue(row: Row) { return [text(row,"lifecycle_collection_state"),text(row,"lifecycle_processing_state"),text(row,"lifecycle_review_state")].filter(Boolean).join(" / ") || "not linked"; }
function articleItem(row: Row): AdminWorkItem {
  const id=text(row,"id")??"unknown"; const publication=text(row,"publication_state"); const processing=text(row,"lifecycle_processing_state"); const review=text(row,"lifecycle_review_state")??text(row,"review_state");
  const attentionState=text(row,"lifecycle_attention_state"); const attention=["active","anomaly"].includes(attentionState??"")||review==="needs_review"||Boolean(text(row,"error_class"));
  const updatedAt=dateOrNow(text(row,"updated_at")??text(row,"created_at")); const dueAt=addMinutes(updatedAt,attention?1440:10080);
  const eligible=text(row,"lifecycle_collection_state")==="source_text_ready"&&processing==="complete"&&["unreviewed","approved"].includes(review??"")&&attentionState==="clear";
  const safeAction=publication==="published"?"withdraw" as const:eligible&&["in_review","withdrawn"].includes(publication??"")?"publish" as const:null;
  return {id,type:"article",stage:publication?"publish":lifecycleStage(processing,review),title:text(row,"korean_title")??text(row,"original_title")??"제목 없는 기사",target:text(row,"slug")??id,source:text(row,"source_key"),owner:null,
    execution:adminStateLabel(),lifecycle:adminStateLabel(lifecycleValue(row)==="not linked"?text(row,"status"):lifecycleValue(row)),publication:adminStateLabel(publication),attention,
    attentionCode:text(row,"lifecycle_attention_code")??text(row,"error_class"),createdAt:dateOrNow(text(row,"created_at")??updatedAt),updatedAt,slaDueAt:dueAt,slaState:slaState(dueAt),
    latestError:redactOperationalText(text(row,"lifecycle_attention_code")??text(row,"error_class")),attempts:0,compatibility:false,detailHref:`/admin/work/article/${encodeURIComponent(id)}`,safeAction,
    actionDisabledReason:safeAction?null:publication==="draft"?"초안은 검토 단계를 거쳐야 공개할 수 있습니다.":!eligible?"수집, 처리, 검토 또는 주의 상태가 공개 요건을 충족하지 않습니다.":"현재 상태에서 허용되는 공개 전환이 없습니다."};
}

function candidateItem(row: Row): AdminWorkItem {
  const id=text(row,"id")??"unknown", status=text(row,"status")??"unknown", updatedAt=dateOrNow(text(row,"updated_at")??text(row,"created_at")), dueAt=addMinutes(updatedAt,status==="retrying"?30:1440);
  return {id,type:"candidate",stage:"collect",title:text(row,"candidate_type")??"URL 후보",target:`후보 ${id.slice(0,8)}`,source:text(row,"source_key"),owner:text(row,"discovered_by"),execution:adminStateLabel(),lifecycle:adminStateLabel(status),publication:adminStateLabel(),
    attention:["pending","retrying","failed"].includes(status),attentionCode:text(row,"last_error_code"),createdAt:dateOrNow(text(row,"created_at")),updatedAt,slaDueAt:dueAt,slaState:slaState(dueAt),latestError:redactOperationalText(text(row,"last_error_code"))??(status==="failed"?"candidate.retry_failed":null),attempts:number(row,"attempt_count"),compatibility:false,detailHref:`/admin/work/candidate/${encodeURIComponent(id)}`,safeAction:["pending","failed"].includes(status)?"candidate-retry":null,actionDisabledReason:status==="retrying"?"이미 재시도 중입니다.":["fetched","ignored"].includes(status)?"종료된 후보는 다시 등록할 수 없습니다.":null};
}

function outboxItem(row: Row): AdminWorkItem {
  const id=text(row,"id")??"unknown",status=text(row,"status")??"unknown",updatedAt=dateOrNow(text(row,"updated_at")??text(row,"created_at")),dueAt=addMinutes(text(row,"available_at")??updatedAt,5);
  return {id,type:"outbox",stage:"publish",title:text(row,"event_type")??"publication.changed",target:text(row,"article_slug")??`기사 ${(text(row,"article_id")??"").slice(0,8)}`,source:null,owner:text(row,"lease_owner"),execution:adminStateLabel(status),lifecycle:adminStateLabel(),publication:adminStateLabel(text(row,"publication_state")),attention:["pending","processing","dead_letter"].includes(status),attentionCode:text(row,"last_error_code"),createdAt:dateOrNow(text(row,"created_at")),updatedAt,slaDueAt:dueAt,slaState:slaState(dueAt),latestError:redactOperationalText(text(row,"last_error_code")),attempts:number(row,"attempt_count"),compatibility:false,detailHref:`/admin/work/outbox/${encodeURIComponent(id)}`,safeAction:null,actionDisabledReason:"캐시 전달은 자동 재시도 정책으로 처리됩니다."};
}

function legacyItem(row: Row): AdminWorkItem {
  const id=text(row,"id")??"unknown",status=text(row,"status")??"unknown",jobType=text(row,"job_type")??"호환 작업",updatedAt=dateOrNow(text(row,"updated_at")??text(row,"requested_at")??text(row,"created_at")),dueAt=addMinutes(updatedAt,status==="running"?30:60);
  return {id,type:"legacy",stage:commandStage(jobType),title:jobType,target:text(row,"article_slug")??text(row,"source_key")??`작업 ${id.slice(0,8)}`,source:text(row,"source_key"),owner:text(row,"worker_id"),execution:adminStateLabel(status),lifecycle:adminStateLabel(),publication:adminStateLabel(),attention:["failed","cancel_requested"].includes(status),attentionCode:text(row,"error_class"),createdAt:dateOrNow(text(row,"requested_at")??text(row,"created_at")),updatedAt,slaDueAt:dueAt,slaState:slaState(dueAt),latestError:redactOperationalText(text(row,"error_class")),attempts:0,compatibility:true,detailHref:`/admin/work/legacy/${encodeURIComponent(id)}`,safeAction:null,actionDisabledReason:"호환 작업은 읽기 전용으로 표시됩니다."};
}

export function filterAndSortD1AdminWorkItems(items: AdminWorkItem[], filters: AdminWorkFilters) {
  const cutoff=ageCutoff(filters.age), stateQuery=filters.state?.toLowerCase(), ownerQuery=filters.owner?.toLowerCase();
  return items.filter((item)=>filters.scope==="all"||(filters.scope==="operations"?item.type!=="candidate":item.type==="candidate"))
    .filter((item)=>!filters.owner||item.owner?.toLowerCase().includes(ownerQuery??""))
    .filter((item)=>!filters.stage||item.stage===filters.stage).filter((item)=>!filters.source||item.source===filters.source).filter((item)=>!filters.type||item.type===filters.type)
    .filter((item)=>!stateQuery||[item.execution.value,item.lifecycle.value,item.publication.value,item.attentionCode].some((value)=>value?.toLowerCase().includes(stateQuery)))
    .filter((item)=>filters.attention==="all"||(filters.attention==="required"?item.attention:!item.attention)).filter((item)=>matchesSla(item,filters.sla))
    .filter((item)=>cutoff===null||Date.parse(item.updatedAt)<=cutoff).sort((a,b)=>{if(filters.sort==="sla"){const due=a.slaDueAt.localeCompare(b.slaDueAt);if(due)return due;}else{const d=a.updatedAt.localeCompare(b.updatedAt);if(d)return filters.sort==="oldest"?d:-d;}return a.type.localeCompare(b.type)||a.id.localeCompare(b.id);});
}

function paginate(items: AdminWorkItem[], filters: AdminWorkFilters) { const start=(filters.page-1)*filters.pageSize; return {items:items.slice(start,start+filters.pageSize),hasMore:start+filters.pageSize<items.length}; }
function counts(items: AdminWorkItem[]): AdminWorkQueueSnapshot["counts"] { const tracked=items.filter(i=>i.type==="candidate"&&i.attention), ops=items.filter(i=>i.type!=="candidate"); const d404=tracked.filter(i=>i.attentionCode===BVERFG_OFFICIAL_DETAIL_404||i.attentionCode===BVERFG_OFFICIAL_VARIANTS_404).length; const empty=tracked.filter(i=>i.attentionCode===BVERFG_LIVE_DISCOVERY_EMPTY).length; return {backlog:ops.filter(i=>!["succeeded","delivered","fetched","published"].includes(i.execution.value)&&i.attention).length,breached:ops.filter(i=>i.slaState==="breached"&&i.attention).length,failed:ops.filter(i=>i.execution.tone==="danger"||i.latestError).length,stale:ops.filter(i=>i.attentionCode==="lease_expired"||i.attentionCode==="job.stale_running").length,abortRequested:ops.filter(i=>i.execution.value==="abort_requested"||i.attentionCode==="aborted").length,outbox:ops.filter(i=>i.type==="outbox"&&i.attention).length,trackingCandidates:tracked.length,candidateOfficialDetail404:d404,candidateDiscoveryEmpty:empty,candidateOther:Math.max(0,tracked.length-d404-empty)}; }

export async function getD1AdminWorkQueueSnapshot(filters: AdminWorkFilters): Promise<AdminWorkQueueSnapshot> {
  const core=getRuntimeD1Binding("worldcons_core"),ingest=getRuntimeD1Binding("worldcons_ingest"),ops=getRuntimeD1Binding("worldcons_ops"); const generatedAt=new Date().toISOString();
  if(!core||!ingest||!ops) return {generatedAt,available:false,compatibilityMode:false,warnings:["Cloudflare D1 운영 바인딩이 완전하지 않습니다."],items:[],pageInfo:{page:filters.page,pageSize:filters.pageSize,total:0,hasMore:false,truncated:false},counts:counts([])};
  const limit=rowLimit(filters), warnings:string[]=[];
  const safe=async<T extends Row>(db:D1RuntimeDatabase,sql:string,values:unknown[]=[])=>{try{return await rows<T>(db,sql,values);}catch(e){warnings.push(e instanceof Error?e.message:String(e));return [] as T[];}};
  const [executions,articles,candidates,outbox,legacy]=await Promise.all([
    safe<Row>(ops,"SELECT r.*,c.command_type,c.requested_by,a.attempt_number,a.worker_id,a.lease_expires_at,a.error_code,a.error_message FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id LEFT JOIN admin_command_attempts a ON a.id=r.current_attempt_id ORDER BY r.updated_at DESC,r.id ASC LIMIT ?",[limit]),
    safe<Row>(core,"SELECT a.id,a.slug,a.source_key,a.original_title,a.korean_title,a.status,a.error_class,a.review_state,a.created_at,a.updated_at,a.lifecycle_collection_state,a.lifecycle_processing_state,a.lifecycle_review_state,a.lifecycle_attention_state,a.lifecycle_attention_code,p.state AS publication_state FROM articles a LEFT JOIN article_publications_p3 p ON p.article_id=a.id ORDER BY a.updated_at DESC,a.id ASC LIMIT ?",[limit]),
    safe<Row>(ingest,"SELECT id,source_key,candidate_type,discovered_by,status,last_attempt_at,attempt_count,last_error_code,last_error_message,created_at,updated_at FROM source_url_candidates ORDER BY updated_at DESC,id ASC LIMIT ?",[limit]),
    safe<Row>(core,"SELECT id,event_type,article_id,publication_id,publication_revision,version_id,publication_state,article_slug,status,attempt_count,max_attempts,available_at,lease_owner,lease_expires_at,last_error_code,delivered_at,dead_lettered_at,created_at,updated_at FROM article_cache_outbox_p3 ORDER BY updated_at DESC,id ASC LIMIT ?",[limit]),
    safe<Row>(ops,"SELECT id,job_type,status,source_key,article_id,article_slug,requested_at,started_at,finished_at,worker_id,progress_current,error_class,error_message,created_at,updated_at FROM admin_jobs ORDER BY updated_at DESC,id ASC LIMIT ?",[limit]),
  ]);
  const all=[...executions.map(executionItem),...articles.map(articleItem),...candidates.map(candidateItem),...outbox.map(outboxItem),...legacy.map(legacyItem)]; const filtered=filterAndSortD1AdminWorkItems(all,filters), page=paginate(filtered,filters);
  return {generatedAt,available:true,compatibilityMode:legacy.length>0,warnings:Array.from(new Set(warnings)),items:page.items,pageInfo:{page:filters.page,pageSize:filters.pageSize,total:filtered.length,hasMore:page.hasMore,truncated:[executions,articles,candidates,outbox,legacy].some(v=>v.length>=limit)},counts:counts(all)};
}

function timeline(row: { id:string; category:AdminWorkTimelineEvent["category"]; title:string; state:string; occurredAt:string; actor?:string|null; reason?:string|null; correlationId?:string|null }): AdminWorkTimelineEvent { return {id:row.id,category:row.category,title:row.title,state:row.state,occurredAt:row.occurredAt,actor:row.actor??null,reason:redactOperationalText(row.reason),correlationId:row.correlationId??null}; }

async function exactItem(type: AdminWorkType,id:string) {
  const core=getRuntimeD1Binding("worldcons_core"),ingest=getRuntimeD1Binding("worldcons_ingest"),ops=getRuntimeD1Binding("worldcons_ops"); if(!core||!ingest||!ops)return null;
  if(type==="execution"){const r=(await rows<Row>(ops,"SELECT r.*,c.command_type,c.requested_by,a.attempt_number,a.worker_id,a.lease_expires_at,a.heartbeat_at,a.fencing_token,a.error_code,a.error_message FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id LEFT JOIN admin_command_attempts a ON a.id=r.current_attempt_id WHERE r.id=? LIMIT 1",[id]))[0];return r?executionItem(r):null;}
  if(type==="article"){const r=(await rows<Row>(core,"SELECT a.id,a.slug,a.source_key,a.original_title,a.korean_title,a.status,a.error_class,a.review_state,a.created_at,a.updated_at,a.lifecycle_collection_state,a.lifecycle_processing_state,a.lifecycle_review_state,a.lifecycle_attention_state,a.lifecycle_attention_code,p.state AS publication_state FROM articles a LEFT JOIN article_publications_p3 p ON p.article_id=a.id WHERE a.id=? LIMIT 1",[id]))[0];return r?articleItem(r):null;}
  if(type==="candidate"){const r=(await rows<Row>(ingest,"SELECT id,source_key,candidate_type,discovered_by,status,last_attempt_at,attempt_count,last_error_code,last_error_message,created_at,updated_at FROM source_url_candidates WHERE id=? LIMIT 1",[id]))[0];return r?candidateItem(r):null;}
  if(type==="outbox"){const r=(await rows<Row>(core,"SELECT * FROM article_cache_outbox_p3 WHERE id=? LIMIT 1",[id]))[0];return r?outboxItem(r):null;}
  const r=(await rows<Row>(ops,"SELECT * FROM admin_jobs WHERE id=? LIMIT 1",[id]))[0];return r?legacyItem(r):null;
}

export async function getD1AdminWorkItemDetail(type:AdminWorkType,id:string):Promise<AdminWorkItemDetail|null>{
  const item=await exactItem(type,id);if(!item)return null;const core=getRuntimeD1Binding("worldcons_core"),ops=getRuntimeD1Binding("worldcons_ops");const events:AdminWorkTimelineEvent[]=[];let heartbeatAt:string|null=null,leaseExpiresAt:string|null=null,fencingToken:string|null=null,abortRequestedAt:string|null=null;
  if(type==="execution"&&ops){const run=(await rows<Row>(ops,"SELECT current_attempt_id,abort_requested_at FROM admin_command_runs WHERE id=? LIMIT 1",[id]))[0];abortRequestedAt=text(run??{},"abort_requested_at");if(run?.current_attempt_id){const a=(await rows<Row>(ops,"SELECT heartbeat_at,lease_expires_at,fencing_token FROM admin_command_attempts WHERE id=? LIMIT 1",[run.current_attempt_id]))[0];heartbeatAt=text(a??{},"heartbeat_at");leaseExpiresAt=text(a??{},"lease_expires_at");fencingToken=text(a??{},"fencing_token");}const ev=await rows<Row>(ops,"SELECT id,event_type,actor_type,actor_id,safe_details,occurred_at FROM admin_command_events WHERE run_id=? ORDER BY occurred_at DESC,id DESC LIMIT 100",[id]);for(const e of ev)events.push(timeline({id:text(e,"id")??crypto.randomUUID(),category:"execution",title:text(e,"event_type")??"event",state:text(e,"event_type")??"recorded",occurredAt:dateOrNow(text(e,"occurred_at")),actor:text(e,"actor_id")??text(e,"actor_type")}));}
  else if(type==="article"&&core){const life=await rows<Row>(core,"SELECT id,reason_code,actor_type,actor_id,review_state,processing_state,attention_state,occurred_at FROM article_lifecycle_events_p2 WHERE article_id=? ORDER BY occurred_at DESC,id DESC LIMIT 50",[id]);for(const e of life)events.push(timeline({id:text(e,"id")??crypto.randomUUID(),category:"lifecycle",title:text(e,"reason_code")??"lifecycle",state:text(e,"review_state")??text(e,"processing_state")??text(e,"attention_state")??"recorded",occurredAt:dateOrNow(text(e,"occurred_at")),actor:text(e,"actor_id")??text(e,"actor_type")}));const pub=await rows<Row>(core,"SELECT id,to_state,actor_type,actor_id,reason,correlation_id,occurred_at FROM article_publication_history_p3 WHERE article_id=? ORDER BY occurred_at DESC,id DESC LIMIT 50",[id]);for(const e of pub)events.push(timeline({id:text(e,"id")??crypto.randomUUID(),category:"publication",title:"publication",state:text(e,"to_state")??"recorded",occurredAt:dateOrNow(text(e,"occurred_at")),actor:text(e,"actor_id")??text(e,"actor_type"),reason:text(e,"reason"),correlationId:text(e,"correlation_id")}));}
  if(events.length===0)events.push(timeline({id:item.id,category:item.type==="candidate"?"lifecycle":item.type==="outbox"?"outbox":"execution",title:item.title,state:item.execution.value!=="not linked"?item.execution.value:item.lifecycle.value,occurredAt:item.updatedAt,actor:item.owner,reason:item.latestError??item.attentionCode}));
  const links=item.type==="candidate"?[{href:`/admin/candidates?source=${encodeURIComponent(item.source??"")}`,label:"URL 후보"}]:item.type==="article"?[{href:`/admin/articles?q=${encodeURIComponent(item.target)}`,label:"기사"}]:[{href:"/admin/work",label:"통합 업무 큐"}];
  return {item,timeline:events.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id)),heartbeatAt,leaseExpiresAt,fencingToken,abortRequestedAt,links,warnings:[]};
}
