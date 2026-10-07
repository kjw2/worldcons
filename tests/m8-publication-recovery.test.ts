import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {hasPendingP3Publication} from "@/workers/async-pipeline/src/publication-recovery";

test("watchdog probes only complete, eligible, not-yet-published translations", async () => {
  const db=new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE articles (id TEXT,status TEXT,summary_json TEXT,translation_status TEXT,original_language TEXT,source_metadata TEXT);
      CREATE TABLE article_publications_p3 (article_id TEXT,state TEXT);
    `);
    const binding={prepare(sql: string){return {async all<T>(){return {success:true,results:db.prepare(sql).all() as T[]};}}}};
    const ready=JSON.stringify({collection:{publishable:true}});
    const insert=db.prepare("INSERT INTO articles VALUES (?,?,?,?,?,?)");
    assert.equal(await hasPendingP3Publication(binding),false);
    insert.run("not-translated","cleaned",null,"pending","de",ready);
    insert.run("unpublishable","summarized","{}","translated","de",JSON.stringify({collection:{publishable:false}}));
    insert.run("source-only","cleaned",null,"pending","de",ready);
    assert.equal(await hasPendingP3Publication(binding),false);
    insert.run("ready","summarized","{}","translated","de",ready);
    assert.equal(await hasPendingP3Publication(binding),true);
    db.prepare("INSERT INTO article_publications_p3 VALUES (?,?)").run("ready","published");
    assert.equal(await hasPendingP3Publication(binding),false);
    insert.run("korean","summarized","{}","not_required","ko",ready);
    assert.equal(await hasPendingP3Publication(binding),true);
  } finally { db.close(); }
});

test("watchdog probe fails closed on D1 query errors", async () => {
  await assert.rejects(
    () => hasPendingP3Publication({prepare:()=>({all:async()=>({success:false,error:"D1 unavailable"})})}),
    /m8\.pending_publication_probe_failed/u,
  );
});
