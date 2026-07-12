import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEmptyGate0Report,
  GATE0_QUERIES,
  GATE0_TRANSACTION_BEGIN,
  redactGate0Value,
  renderGate0Text,
  stableJson,
  writeGate0Artifacts,
} from "../lib/admin/gate0";

test("Gate 0 SQL contract is aggregate/catalog read-only", () => {
  assert.equal(GATE0_TRANSACTION_BEGIN, "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

  for (const [queryId, query] of Object.entries(GATE0_QUERIES)) {
    const normalized = query.replace(/\s+/g, " ").trim();
    assert.match(normalized, /^(?:select|with)\b/i, `${queryId} must start with SELECT or WITH`);
    assert.doesNotMatch(
      normalized,
      /\b(?:insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|call|copy|vacuum|analyze|refresh)\b/i,
      `${queryId} contains a non-read-only statement`,
    );
  }

  assert.doesNotMatch(GATE0_QUERIES.stateDistributions, /\b(?:id|slug|url|title|message|metadata|payload|raw_text|cleaned_text)\b/i);
  assert.match(GATE0_QUERIES.publicationCounts, /count\(\*\) filter/);
  assert.match(GATE0_QUERIES.jobHealth, /count\(\*\) filter/);
});

test("Gate 0 redaction removes sensitive keys and values recursively", () => {
  const input = {
    safe: "queued",
    original_url: "not-even-retained",
    nested: {
      metadata: { harmless: true },
      status: "postgresql://operator:password@db.invalid/worldcons",
      note: "token=top-secret-value",
    },
    list: ["https://example.invalid/private", "failed"],
  };

  const serialized = stableJson(redactGate0Value(input));
  assert.match(serialized, /"safe": "queued"/);
  assert.match(serialized, /"original_url": "\[REDACTED\]"/);
  assert.match(serialized, /"metadata": "\[REDACTED\]"/);
  assert.doesNotMatch(serialized, /operator|password@|top-secret|example\.invalid/);
});

test("Gate 0 serialization and text rendering are deterministic", () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, b: 3 } }), stableJson({ a: { b: 3, y: 2 }, z: 1 }));

  const report = createEmptyGate0Report({
    commitSha: "a".repeat(40),
    capturedAt: "2026-07-12T00:00:00.000Z",
    environment: "ci",
    mode: "dry",
  });
  assert.equal(renderGate0Text(report), renderGate0Text(report));
  assert.match(renderGate0Text(report), /mode: dry/);
});

test("Gate 0 manifest hashes the exact deterministic artifact bytes", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worldcons-gate0-"));
  try {
    const report = createEmptyGate0Report({
      commitSha: "b".repeat(40),
      capturedAt: "2026-07-12T01:02:03.000Z",
      environment: "test",
      mode: "dry",
    });
    report.stateDistributions.push({ table: "articles", column: "status", state: "queued", count: 2 });

    const first = writeGate0Artifacts(temporaryRoot, report);
    const firstJson = fs.readFileSync(path.join(temporaryRoot, "gate0-report.json"));
    const firstText = fs.readFileSync(path.join(temporaryRoot, "gate0-report.txt"));
    const firstManifest = fs.readFileSync(path.join(temporaryRoot, "manifest.sha256"), "utf8");
    const expectedJsonHash = createHash("sha256").update(firstJson).digest("hex");
    const expectedTextHash = createHash("sha256").update(firstText).digest("hex");

    assert.equal(first.hashes["gate0-report.json"], expectedJsonHash);
    assert.equal(first.hashes["gate0-report.txt"], expectedTextHash);
    assert.equal(
      firstManifest,
      `${expectedJsonHash}  gate0-report.json\n${expectedTextHash}  gate0-report.txt\n`,
    );

    const second = writeGate0Artifacts(temporaryRoot, report);
    assert.equal(second.manifest, firstManifest);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
