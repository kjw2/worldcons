import assert from "node:assert/strict";
import {DatabaseSync, type SQLInputValue} from "node:sqlite";
import test from "node:test";
import {runD1CacheOutboxDrain} from "@/workers/async-pipeline/src/cache-outbox-drain";

function setup(){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE article_cache_outbox_p3 (
    id TEXT PRIMARY KEY,status TEXT,available_at TEXT,created_at TEXT,updated_at TEXT,
    attempt_count INTEGER,max_attempts INTEGER,lease_owner TEXT,lease_token TEXT,
    lease_expires_at TEXT,delivered_at TEXT,dead_lettered_at TEXT,last_error_code TEXT
  )`);
  const db={prepare(sql:string){const statement=sqlite.prepare(sql);let values:SQLInputValue[]=[];
    const chain={
      bind(...args:unknown[]){values=args as SQLInputValue[];return chain;},
      async all<T>(){return {success:true,results:statement.all(...values) as T[]};},
    };
    return chain;
  }};
  const insert=(id:string,status="pending",attempts=0,leaseExpires:string|null=null)=>sqlite.prepare(
    "INSERT INTO article_cache_outbox_p3 (id,status,available_at,created_at,updated_at,attempt_count,max_attempts,lease_expires_at) VALUES (?,?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',?,12,?)"
  ).run(id,status,attempts,leaseExpires);
  return {sqlite,db,insert};
}

test("D1 cache outbox delivers only after successful revalidation and does not redeliver",async()=>{
  const x=setup();
  try{
    x.insert("first"); x.insert("second");
    let calls=0;
    const revalidate=async()=>{calls++;return {revalidated:true};};
    const first=await runD1CacheOutboxDrain(x.db,revalidate,{now:"2026-10-08T00:00:00.000Z"});
    assert.deepEqual(first,{claimedCount:2,deliveredCount:2,failedCount:0,deadLetterCount:0});
    assert.equal(calls,1);
    const again=await runD1CacheOutboxDrain(x.db,revalidate,{now:"2026-10-08T00:01:00.000Z"});
    assert.equal(again.claimedCount,0);
    assert.equal(calls,1);
    assert.equal(x.sqlite.prepare("SELECT COUNT(*) AS n FROM article_cache_outbox_p3 WHERE status='delivered'").get()?.n,2);
  }finally{x.sqlite.close();}
});

test("D1 cache outbox handles failed revalidation with bounded retry and never falsely acknowledges",async()=>{
  const x=setup();
  try{
    x.insert("retry");
    const result=await runD1CacheOutboxDrain(x.db,async()=>{throw new Error("down");},{now:"2026-10-08T00:00:00.000Z"});
    assert.deepEqual(result,{claimedCount:1,deliveredCount:0,failedCount:1,deadLetterCount:0});
    const item=x.sqlite.prepare("SELECT status,attempt_count,last_error_code,available_at FROM article_cache_outbox_p3 WHERE id='retry'").get();
    assert.equal(item?.status,"pending");
    assert.equal(item?.attempt_count,1);
    assert.equal(item?.last_error_code,"cache_outbox.revalidation_failed");
    assert.equal((await runD1CacheOutboxDrain(x.db,async()=>({revalidated:true}),{now:"2026-10-08T00:00:05.000Z"})).claimedCount,0);
  }finally{x.sqlite.close();}
});

test("expired leases can be reclaimed and max-attempt failures become dead letters",async()=>{
  const x=setup();
  try{
    x.insert("expired","processing",11,"2026-10-01T00:00:00.000Z");
    x.insert("locked","processing",0,"2026-10-09T00:00:00.000Z");
    const result=await runD1CacheOutboxDrain(x.db,async()=>({revalidated:false}),{now:"2026-10-08T00:00:00.000Z"});
    assert.deepEqual(result,{claimedCount:1,deliveredCount:0,failedCount:1,deadLetterCount:1});
    assert.equal(x.sqlite.prepare("SELECT status FROM article_cache_outbox_p3 WHERE id='expired'").get()?.status,"dead_letter");
    assert.equal(x.sqlite.prepare("SELECT status FROM article_cache_outbox_p3 WHERE id='locked'").get()?.status,"processing");
  }finally{x.sqlite.close();}
});
