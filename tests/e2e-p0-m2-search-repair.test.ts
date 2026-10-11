import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dispatchSearchRepairs, isSearchRepairMessage, readSearchRepairHealth, reconcileMissingSearchRepairs,
  type SearchRepairMessage } from "@/lib/cloudflare/e2e/search-repair-dispatcher";
import { normalizeD1MigrationSql, parseD1MigrationVerifyDirectives } from "@/lib/cloudflare/d1/remote/migration-apply";
import { runE2ESearchRepairScheduled } from "../workers/async-pipeline/src/e2e-search-repair-scheduled";
import { SqliteD1, approval, publish } from "./helpers/e2e-core-fixture";

const outbox = (db: SqliteD1) => db.rows("e2e_search_repair_outbox_v1");
function timing(db: SqliteD1) {
  let now = String(outbox(db).at(-1)!.created_at);
  return { clock: () => now, random: () => 0.5,
    set: (value: unknown) => { now = String(value); },
    advance: (seconds: number) => { now = new Date(Date.parse(now) + seconds * 1000).toISOString(); } };
}

test("M2 reserves one immutable Search identity in the publication batch; recollection adds no work", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const first = await publish(db,"first");
  const row = outbox(db)[0];
  assert.equal(row.outbox_id,first.generation?.searchRepairOutboxId);
  assert.equal(row.generation_id,first.generation?.generationId);
  assert.equal(row.expected_version_id,first.versionId);
  assert.equal(row.expected_publication_state,"published");
  assert.equal(row.operation,"project");
  assert.equal(row.attempt_count,0);
  assert.equal(row.status,"pending");
  assert.equal(row.payload_evidence_ref,approval.evidenceRef);
  db.db.exec("UPDATE articles SET discovered_at='new',fetched_at='new',summarized_at='new',updated_at='new'");
  const repeated = await publish(db,"recollection");
  assert.equal(repeated.generation?.created,false);
  assert.equal(repeated.generation?.searchRepairOutboxId,row.outbox_id);
  assert.deepEqual(outbox(db),[row]);
  assert.equal(db.rows("article_content_versions_p3").length,1);
});

test("M2 withdrawal reserves remove and invalidates old processing and transport fences atomically", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const first = await publish(db,"first");
  db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET status='leased',claimed_by='consumer',lease_expires_at='2099-01-01T00:00:00Z',fencing_token=4,dispatch_owner='old',dispatch_token='old',dispatch_fence=7,dispatch_lease_expires_at='2099-01-01T00:00:00Z'");
  const withdrawn = await publish(db,"withdraw",{ captureLegacy:false,versionId:first.versionId,targetState:"withdrawn" });
  const [old,current] = outbox(db);
  assert.equal(old.status,"superseded");
  assert.equal(old.fencing_token,5);
  assert.equal(old.dispatch_fence,8);
  assert.equal(old.claimed_by,null);
  assert.equal(old.dispatch_token,null);
  assert.equal(current.operation,"remove");
  assert.equal(current.generation_id,withdrawn.generation?.generationId);
  assert.equal(current.expected_version_id,first.versionId);
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"superseded");
  assert.equal(db.rows("article_content_versions_p3").length,1);
});

test("M2 commit-before-send recovery sends identity only and cannot record completion", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db), sent: SearchRepairMessage[] = [];
  const result = await dispatchSearchRepairs(db,{ send:async (body) => { sent.push(body); } },time);
  assert.equal(result.sentCount,1);
  assert.deepEqual(sent,[{ schemaVersion:1,type:"e2e-search-repair",outboxId:String(outbox(db)[0].outbox_id) }]);
  assert.equal(isSearchRepairMessage(sent[0]),true);
  assert.equal(isSearchRepairMessage({ ...sent[0],content:"unsafe-inline-snapshot" }),false);
  assert.equal(isSearchRepairMessage({ ...sent[0],schemaVersion:2 }),false);
  assert.equal(outbox(db)[0].status,"pending");
  assert.equal(outbox(db)[0].attempt_count,0);
  assert.equal(outbox(db)[0].verified_at,null);
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"search_pending");
  assert.equal(db.rows("article_content_versions_p3").length,1);
});

test("M2 accepted send with lost response retries the same identity without consuming processing attempts", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db), sent: SearchRepairMessage[] = [];
  const failed = await dispatchSearchRepairs(db,{ send:async (body) => { sent.push(body); throw new Error("secret-provider-body"); } },time);
  assert.equal(failed.failedCount,1);
  assert.equal(outbox(db)[0].last_dispatch_error_code,"e2e.queue_send_failed");
  assert.equal(JSON.stringify(outbox(db)).includes("secret-provider-body"),false);
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"retry_wait");
  time.set(outbox(db)[0].next_dispatch_at);
  assert.equal((await dispatchSearchRepairs(db,{ send:async (body) => { sent.push(body); } },time)).sentCount,1);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(outbox(db)[0].dispatch_count,2);
  assert.equal(outbox(db)[0].dispatch_failure_count,0);
  assert.equal(outbox(db)[0].attempt_count,0);
});

test("M2 interruption after accepted send preserves transport lease; expiry recovers by duplicate send", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db), sent: SearchRepairMessage[] = [];
  await assert.rejects(dispatchSearchRepairs(db,{ send:async (body) => {
    sent.push(body); db.beforeBatch = () => { db.beforeBatch=undefined; throw new Error("worker interrupted"); };
  } },time),/worker interrupted/);
  const stranded = outbox(db)[0];
  assert.ok(stranded.dispatch_token);
  assert.equal(stranded.dispatched_at,null);
  const queue = { send:async (body: SearchRepairMessage) => { sent.push(body); } };
  assert.equal((await dispatchSearchRepairs(db,queue,time)).claimedCount,0);
  time.set(stranded.dispatch_lease_expires_at);
  assert.equal((await dispatchSearchRepairs(db,queue,time)).sentCount,1);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(outbox(db)[0].dispatch_fence,2);
});

test("M2 simultaneous dispatchers have one owner and one send", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db), sent: SearchRepairMessage[] = [];
  const queue = { send:async (body: SearchRepairMessage) => { sent.push(body); } };
  const results = await Promise.all([dispatchSearchRepairs(db,queue,{ ...time,workerId:"a" }),dispatchSearchRepairs(db,queue,{ ...time,workerId:"b" })]);
  assert.equal(results.reduce((count,row) => count+row.sentCount,0),1);
  assert.equal(sent.length,1);
  assert.equal(outbox(db)[0].dispatch_count,1);
});

test("M2 late send confirmation cannot overwrite a newer transport owner", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  let arrived!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { arrived=resolve; });
  const barrier = new Promise<void>((resolve) => { release=resolve; });
  const old = dispatchSearchRepairs(db,{ send:async () => { arrived(); await barrier; } },{ ...time,workerId:"old" });
  await started;
  time.set(outbox(db)[0].dispatch_lease_expires_at);
  const next = await dispatchSearchRepairs(db,{ send:async () => {} },{ ...time,workerId:"new" });
  assert.equal(next.sentCount,1);
  const settled = outbox(db)[0], progress = db.rows("e2e_generation_progress_v1");
  release();
  assert.equal((await old).fencedCount,1);
  assert.deepEqual(outbox(db)[0],settled);
  assert.deepEqual(db.rows("e2e_generation_progress_v1"),progress);
});

test("M2 new generation while sending supersedes the old row and rejects its late result", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  const result = await dispatchSearchRepairs(db,{ send:async () => {
    await publish(db,"new-policy",{ e2eApproval:{ ...approval,policyVersion:"v2" } });
  } },time);
  assert.equal(result.fencedCount,1);
  const [old,current] = outbox(db);
  assert.equal(old.status,"superseded");
  assert.equal(old.dispatched_at,null);
  assert.equal(current.status,"pending");
  assert.equal(current.dispatch_count,0);
  assert.equal(db.rows("e2e_generation_progress_v1")[1].state,"publication_committed");
});

for (const exhaustion of ["attempts","time"]) {
  test(`M2 transport ${exhaustion} budget dead-letters without pretending Consumer processing`, async (t) => {
    const db = new SqliteD1(); t.after(() => db.close());
    await publish(db,"first");
    const time = timing(db), queue = { send:async () => { throw new Error("unavailable"); } };
    if (exhaustion === "attempts") db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET dispatch_failure_count=7");
    else db.db.prepare("UPDATE e2e_search_repair_outbox_v1 SET first_dispatch_failure_at=?").run(new Date(Date.parse(time.clock())-120*60*1000).toISOString());
    assert.equal((await dispatchSearchRepairs(db,queue,time)).deadLetterCount,1);
    assert.equal(outbox(db)[0].status,"dead_letter");
    assert.equal(outbox(db)[0].attempt_count,0);
    assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"dead_letter");
    time.advance(10000);
    assert.equal((await dispatchSearchRepairs(db,queue,time)).claimedCount,0);
    assert.equal((await readSearchRepairHealth(db,time.clock())).requiresAttention,true);
  });
}

test("M2 send failure cannot dead-letter an active Consumer lease", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET dispatch_failure_count=7");
  const result = await dispatchSearchRepairs(db,{ send:async () => {
    db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET status='leased',claimed_by='consumer',lease_expires_at='2099-01-01T00:00:00Z'");
    throw new Error("lost ack");
  } },time);
  assert.equal(result.fencedCount,1);
  assert.equal(outbox(db)[0].status,"leased");
  assert.equal(outbox(db)[0].claimed_by,"consumer");
});

test("M2 jitter is capped at 15 minutes and durable processing delay is respected", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET dispatch_failure_count=5");
  await dispatchSearchRepairs(db,{ send:async () => { throw new Error("unavailable"); } },{ ...time,random:() => 1 });
  assert.equal(Date.parse(String(outbox(db)[0].next_dispatch_at))-Date.parse(time.clock()),900000);
  time.set(outbox(db)[0].next_dispatch_at);
  db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET status='retry_wait',next_attempt_at='2099-01-01T00:00:00Z'");
  assert.equal((await dispatchSearchRepairs(db,{ send:async () => { assert.fail("processing not yet due"); } },time)).claimedCount,0);
});

test("M2 Consumer verification during send cannot be undone by transport settlement", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  const result = await dispatchSearchRepairs(db,{ send:async () => {
    db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET status='verified',verified_at='fixture:time',evidence_ref='fixture:verification'; UPDATE e2e_generation_progress_v1 SET state='completed_verified',verified_at='fixture:time',verification_evidence_ref='fixture:verification'");
  } },time);
  assert.equal(result.fencedCount,1);
  assert.equal(outbox(db)[0].status,"verified");
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"completed_verified");
});

test("M2 SQL failure after progress update rolls back settlement while keeping the durable lease", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  await assert.rejects(dispatchSearchRepairs(db,{ send:async () => { db.failAtEnd=true; } },time),/e2e_commit_snapshot_match/);
  assert.equal(db.rows("e2e_generation_progress_v1")[0].state,"publication_committed");
  assert.ok(outbox(db)[0].dispatch_token);
  assert.equal(outbox(db)[0].dispatched_at,null);
  assert.equal(outbox(db)[0].status,"pending");
});

test("M2 terminal work and changed Core publication heads never enter Queue", async (t) => {
  for (const state of ["verified","superseded","core-drift"]) {
    const db = new SqliteD1(); t.after(() => db.close());
    await publish(db,"first");
    const time = timing(db);
    if (state === "core-drift") db.db.exec("UPDATE article_publications_p3 SET revision='99'");
    else db.db.prepare("UPDATE e2e_search_repair_outbox_v1 SET status=?,verified_at='verified',evidence_ref='fixture:verified'").run(state);
    assert.equal((await dispatchSearchRepairs(db,{ send:async () => { assert.fail("must not send"); } },time)).claimedCount,0);
    if (state === "core-drift") assert.equal((await readSearchRepairHealth(db,time.clock())).coreIdentityDriftCount,1);
  }
});

test("M2 reconciliation repairs an M1 upgrade hole idempotently without new P3/generation", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const original = outbox(db)[0], time = timing(db);
  db.db.exec("DELETE FROM e2e_search_repair_outbox_v1");
  assert.equal((await readSearchRepairHealth(db,time.clock())).missingReservationCount,1);
  const results = await Promise.all([reconcileMissingSearchRepairs(db,time),reconcileMissingSearchRepairs(db,time)]);
  assert.equal(results.reduce((count,row) => count+row.reservedCount,0),1);
  assert.equal(outbox(db)[0].outbox_id,original.outbox_id);
  assert.equal(db.rows("article_content_versions_p3").length,1);
  assert.equal(db.rows("e2e_generations_v1").length,1);
});

test("M2 reconciliation snapshot race rolls back stale reservation", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const time = timing(db);
  db.db.exec("DELETE FROM e2e_search_repair_outbox_v1");
  db.beforeBatch = async () => {
    db.beforeBatch=undefined;
    await publish(db,"new-policy",{ e2eApproval:{ ...approval,policyVersion:"v2" } });
  };
  assert.equal((await reconcileMissingSearchRepairs(db,time)).conflictCount,1);
  assert.equal(outbox(db).length,1);
  assert.equal(outbox(db)[0].generation_seq,2);
  assert.equal(db.rows("e2e_commit_guards_v1").length,0);
});

test("M2 additive schema rerun preserves work; verified requires durable evidence", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  await publish(db,"first");
  const original = outbox(db);
  const sql = readFileSync(new URL("../d1/worldcons_core/0005_e2e_search_repair_outbox.sql",import.meta.url),"utf8");
  db.db.exec(sql);
  assert.deepEqual(outbox(db),original);
  assert.throws(() => db.db.exec("UPDATE e2e_search_repair_outbox_v1 SET status='verified'"),/CHECK constraint/);
  for (const verify of parseD1MigrationVerifyDirectives(sql)) {
    const stored = db.db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(verify.type,verify.name);
    assert.ok(stored);
    for (const fragment of verify.sqlIncludes ?? []) assert.ok(normalizeD1MigrationSql(String(stored.sql)).includes(normalizeD1MigrationSql(fragment)),verify.name);
  }
});

test("M2 scheduled dispatcher stays disabled until dedicated protected Consumer is ready", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const inaccessible = new Proxy(db,{ get() { throw new Error("must not access Core"); } });
  assert.deepEqual(await runE2ESearchRepairScheduled({ WORLDCONS_CORE:inaccessible }),{ skipped:true,reason:"disabled" });
  assert.deepEqual(await runE2ESearchRepairScheduled({ WORLDCONS_CORE:inaccessible,WORLDCONS_E2E_SEARCH_DISPATCH_ENABLED:"true" }),{ skipped:true,reason:"not_ready" });
  await publish(db,"first");
  let sent = 0;
  const env = { WORLDCONS_CORE:db,WORLDCONS_E2E_SEARCH_DISPATCH_ENABLED:"true",WORLDCONS_E2E_SEARCH_CONSUMER_READY:"true",
    E2E_SEARCH_REPAIR_QUEUE:{ send:async () => { sent++; } } };
  const result = await runE2ESearchRepairScheduled(env);
  assert.equal(result.skipped,false);
  assert.equal(sent,1);
  assert.equal(outbox(db)[0].status,"pending");
  const oldSchema = new SqliteD1(false); t.after(() => oldSchema.close());
  assert.deepEqual(await runE2ESearchRepairScheduled({ ...env,WORLDCONS_CORE:oldSchema }),{ skipped:true,reason:"unavailable" });
  assert.equal(oldSchema.batches,0);
});
