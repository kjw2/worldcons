import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationRoot = path.join(process.cwd(), "supabase", "migrations");
const guardFile = "20260919200000_article_raw_externalization_guard_generated_columns.sql";
const guardPath = path.join(migrationRoot, guardFile);
const caseKeyFile = "20260826400000_case_keys_and_ranked_pagination.sql";
const m6bFile = "20260919140000_article_raw_blob_externalization_backfill.sql";
const m6cFile = "20260919150000_article_raw_blob_inline_clear.sql";
const m6eFile = "20260919180000_article_raw_blob_restore.sql";
const priorGuardFiles = [m6bFile, m6cFile, m6eFile];

const guardSql = fs.readFileSync(guardPath, "utf8");

function readMigration(file: string): string {
  return fs.readFileSync(path.join(migrationRoot, file), "utf8");
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(migrationRoot)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

// Reduce a migration to its executable SQL so assertions describe statements and
// never accidentally match text inside comments. Whitespace is collapsed to make
// multi-line statements matchable.
function executable(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Executable body of the single named function, between $function$ markers. */
function functionBody(sql: string, name: string): string {
  const exec = executable(sql);
  const start = exec.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `${name} must be defined`);
  const open = exec.indexOf("$function$", start);
  assert.ok(open >= 0, `${name} must have a $function$ body`);
  const close = exec.indexOf("$function$;", open + 1);
  assert.ok(close > open, `${name} body must terminate`);
  return exec.slice(open + "$function$".length, close);
}

const guard = executable(guardSql);
const body = functionBody(guardSql, "article_raw_externalization_guard_v1");

// --- the corrective migration itself ---------------------------------------

test("the corrective migration is present, transactional, and replaces only the guard function", () => {
  assert.ok(fs.existsSync(guardPath));
  assert.match(guardSql, /^\s*begin;/i);
  assert.match(guardSql, /commit;\s*$/i);

  const createdFunctions = [...guard.matchAll(/create or replace function ([a-z0-9_]+)\(/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(createdFunctions, ["article_raw_externalization_guard_v1"]);
  assert.doesNotMatch(guard, /create table/);
  assert.doesNotMatch(guard, /create trigger/);
  assert.doesNotMatch(guard, /create index/);
  assert.doesNotMatch(guard, /create policy/);
});

test("the corrective recreates no trigger, changes no grant or ACL, and performs no DML or table rewrite", () => {
  assert.doesNotMatch(guard, /\b(create|drop|alter)\s+trigger\b/);
  assert.doesNotMatch(guard, /\b(grant|revoke)\b/);
  assert.doesNotMatch(guard, /\balter\s+table\b/);
  assert.doesNotMatch(guard, /\b(insert into|truncate|merge)\b/);
  assert.doesNotMatch(guard, /\b(update|delete from)\s+(public\.)?(articles|article_content_versions_p3)\b/);
  assert.doesNotMatch(guard, /\b(drop table|drop column|vacuum|reindex|cluster|analyze)\b/);
  // The only mutation in the body is the preserved one-time permit consumption,
  // exactly as in M6E; no permit table is added and no raw table is written.
  const deleteTargets = [...guard.matchAll(/delete from ([a-z_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(deleteTargets, [
    "article_raw_externalization_permits",
    "article_raw_inline_clear_permits",
    "article_raw_inline_restore_permits",
  ]);
});

// --- dynamic generated-column derivation -----------------------------------

test("the guard derives generated columns dynamically from pg_attribute for tg_relid", () => {
  assert.match(guard, /v_generated_columns text\[\]/);
  assert.match(guard, /from pg_attribute a/);
  assert.match(guard, /a\.attrelid = tg_relid/);
  assert.match(guard, /a\.attnum > 0/);
  assert.match(guard, /not a\.attisdropped/);
  assert.match(guard, /a\.attgenerated <> ''/);
  assert.match(guard, /into v_generated_columns/);
});

// --- exclusion in all three whole-row identity checks ----------------------

test("all three whole-row identity checks exclude the generated columns", () => {
  // There are exactly three whole-row OLD/NEW identity comparisons: attach, clear,
  // restore. Every one of them subtracts the generated columns from both sides.
  const wholeRowComparisons = [...body.matchAll(/is distinct from \(to_jsonb\(new\)/g)];
  assert.equal(wholeRowComparisons.length, 3, "there must be exactly three whole-row checks");
  assert.equal(
    (body.match(/- v_generated_columns\) is distinct from \(to_jsonb\(new\)/g) ?? []).length,
    3,
    "every whole-row check must subtract the generated columns",
  );

  assert.equal(
    (body.match(/\(to_jsonb\(old\) - v_meta_columns - v_generated_columns\)/g) ?? []).length,
    1,
    "the attach check must subtract the generated columns from OLD",
  );
  assert.equal(
    (body.match(/\(to_jsonb\(new\) - v_meta_columns - v_generated_columns\)/g) ?? []).length,
    1,
    "the attach check must subtract the generated columns from NEW",
  );
  assert.equal(
    (body.match(/\(to_jsonb\(old\) - 'raw_text' - v_generated_columns\)/g) ?? []).length,
    2,
    "the clear and restore checks must subtract the generated columns from OLD",
  );
  assert.equal(
    (body.match(/\(to_jsonb\(new\) - 'raw_text' - v_generated_columns\)/g) ?? []).length,
    2,
    "the clear and restore checks must subtract the generated columns from NEW",
  );
});

test("each exclusion sits inside its own attach, clear, and restore branch", () => {
  const clearCondition = "if v_old_raw is not null and v_new_raw is null then";
  const restoreCondition = "if v_old_raw is null and v_new_raw is not null then";
  const attachExclusion = "(to_jsonb(old) - v_meta_columns - v_generated_columns)";

  const clearIndex = body.indexOf(clearCondition);
  const restoreIndex = body.indexOf(restoreCondition);
  const attachIndex = body.indexOf(attachExclusion);
  assert.ok(clearIndex >= 0 && restoreIndex > clearIndex, "clear must precede restore");
  assert.ok(attachIndex > restoreIndex, "attach must follow restore");

  const clearBlock = body.slice(clearIndex, restoreIndex);
  const restoreBlock = body.slice(restoreIndex, attachIndex);
  const attachBlock = body.slice(attachIndex);

  assert.match(clearBlock, /\(to_jsonb\(old\) - 'raw_text' - v_generated_columns\) is distinct from \(to_jsonb\(new\) - 'raw_text' - v_generated_columns\)/);
  assert.match(restoreBlock, /\(to_jsonb\(old\) - 'raw_text' - v_generated_columns\) is distinct from \(to_jsonb\(new\) - 'raw_text' - v_generated_columns\)/);
  assert.match(attachBlock, /\(to_jsonb\(old\) - v_meta_columns - v_generated_columns\) is distinct from \(to_jsonb\(new\) - v_meta_columns - v_generated_columns\)/);
});

// --- every other M6E rule preserved byte-for-byte in semantics -------------

test("the guard keeps every M6E rule: table/delete gate, metadata exactness, attach, clear, restore", () => {
  assert.match(body, /if tg_table_name <> 'article_content_versions_p3' then/);
  assert.match(body, /if tg_op = 'delete' then/);
  assert.match(body, /worldcons-article-raw-blob-v1/);
  assert.match(body, /article_raw_externalization_immutable/);

  // attach: present + unchanged inline raw_text, all five metadata absent -> present.
  assert.match(body, /if v_old_raw is null or v_old_raw is distinct from v_new_raw then/);
  assert.match(
    body,
    /or \(to_jsonb\(old\) -> 'raw_text_blob_contract_version'\) is distinct from 'null'::jsonb/,
  );
  assert.match(body, /v_new_version <> 'worldcons-article-raw-blob-v1'/);

  // clear: present -> null only.
  assert.match(body, /if v_old_raw is not null and v_new_raw is null then/);
  // restore: null -> present only, with DB-side JSON-string size and SHA-256.
  assert.match(body, /if v_old_raw is null and v_new_raw is not null then/);
  assert.match(body, /v_new_size is distinct from octet_length\(to_json\(v_new_raw\)::text\)/);
  assert.match(
    body,
    /v_new_hash is distinct from encode\(extensions\.digest\(convert_to\(to_json\(v_new_raw\)::text, 'utf8'\), 'sha256'\), 'hex'\)/,
  );

  // One commit per operation, each gated by a matching permit and an M6B ledger row.
  assert.match(body, /from article_raw_externalization_permits p/);
  assert.match(body, /from article_raw_inline_clear_permits c/);
  assert.match(body, /from article_raw_inline_restore_permits r/);
  assert.equal((body.match(/from article_raw_externalization_ledger l/g) ?? []).length, 2);
  assert.equal((body.match(/for update;/g) ?? []).length, 3);
  assert.equal((body.match(/return new;/g) ?? []).length, 3);
});

test("removing the generated-column additions yields the exact M6E guard body", () => {
  const m6eBody = functionBody(readMigration(m6eFile), "article_raw_externalization_guard_v1");
  const withoutGeneratedColumns = body
    .replace("v_generated_columns text[];", "")
    .replace(
      /select coalesce\(array_agg\(a\.attname order by a\.attnum\), array\[\]::text\[\]\) into v_generated_columns from pg_attribute a where a\.attrelid = tg_relid and a\.attnum > 0 and not a\.attisdropped and a\.attgenerated <> '';/g,
      "",
    )
    .replace(/ - v_generated_columns/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(withoutGeneratedColumns, m6eBody.trim());
});

// --- previous migrations untouched -----------------------------------------

test("the generated-column logic lives in exactly one migration and no earlier guard is modified", () => {
  const withGeneratedExclusion = migrationFiles().filter((file) =>
    /attgenerated/i.test(readMigration(file)),
  );
  assert.deepEqual(withGeneratedExclusion, [guardFile]);

  const withDynamicSubtraction = migrationFiles().filter((file) =>
    /v_generated_columns/i.test(readMigration(file)),
  );
  assert.deepEqual(withDynamicSubtraction, [guardFile]);

  for (const file of priorGuardFiles) {
    assert.ok(fs.existsSync(path.join(migrationRoot, file)), `${file} must still exist`);
    assert.doesNotMatch(readMigration(file), /v_generated_columns/);
    assert.doesNotMatch(readMigration(file), /attgenerated/);
  }

  // The earlier guard migrations still carry their original, un-hardened whole-row
  // comparisons and are therefore demonstrably untouched.
  const m6b = readMigration(m6bFile);
  assert.match(m6b, /\(to_jsonb\(old\) - v_meta_columns\) is distinct from \(to_jsonb\(new\) - v_meta_columns\)/);
  const m6e = readMigration(m6eFile);
  assert.match(m6e, /\(to_jsonb\(old\) - v_meta_columns\) is distinct from \(to_jsonb\(new\) - v_meta_columns\)/);
  assert.match(m6e, /\(to_jsonb\(old\) - 'raw_text'\) is distinct from \(to_jsonb\(new\) - 'raw_text'\)/);

  // The trigger binding stays owned by M6B, unchanged; the corrective adds none.
  assert.match(
    executable(m6b),
    /create trigger article_content_versions_p3_immutable_trigger before update or delete on article_content_versions_p3/,
  );
  assert.match(executable(m6b), /execute function article_raw_externalization_guard_v1\(\)/);
});

// --- SQL text invariant -----------------------------------------------------

test("case_key is GENERATED ALWAYS STORED and the guard excludes every generated column without naming one", () => {
  const caseKeys = readMigration(caseKeyFile);
  assert.match(
    caseKeys,
    /alter table article_content_versions_p3\s+add column if not exists case_key text generated always as \(/,
  );

  // The guard must derive generated columns, not hardcode the known offender.
  assert.match(body, /a\.attgenerated <> ''/);
  assert.match(body, /a\.attrelid = tg_relid/);
  assert.equal(body.includes("case_key"), false, "the guard must not hardcode case_key");
});
