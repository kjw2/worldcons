import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync, type SQLInputValue} from "node:sqlite";
import {createD1ReferenceReadRepository} from "@/lib/reference-reads/d1-repository";

test("homepage counts exclude legacy publications superseded by a source-only Catalog authority",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  try{
    sqlite.exec(`
      CREATE TABLE articles(id TEXT,jurisdiction TEXT,status TEXT,catalog_ai_stale_v4 INTEGER,original_published_at TEXT,source_metadata TEXT);
      CREATE TABLE article_publications_p3(article_id TEXT,state TEXT,version_id TEXT);
      CREATE TABLE article_content_versions_p3(id TEXT,article_id TEXT,version_role TEXT,source_anchor_version_id TEXT,enrichment_source_content_hash TEXT,source_content_hash TEXT);
      CREATE TABLE case_catalog_publications_v1(article_id TEXT,state TEXT,source_anchor_version_id TEXT);
    `);
    const publishable=JSON.stringify({collection:{publishable:true}});
    for(const id of ["normal","source-only","enriched"]){
      sqlite.prepare("INSERT INTO articles VALUES (?, 'Germany','summarized',0,'2021-03-24',?)").run(id,publishable);
      sqlite.prepare("INSERT INTO article_publications_p3 VALUES (?,'published',?)").run(id,`pub-${id}`);
    }
    sqlite.exec(`
      INSERT INTO article_content_versions_p3 VALUES ('pub-normal','normal',NULL,NULL,NULL,NULL);
      INSERT INTO article_content_versions_p3 VALUES ('pub-source-only','source-only',NULL,NULL,NULL,NULL);
      INSERT INTO article_content_versions_p3 VALUES ('anchor-source-only','source-only','authoritative_source','anchor-source-only',NULL,'new-source-hash');
      INSERT INTO article_content_versions_p3 VALUES ('pub-enriched','enriched','enrichment_full','anchor-enriched','matched-hash',NULL);
      INSERT INTO article_content_versions_p3 VALUES ('anchor-enriched','enriched','authoritative_source','anchor-enriched',NULL,'matched-hash');
      INSERT INTO case_catalog_publications_v1 VALUES ('source-only','published','anchor-source-only');
      INSERT INTO case_catalog_publications_v1 VALUES ('enriched','published','anchor-enriched');
    `);
    const binding={prepare(sql:string){const stmt=sqlite.prepare(sql);let params:SQLInputValue[]=[];
      const chain={bind(...v:unknown[]){params=v as SQLInputValue[];return chain;},async all<T>(){return {success:true,results:stmt.all(...params) as T[]};}};
      return chain;
    }};
    const repo=createD1ReferenceReadRepository({binding});
    assert.deepEqual(await repo.listJurisdictionArticleCounts(["Germany"]),{Germany:2});
    sqlite.prepare("UPDATE articles SET catalog_ai_stale_v4=1 WHERE id='source-only'").run();
    assert.deepEqual(await repo.listJurisdictionArticleCounts(["Germany"]),{Germany:2});
    sqlite.prepare("UPDATE articles SET catalog_ai_stale_v4=1 WHERE id='normal'").run();
    assert.deepEqual(await repo.listJurisdictionArticleCounts(["Germany"]),{Germany:1});
  }finally{sqlite.close();}
});
