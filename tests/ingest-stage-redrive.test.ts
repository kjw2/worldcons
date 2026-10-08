import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import {
  claimIngestStageJobs,
  failIngestStageJob,
  getIngestStageJobById,
  registerIngestStageJob,
} from "../lib/cloudflare/ingest-stages/repository";
import {
  diagnoseIngestStageJobs,
  listIngestStageDeadLetterJobs,
  listIngestStageRedriveRecords,
  redriveIngestStageDeadLetter,
} from "../lib/cloudflare/ingest-stages/redrive";

const NOW = "2026-10-08T00:00:00.000Z";
const INGEST_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "d1", "worldcons_ingest", "0003_ingest_stage_jobs.sql"),
  "utf8",
);
const REDRIVE_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "d1", "worldcons_ingest", "0004_ingest_stage_redrive.sql"),
  "utf8",
);

function binding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const prepared: D1RuntimePreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return prepared;
        },
        async all<T>() {
          try {
            const rows = database.prepare(sql).all(...(values as SQLInputValue[])) as T[];
            return { success: true, results: rows };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
        async run() {
          try {
            const result = database.prepare(sql).run(...(values as SQLInputValue[]));
            return { success: true, results: [], meta: { changes: Number(result.changes) } };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return prepared;
    },
  };
}

function createDb() {
  const ingest = new DatabaseSync(":memory:");
  ingest.exec(INGEST_SCHEMA);
  ingest.exec(REDRIVE_SCHEMA);
  return { ingest, db: binding(ingest) };
}

/** Registers a job, terminally fails it under the given code, returns the dead-lettered row. */
async function deadLetterJob(
  db: D1RuntimeDatabase,
  input: { stage: Parameters<typeof registerIngestStageJob>[1]["stage"]; articleId: string; errorCode: string },
) {
  const { job } = await registerIngestStageJob(db, {
    stage: input.stage,
    articleId: input.articleId,
    sourceVersion: "v1",
    contentHash: "h1",
    now: NOW,
  });
  const [claimed] = await claimIngestStageJobs(db, {
    stage: input.stage,
    workerId: "w1",
    limit: 1,
    leaseSeconds: 300,
    now: NOW,
  });
  const failed = await failIngestStageJob(db, {
    jobId: claimed.id,
    fencingToken: claimed.claimed_fencing_token as string,
    stage: input.stage,
    errorCode: input.errorCode,
    retry: false,
    now: NOW,
  });
  assert.equal(failed?.status, "dead_letter");
  const row = await getIngestStageJobById(db, job.id);
  return { row: row!, fencingToken: row!.claimed_fencing_token };
}

test("diagnosis reports per-stage status counts and the oldest lease without cross-stage bleed", async () => {
  const { ingest, db } = createDb();
  try {
    await deadLetterJob(db, { stage: "crawl", articleId: "a-dead", errorCode: "crawler.source_unavailable_404" });
    await registerIngestStageJob(db, { stage: "crawl", articleId: "a-pending", sourceVersion: "v1", contentHash: "h2", now: NOW });
    // A leased job in another stage must never appear in the crawl diagnosis.
    const { job: otherJob } = await registerIngestStageJob(db, { stage: "normalize", articleId: "n1", sourceVersion: "v1", contentHash: "h3", now: NOW });
    await claimIngestStageJobs(db, { stage: "normalize", workerId: "w-other", limit: 1, leaseSeconds: 300, now: NOW });

    const crawl = await diagnoseIngestStageJobs(db, { stage: "crawl" });
    assert.equal(crawl.counts.dead_letter, 1);
    assert.equal(crawl.counts.pending, 1);
    assert.equal(crawl.deadLetterCount, 1);

    const normalize = await diagnoseIngestStageJobs(db, { stage: "normalize" });
    assert.equal(normalize.counts.leased, 1);
    assert.equal(normalize.counts.dead_letter, 0);
    assert.equal(normalize.oldestLeaseJobId, otherJob.id);
    assert.equal(normalize.oldestLeaseExpiresAt, "2026-10-08T00:05:00.000Z");

    // The dead-letter list is bounded to the stage and exposes the fence token.
    const dead = await listIngestStageDeadLetterJobs(db, { stage: "crawl" });
    assert.equal(dead.length, 1);
    assert.equal(dead[0].lastErrorCode, "crawler.source_unavailable_404");
    assert.equal(dead[0].fencingToken, "1");
    assert.equal((await listIngestStageDeadLetterJobs(db, { stage: "normalize" })).length, 0);
  } finally {
    ingest.close();
  }
});

test("a redriven 404 source job returns to pending and is audited in the transition ledger", async () => {
  const { ingest, db } = createDb();
  try {
    const { row } = await deadLetterJob(db, { stage: "crawl", articleId: "a1", errorCode: "crawler.source_unavailable_404" });
    const result = await redriveIngestStageDeadLetter(db, {
      stage: "crawl",
      jobId: row.id,
      operatorId: "operator@example.com",
      reason: "official source back online; recheck",
      expectedFencingToken: row.claimed_fencing_token,
      now: NOW,
    });
    assert.equal(result.outcome, "redriven");
    assert.equal(result.status, "pending");
    const after = await getIngestStageJobById(db, row.id);
    assert.equal(after?.status, "pending");
    assert.equal(after?.attempt_count, 0);
    assert.equal(after?.claimed_fencing_token, null);
    assert.equal(after?.last_error_code, null);

    const ledger = await listIngestStageRedriveRecords(db, { jobId: row.id });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].outcome, "redriven");
    assert.equal(ledger[0].operator_id, "operator@example.com");
    assert.equal(ledger[0].previous_status, "dead_letter");
  } finally {
    ingest.close();
  }
});

test("a 429 retryable failure stays pending (never dead-lettered) and outside the redrive surface", async () => {
  const { ingest, db } = createDb();
  try {
    const { job } = await registerIngestStageJob(db, { stage: "crawl", articleId: "r1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    let [claimed] = await claimIngestStageJobs(db, { stage: "crawl", workerId: "w1", limit: 1, leaseSeconds: 300, now: NOW });
    // Repeated bounded 429 retries cycle pending -> leased, never dead_letter.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retried = await failIngestStageJob(db, {
        jobId: claimed.id,
        fencingToken: claimed.claimed_fencing_token as string,
        stage: "crawl",
        errorCode: "crawler.http_429",
        retry: true,
        backoffSeconds: 60,
        now: NOW,
      });
      assert.equal(retried?.status, "pending");
      const later = new Date(Date.parse(NOW) + (attempt + 1) * 120_000).toISOString();
      [claimed] = await claimIngestStageJobs(db, { stage: "crawl", workerId: "w1", limit: 1, leaseSeconds: 300, now: later });
    }
    const row = await getIngestStageJobById(db, job.id);
    assert.equal(row?.status, "leased");
    assert.equal((await listIngestStageDeadLetterJobs(db, { stage: "crawl" })).length, 0);

    // Redriving a non-terminal (leased) job is denied as a nonterminal conflict.
    const denied = await redriveIngestStageDeadLetter(db, {
      stage: "crawl",
      jobId: job.id,
      operatorId: "op",
      reason: "speculative",
      expectedFencingToken: row?.claimed_fencing_token ?? null,
      now: NOW,
    });
    assert.equal(denied.outcome, "denied_nonterminal");
    assert.equal((await getIngestStageJobById(db, job.id))?.status, "leased");
  } finally {
    ingest.close();
  }
});

test("redrive denies missing reason, stage mismatch, fencing mismatch and unknown jobs with distinct ledger outcomes", async () => {
  const { ingest, db } = createDb();
  try {
    const { row } = await deadLetterJob(db, { stage: "publish", articleId: "p1", errorCode: "ingest_stage.publish_ineligible" });

    const missingReason = await redriveIngestStageDeadLetter(db, {
      stage: "publish", jobId: row.id, operatorId: "op", reason: "   ", expectedFencingToken: row.claimed_fencing_token, now: NOW,
    });
    assert.equal(missingReason.outcome, "denied_missing_reason");

    const crossStage = await redriveIngestStageDeadLetter(db, {
      stage: "search", jobId: row.id, operatorId: "op", reason: "wrong stage", expectedFencingToken: row.claimed_fencing_token, now: NOW,
    });
    assert.equal(crossStage.outcome, "denied_stage_mismatch");
    // The job is untouched by a cross-stage attempt: it can never be moved stages.
    assert.equal((await getIngestStageJobById(db, row.id))?.status, "dead_letter");

    const wrongFence = await redriveIngestStageDeadLetter(db, {
      stage: "publish", jobId: row.id, operatorId: "op", reason: "stale view", expectedFencingToken: "999", now: NOW,
    });
    assert.equal(wrongFence.outcome, "denied_fencing_mismatch");
    assert.equal((await getIngestStageJobById(db, row.id))?.status, "dead_letter");

    const unknown = await redriveIngestStageDeadLetter(db, {
      stage: "publish", jobId: "does-not-exist", operatorId: "op", reason: "ghost", expectedFencingToken: null, now: NOW,
    });
    assert.equal(unknown.outcome, "denied_not_found");

    const outcomes = (await listIngestStageRedriveRecords(db, { jobId: row.id })).map((entry) => entry.outcome).sort();
    assert.deepEqual(outcomes, ["denied_fencing_mismatch", "denied_missing_reason", "denied_stage_mismatch"]);
    const ghost = await listIngestStageRedriveRecords(db, { jobId: "does-not-exist" });
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0].outcome, "denied_not_found");
  } finally {
    ingest.close();
  }
});

test("a second redrive of the same job is a nonterminal denial (double-redrive safety)", async () => {
  const { ingest, db } = createDb();
  try {
    const { row } = await deadLetterJob(db, { stage: "normalize", articleId: "n1", errorCode: "ingest_stage.normalize_failed" });
    const first = await redriveIngestStageDeadLetter(db, {
      stage: "normalize", jobId: row.id, operatorId: "op", reason: "retry once", expectedFencingToken: row.claimed_fencing_token, now: NOW,
    });
    assert.equal(first.outcome, "redriven");

    const second = await redriveIngestStageDeadLetter(db, {
      stage: "normalize", jobId: row.id, operatorId: "op", reason: "retry again", expectedFencingToken: row.claimed_fencing_token, now: NOW,
    });
    assert.equal(second.outcome, "denied_nonterminal");
    assert.equal((await getIngestStageJobById(db, row.id))?.status, "pending");
    const ledger = await listIngestStageRedriveRecords(db, { jobId: row.id });
    assert.deepEqual(ledger.map((entry) => entry.outcome).sort(), ["denied_nonterminal", "redriven"]);
  } finally {
    ingest.close();
  }
});

test("the per-operator rolling-window rate limit denies a mass redrive and records it", async () => {
  const { ingest, db } = createDb();
  try {
    const ids: Array<{ id: string; fence: string | null }> = [];
    for (let index = 0; index < 2; index += 1) {
      const { row } = await deadLetterJob(db, { stage: "translate", articleId: `t${index}`, errorCode: "ingest_stage.translate_failed" });
      ids.push({ id: row.id, fence: row.claimed_fencing_token });
    }
    const first = await redriveIngestStageDeadLetter(db, {
      stage: "translate", jobId: ids[0].id, operatorId: "bulk-op", reason: "batch", expectedFencingToken: ids[0].fence, maxPerWindow: 1, now: NOW,
    });
    assert.equal(first.outcome, "redriven");
    const second = await redriveIngestStageDeadLetter(db, {
      stage: "translate", jobId: ids[1].id, operatorId: "bulk-op", reason: "batch", expectedFencingToken: ids[1].fence, maxPerWindow: 1, now: NOW,
    });
    assert.equal(second.outcome, "denied_rate_limited");
    assert.equal((await getIngestStageJobById(db, ids[1].id))?.status, "dead_letter");
    // A different operator is unaffected by the first operator's window.
    const otherOp = await redriveIngestStageDeadLetter(db, {
      stage: "translate", jobId: ids[1].id, operatorId: "another-op", reason: "batch", expectedFencingToken: ids[1].fence, maxPerWindow: 1, now: NOW,
    });
    assert.equal(otherOp.outcome, "redriven");
  } finally {
    ingest.close();
  }
});

test("the redrive migration is additive, verified and non-destructive and the route is admin-gated with no public redrive", () => {
  assert.match(REDRIVE_SCHEMA, /create table if not exists ingest_stage_redrive_records\b/);
  const executable = REDRIVE_SCHEMA.replace(/--.*$/gm, "");
  for (const forbidden of ["drop table", "delete from", "truncate", "alter table", "pragma"]) {
    assert.ok(!executable.toLowerCase().includes(forbidden), `redrive migration must not contain ${forbidden}`);
  }
  const route = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "admin", "ingest", "dead-letter", "route.ts"),
    "utf8",
  );
  // Both methods require auth; the mutation requires an admin mutation auth check.
  assert.match(route, /isAuthorizedRequest\(request\)/);
  assert.match(route, /adminMutationAuthFailureStatus\(request\)/);
  assert.match(route, /redriveIngestStageDeadLetter/);
  assert.match(route, /parseAdminIngestStageRedriveBody/);
  // The POST must reject a request with no explicit confirmation (zod schema).
  const validation = fs.readFileSync(path.join(process.cwd(), "lib", "security", "admin-api-validation.ts"), "utf8");
  assert.match(validation, /confirmation must equal redrive/);
});
