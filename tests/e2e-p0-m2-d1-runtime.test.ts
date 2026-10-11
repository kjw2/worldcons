import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { dispatchSearchRepairs } from "@/lib/cloudflare/e2e/search-repair-dispatcher";
import { SqliteD1, articleId, input } from "./helpers/e2e-core-fixture";

// Wrangler already owns this dev dependency. No Production config, credential,
// persistent directory or remote D1 connection is used by the workerd fixture.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("M2 local workerd D1: actual API batch/RETURNING and full publication rollback", async (t) => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules:true,script:'export default { fetch() { return new Response("fixture") } }',
    compatibilityDate:"2026-09-20",d1Databases:{ WORLDCONS_CORE:"e2e-p0-m2-isolated-core" },cf:false,telemetry:{ enabled:false },unsafeRegisterWorker:false }));
  t.after(async () => { await runtime.dispose(); });
  const db: D1RuntimeDatabase = await runtime.getD1Database("WORLDCONS_CORE");
  for (const name of ["0001_init.sql","0002_translation_pipeline.sql","0003_ingest_core_bridge_ledger.sql",
    "0004_e2e_generations.sql","0005_e2e_search_repair_outbox.sql"]) {
    // These fixture migrations contain no semicolon in SQL literals/triggers.
    const statements = readFileSync(new URL(`../d1/worldcons_core/${name}`,import.meta.url),"utf8")
      .replace(/^\s*--[^\n]*$/gm,"").split(";").filter((sql) => sql.trim()).map((sql) => db.prepare(sql));
    await db.batch!(statements);
  }
  const seed = new SqliteD1(); t.after(() => seed.close());
  const article = seed.rows("articles")[0];
  const columns = Object.keys(article);
  await db.prepare(`INSERT INTO articles (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...Object.values(article)).all();
  const first = await transitionArticlePublicationInD1(db,input(seed,"workerd-first"));
  assert.ok(first.ok,JSON.stringify(first));
  assert.ok(first.data.generation?.searchRepairOutboxId);
  const outbox = async () => (await db.prepare("SELECT * FROM e2e_search_repair_outbox_v1").all()).results!;
  const initial = (await outbox())[0];
  const now = String(initial.created_at);
  const sent = await dispatchSearchRepairs(db,{ send:async () => {} },{ clock:() => now,random:() => 0.5 });
  assert.equal(sent.sentCount,1,"actual D1 batch returns UPDATE RETURNING rows");
  assert.equal((await outbox())[0].status,"pending");
  assert.equal((await db.prepare("SELECT state FROM e2e_generation_progress_v1").all()).results![0].state,"search_pending");

  const previousOutbox = await outbox();
  await db.prepare("UPDATE articles SET korean_title='새 제목'").all();
  const request = { ...input(seed,"workerd-race"),expectedVersionRevision:first.data.versionRevision,
    expectedPublicationRevision:first.data.publicationRevision };
  const raced: D1RuntimeDatabase = { prepare:(sql) => db.prepare(sql),batch:async (statements) => {
    await db.prepare("UPDATE article_version_heads_p3 SET current_revision='99' WHERE article_id=?").bind(articleId).all();
    return db.batch!(statements);
  } };
  assert.deepEqual(await transitionArticlePublicationInD1(raced,request),{ ok:false,error:{ code:"stale_revision",retryable:true } });
  assert.deepEqual(await outbox(),previousOutbox);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_content_versions_p3").all()).results![0].count,1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM e2e_generations_v1").all()).results![0].count,1);

  // A failure AFTER every production statement must also roll back the new
  // P3 revision, generation, outbox and supersession of the preceding row.
  await db.prepare("UPDATE article_version_heads_p3 SET current_revision=? WHERE article_id=?").bind(String(first.data.versionRevision),articleId).all();
  const failing: D1RuntimeDatabase = { prepare:(sql) => db.prepare(sql),batch:(statements) => db.batch!([
    ...statements,db.prepare("INSERT INTO e2e_commit_guards_v1 (token,assertion) VALUES ('late-failure',0)"),
  ]) };
  assert.deepEqual(await transitionArticlePublicationInD1(failing,{ ...request,idempotencyKey:"workerd-late-failure" }),
    { ok:false,error:{ code:"stale_revision",retryable:true } });
  assert.deepEqual(await outbox(),previousOutbox);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_content_versions_p3").all()).results![0].count,1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM e2e_generations_v1").all()).results![0].count,1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM e2e_commit_guards_v1").all()).results![0].count,0);
});
