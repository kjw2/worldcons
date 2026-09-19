import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationRoot = path.join(process.cwd(), "supabase", "migrations");
const hardeningFile = "20260919190000_artifact_blob_contract_hardening.sql";
const hardeningPath = path.join(migrationRoot, hardeningFile);
const gate1File = "20260903120000_constitutional_case_backfill_gate1.sql";
const contractFile = "20260918100000_artifact_blob_storage_contract.sql";
const inlineClearFile = "20260919110000_artifact_blob_inline_clear.sql";

const hardeningSql = fs.readFileSync(hardeningPath, "utf8");

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

const hardening = executable(hardeningSql);
const gate1 = executable(readMigration(gate1File));
const contract = executable(readMigration(contractFile));
const inlineClear = executable(readMigration(inlineClearFile));

// --- the corrective migration itself ---------------------------------------

test("the corrective hardening migration is present, transactional, and additive", () => {
  assert.ok(fs.existsSync(hardeningPath));
  assert.match(hardeningSql, /^\s*begin;/i);
  assert.match(hardeningSql, /commit;\s*$/i);

  // No destructive or structural schema edits; only the two corrective ALTERs.
  assert.doesNotMatch(hardening, /drop\s+(table|column|constraint)\b/);
  assert.doesNotMatch(hardening, /\btruncate\b/);
  assert.doesNotMatch(hardening, /\bcreate\s+(table|index|trigger|function|policy)\b/);
  assert.doesNotMatch(hardening, /\b(alter table \w+ (add|drop) column|add column)\b/);

  const alteredTables = [...hardening.matchAll(/alter table ([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(alteredTables)].sort(),
    ["source_fetch_artifacts", "source_normalization_artifacts"],
    "only the two artifact tables may be altered",
  );
});

test("the migration documents that it is safe corrective pre-production hardening", () => {
  assert.match(hardeningSql, /corrective/i);
  assert.match(hardeningSql, /pre-production/i);
  assert.match(hardeningSql, /no dml/i);
  assert.match(hardeningSql, /no blob or network/i);
  assert.match(hardeningSql, /no maintenance/i);
  assert.match(hardeningSql, /changes no grant/i);
  assert.match(hardeningSql, /4 MiB/);
  // It points at the exact upstream objects it corrects.
  assert.match(hardeningSql, /20260903120000_constitutional_case_backfill_gate1\.sql|Gate 1/);
  assert.match(hardeningSql, /20260919110000_artifact_blob_inline_clear\.sql/);
  assert.match(hardeningSql, /20260918100000_artifact_blob_storage_contract\.sql/);
  assert.match(hardeningSql, /source_normalization_artifacts_json_check/);
});

// --- defect 1: normalized_output nullability --------------------------------

test("normalized_output is dropped NOT NULL by the new migration alone", () => {
  assert.match(
    hardening,
    /alter table source_normalization_artifacts alter column normalized_output drop not null/,
  );

  // The original NOT NULL declaration in the Gate 1 schema is left untouched.
  assert.match(gate1, /normalized_output jsonb not null/);

  // DROP NOT NULL exists in exactly one migration: the corrective one.
  const withDropNotNull = migrationFiles().filter((file) =>
    /alter column normalized_output drop not null/i.test(readMigration(file)),
  );
  assert.deepEqual(withDropNotNull, [hardeningFile]);
});

test("the existing storage/json coherence check still makes NULL valid only when externalized", () => {
  // Both the object-with-bound branch and the null-with-storage-ref branch are still
  // the coherence gate the corrective relies on; M1 is unchanged.
  assert.match(
    contract,
    /jsonb_typeof\(normalized_output\) = 'object' and pg_column_size\(normalized_output\) <= 4194304/,
  );
  assert.match(contract, /normalized_output is null and normalized_output_storage_ref is not null/);
  assert.match(contract, /source_normalization_artifacts_externalization_contract_check/);

  // The M4B clear is unchanged and is exactly what requires the nullable column: it
  // nulls only the inline document and leaves every externalization column intact.
  assert.match(inlineClear, /update source_normalization_artifacts set normalized_output = null/);
  assert.match(inlineClear, /normalized_output_storage_ref/);
  assert.doesNotMatch(inlineClear, /set normalized_output_storage_ref\s*=/);
});

// --- defect 2: restored 4 MiB inline bound ----------------------------------

test("the 4 MiB inline bound is restored as a separate NOT VALID check that allows NULL", () => {
  assert.match(hardening, /add constraint source_fetch_artifacts_bounded_replay_payload_size_check/);
  assert.match(
    hardening,
    /check \(bounded_replay_payload is null or pg_column_size\(bounded_replay_payload\) <= 4194304\)/,
  );
  assert.match(hardening, /not valid/);
  assert.match(hardening, /validate constraint source_fetch_artifacts_bounded_replay_payload_size_check/);

  const addIndex = hardening.indexOf("not valid");
  const validateIndex = hardening.indexOf("validate constraint");
  assert.ok(addIndex >= 0 && validateIndex > addIndex, "the check is added NOT VALID before it is validated");

  // No unrelated check is dropped or rebuilt.
  assert.doesNotMatch(hardening, /drop constraint/);
  assert.doesNotMatch(hardening, /source_fetch_artifacts_replay_check/);
  assert.doesNotMatch(hardening, /source_fetch_artifacts_bounded_replay_ref_check/);
  assert.doesNotMatch(hardening, /source_fetch_artifacts_externalization_contract_check/);
});

test("the M1 replay check lost the bound and the corrective is what restores it", () => {
  // M1 replaced the replay check without the inline size bound (the regression).
  assert.match(contract, /source_fetch_artifacts_replay_check/);
  assert.doesNotMatch(contract, /pg_column_size\(bounded_replay_payload\)/);

  // Gate 1 still carries its original inline bound, unchanged.
  assert.match(gate1, /pg_column_size\(bounded_replay_payload\) <= 4194304/);

  // Across every migration, the inline bound lives only in Gate 1 and the corrective.
  const withInlineBound = migrationFiles().filter((file) =>
    /pg_column_size\(bounded_replay_payload\)/i.test(readMigration(file)),
  );
  assert.deepEqual(withInlineBound, [gate1File, hardeningFile].sort());
});

// --- safety envelope --------------------------------------------------------

test("the corrective migration performs no DML, grants, network, or maintenance", () => {
  assert.doesNotMatch(hardening, /\b(insert|update|delete|merge|truncate)\b/);
  assert.doesNotMatch(hardening, /\b(grant|revoke)\b/);
  assert.doesNotMatch(hardening, /\b(vacuum|pg_repack|reindex|cluster|analyze)\b/);
  assert.doesNotMatch(hardening, /enable row level security|create policy|create trigger/);
  assert.doesNotMatch(hardening, /(https?:|vercel|fetch\s*\()/);
  assert.equal(hardening.includes("blob"), false);
});

test("the artifact M1..M5 blob migrations remain present and untouched by this corrective", () => {
  for (const file of [
    contractFile,
    "20260919100000_artifact_blob_externalization_backfill.sql",
    inlineClearFile,
    "20260919120000_artifact_blob_readiness_observability.sql",
  ]) {
    assert.ok(fs.existsSync(path.join(migrationRoot, file)), `${file} must still exist`);
  }
});
