import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import type { ArticlePublicationTransitionInput } from "@/lib/article-publication/types";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement, D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";


import type { E2EApprovalContext } from "@/lib/cloudflare/e2e/contracts";
class Statement implements D1RuntimePreparedStatement {
  values: unknown[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly before?: (sql:string,values:unknown[])=>void|Promise<void>) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { return (await this.all<T>()).results?.[0]??null; }
  async run(): Promise<D1RuntimeResult> {
    await this.before?.(this.sql,this.values);
    const info=this.db.prepare(this.sql).run(...this.values as never[]);
    return {success:true,meta:{changes:Number(info.changes)}};
  }
  async all<T>(): Promise<D1RuntimeResult<T>> {
    await this.before?.(this.sql,this.values);
    return { success: true, results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] };
  }
}

/** Executes actual SQL/constraints, not a resolver that assumes writes succeed. */
export class SqliteD1 implements D1RuntimeDatabase {
  readonly db = new DatabaseSync(":memory:");
  beforeBatch?: () => void | Promise<void>;
  beforeStatement?: (sql:string,values:unknown[])=>void|Promise<void>;
  queries:string[]=[];
  readonly searchOnly:boolean;
  batches = 0;
  failAtEnd = false;
  constructor(withM1:boolean|"search"|"ingest" = true) {
    this.searchOnly=withM1==="search";
    this.db.exec("PRAGMA foreign_keys=ON");
    const files=withM1==="ingest" ? ["0001_init.sql","0002_inventory_discovery_idempotency.sql","0003_ingest_stage_jobs.sql","0005_discovery_coverage.sql"] : withM1==="search" ? ["0001_init.sql","0002_e2e_generation_guards.sql"] : ["0001_init.sql", "0002_translation_pipeline.sql", "0003_ingest_core_bridge_ledger.sql",
      ...(withM1 ? ["0004_e2e_generations.sql", "0005_e2e_search_repair_outbox.sql", "0006_e2e_search_apply_receipts.sql", "0007_e2e_verification.sql"] : [])];
    for (const file of files) {
      this.db.exec(readFileSync(new URL(`../../d1/${withM1==="ingest"?"worldcons_ingest":this.searchOnly?"worldcons_search":"worldcons_core"}/${file}`, import.meta.url), "utf8"));
    }
    if (!this.searchOnly&&withM1!=="ingest") seed(this.db);
  }
  prepare(sql: string) { this.queries.push(sql); return new Statement(this.db, sql,(query,values)=>this.beforeStatement?.(query,values)); }
  async batch(statements: D1RuntimePreparedStatement[]) {
    await this.beforeBatch?.();
    this.batches++;
    this.db.exec("BEGIN");
    try {
      const results = (statements as Statement[]).map((statement) => {
        assert.ok(statement.values.length <= 100, "D1 bound-parameter limit");
        const prepared = this.db.prepare(statement.sql);
        if (/\bRETURNING\b/i.test(statement.sql)) {
          const returned = prepared.all(...statement.values as never[]);
          return { success: true, results: returned, meta: { changes: Number(this.db.prepare("SELECT changes() AS count").get()!.count) } };
        }
        const info = prepared.run(...statement.values as never[]);
        return { success: true, meta: { changes: Number(info.changes) } };
      });
      if (this.failAtEnd) {
        // Actual SQL error after P3/history/outbox/ledger inserts, before commit.
        this.db.exec(`INSERT INTO ${this.searchOnly?"e2e_search_commit_guards_v1":"e2e_commit_guards_v1"} (token,assertion) VALUES ('injected',0)`);
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  rows(table: string) { return this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
  close() { this.db.close(); }
}

export const articleId = "11111111-1111-4111-a111-111111111111";
export const approval: E2EApprovalContext = { policyVersion: "fr-es-approval-v1", mode: "automatic",
  evidenceRef: "fixture:approved-snapshot", sourceEvidenceRef: "fixture:official-source",
  pipelineRunId: "run-1", discoveryCandidateId: "candidate-1" };
export const metadata = { collection: { strategy: "api", confidence: 1, publishable: true,
  sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false } };

function seed(db: DatabaseSync) {
  db.prepare(`INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,
    original_url,canonical_url,original_language,original_title,korean_title,discovered_at,
    fetched_at,summarized_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,
    lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,
    translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    articleId,"fr-conseil-constitutionnel","FR","Conseil constitutionnel","decision",
    "https://www.conseil-constitutionnel.fr/decision/2026/fixture.htm",
    "https://www.conseil-constitutionnel.fr/decision/2026/fixture.htm","fr","Décision fixture","시험 판결",
    "2026-10-10T00:00:00Z","2026-10-10T01:00:00Z","2026-10-10T02:00:00Z","summarized","m1-fixture",
    "official decision text ".repeat(40),JSON.stringify({ summary: "승인된 요약", issues: ["평등", "권리"] }),
    JSON.stringify(metadata),"2026-10-10T00:00:00Z","2026-10-10T02:00:00Z",
    "source_text_ready","complete","unreviewed","clear","translated","approved");
}

export function input(db: SqliteD1, key: string, overrides: Partial<ArticlePublicationTransitionInput> = {}): ArticlePublicationTransitionInput {
  const p3 = db.db.prepare("SELECT current_revision FROM article_version_heads_p3 WHERE article_id=?").get(articleId);
  const v4 = db.db.prepare("SELECT current_revision FROM article_revision_heads_v4 WHERE article_id=?").get(articleId);
  const pub = db.db.prepare("SELECT revision FROM article_publications_p3 WHERE article_id=?").get(articleId);
  return { articleId, expectedVersionRevision: Math.max(Number(p3?.current_revision ?? 0), Number(v4?.current_revision ?? 0)),
    expectedPublicationRevision: Number(pub?.revision ?? 0), idempotencyKey: key, targetState: "published",
    captureLegacy: true, actorType: "compatibility", reason: "M1 fixture approval", e2eApproval: approval, ...overrides };
}

export async function publish(db: SqliteD1, key: string, overrides: Partial<ArticlePublicationTransitionInput> = {}) {
  const result = await transitionArticlePublicationInD1(db, input(db, key, overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
