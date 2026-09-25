import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildD1ShadowParityReport,
  d1ShadowGateComparableMethods,
  d1ShadowParityExitCode,
  d1ShadowQuantile,
  parseD1ShadowNdjson,
  renderD1ShadowParityReportMarkdown,
  type D1ShadowParityReport,
} from "../lib/cloudflare/d1/shadow/report";
import { D1_SHADOW_EVENT_NAME, type D1ShadowEvent } from "../lib/cloudflare/d1/shadow/events";
import { runD1ShadowParityReportCli } from "../scripts/d1-shadow-parity-report";

/**
 * M6.5 parity report + gate tests. Every fixture is deterministic and inline;
 * the report must be order-independent, fail closed on any invalid input and
 * keep the global GO-D1-READ gate blocked regardless of M6 green data.
 */

const MIN_PER_METHOD = 20;

function validEvent(overrides: Partial<D1ShadowEvent> = {}): D1ShadowEvent {
  return {
    event: D1_SHADOW_EVENT_NAME,
    surface: "reference",
    method: "listSources",
    outcome: "matched",
    reason: null,
    errorCode: null,
    db: "worldcons_core",
    tables: ["sources"],
    primaryCount: 1,
    shadowCount: 1,
    primaryHash: "primary-hash-value",
    shadowHash: "primary-hash-value",
    diffPath: null,
    orderMatches: true,
    compared: true,
    readOutcome: "success",
    latencyMs: 12,
    ...overrides,
  };
}

function matched(surface: string, method: string, index: number): D1ShadowEvent {
  return validEvent({
    surface,
    method,
    primaryHash: `matched-hash-${index}`,
    shadowHash: `matched-hash-${index}`,
    primaryCount: index,
    shadowCount: index,
    latencyMs: 10 + index,
  });
}

function allGreenEvents(): D1ShadowEvent[] {
  const events: D1ShadowEvent[] = [];
  for (const { surface, method } of d1ShadowGateComparableMethods()) {
    for (let index = 0; index < MIN_PER_METHOD; index += 1) events.push(matched(surface, method, index));
  }
  return events;
}

function report(events: readonly unknown[], extra: Partial<Parameters<typeof buildD1ShadowParityReport>[0]> = {}) {
  return buildD1ShadowParityReport({ events, ...extra });
}

function methodStats(reportValue: D1ShadowParityReport, surface: string, method: string) {
  const surfaceStats = reportValue.surfaces.find((entry) => entry.surface === surface);
  const stats = surfaceStats?.methods.find((entry) => entry.method === method);
  assert.ok(stats, `missing method stats for ${surface}.${method}`);
  return stats;
}

test("all-green comparable fixture reaches m6 go_candidate while global GO-D1-READ stays blocked", () => {
  const reportValue = report(allGreenEvents());
  assert.equal(reportValue.m6EvidenceGate.status, "go_candidate");
  assert.equal(reportValue.globalGoD1Read.status, "blocked");
  assert.equal(reportValue.globalGoD1Read.ready, false);
  const blockers = reportValue.globalGoD1Read.blockers.map((blocker) => blocker.id);
  assert.deepEqual(blockers, ["search_m7", "rpc_admin_dashboard_snapshot", "rpc_admin_analytics_health_snapshot"]);
  assert.equal(reportValue.totals.compared, d1ShadowGateComparableMethods().length * MIN_PER_METHOD);
  assert.equal(reportValue.totals.mismatched, 0);
  assert.equal(reportValue.totals.errors, 0);
  assert.equal(reportValue.totals.timeouts, 0);
});

test("a missing comparable method yields insufficient_evidence", () => {
  const events = allGreenEvents();
  const dropped = events[0];
  const filtered = events.filter((event) => !(event.surface === dropped.surface && event.method === dropped.method));
  const reportValue = report(filtered);
  assert.equal(reportValue.m6EvidenceGate.status, "insufficient_evidence");
  const stats = methodStats(reportValue, dropped.surface, dropped.method);
  assert.equal(stats.compared, 0);
});

test("a single mismatch, error, timeout or invalid line forces no_go", () => {
  const green = allGreenEvents();

  const mismatched = validEvent({
    method: "listSources",
    outcome: "mismatched",
    reason: "result_mismatch",
    primaryHash: "primary",
    shadowHash: "shadow",
    diffPath: "listSources[0].name",
  });
  assert.equal(report([...green, mismatched]).m6EvidenceGate.status, "no_go");

  const errored = validEvent({ method: "listSources", outcome: "error", reason: "shadow_read_failed", errorCode: "read_error", compared: false, readOutcome: "error", primaryCount: null, shadowCount: null, primaryHash: null, shadowHash: null });
  assert.equal(report([...green, errored]).m6EvidenceGate.status, "no_go");

  const timedOut = validEvent({ method: "listSources", outcome: "timeout", reason: "timeout", compared: false, readOutcome: "timeout", primaryCount: null, shadowCount: null, primaryHash: null, shadowHash: null });
  assert.equal(report([...green, timedOut]).m6EvidenceGate.status, "no_go");

  assert.equal(report(green, { malformedJsonLines: 1 }).m6EvidenceGate.status, "no_go");
});

test("structurally impossible events fail closed", () => {
  const matchedButNotCompared = { ...validEvent(), compared: false };
  const reportValue = report([matchedButNotCompared]);
  assert.equal(reportValue.m6EvidenceGate.status, "no_go");
  assert.equal(reportValue.source.structurallyInvalidEvents, 1);
  assert.equal(reportValue.invalidReasons.compared_outcome_conflict, 1);

  const unknownSurface = { ...validEvent(), surface: "unknown_surface" };
  const unknownReport = report([unknownSurface]);
  assert.equal(unknownReport.source.structurallyInvalidEvents, 1);
  assert.equal(unknownReport.invalidReasons.unknown_surface_method, 1);
});

test("compare-disabled probes and skips never satisfy minimum compared coverage", () => {
  const disabled = validEvent({ method: "listSources", outcome: "disabled", reason: "compare_disabled", compared: false, readOutcome: "success", primaryCount: null, shadowCount: null, primaryHash: null, shadowHash: null });
  const skipped = validEvent({ method: "listSources", outcome: "skipped", reason: "projection_mode", compared: false, readOutcome: null, primaryCount: null, shadowCount: null, primaryHash: null, shadowHash: null });
  const reportValue = report(Array.from({ length: MIN_PER_METHOD }, () => disabled).concat(Array.from({ length: MIN_PER_METHOD }, () => skipped)));
  assert.equal(reportValue.m6EvidenceGate.status, "insufficient_evidence");
  const stats = methodStats(reportValue, "reference", "listSources");
  assert.equal(stats.compared, 0);
  assert.equal(stats.compareDisabled, MIN_PER_METHOD);
  assert.equal(stats.skipped, MIN_PER_METHOD);
  assert.equal(stats.reasonCounts.compare_disabled, MIN_PER_METHOD);
  assert.equal(stats.reasonCounts.projection_mode, MIN_PER_METHOD);
});

test("duplicate events are preserved as distinct samples", () => {
  const duplicate = matched("reference", "listSources", 1);
  const reportValue = report([duplicate, duplicate, duplicate]);
  assert.equal(reportValue.totals.events, 3);
  assert.equal(reportValue.totals.matched, 3);
  assert.equal(reportValue.source.duplicatePolicy, "preserve_every_sample_no_event_id");
});

test("input order does not change the JSON report", () => {
  const events = allGreenEvents();
  const forward = JSON.stringify(report(events));
  const reversed = JSON.stringify(report([...events].reverse()));
  const shuffled = JSON.stringify(report([...events].sort((left, right) => (left.latencyMs ?? 0) - (right.latencyMs ?? 0))));
  assert.equal(forward, reversed);
  assert.equal(forward, shuffled);
});

test("latency quantiles are deterministic and order-independent", () => {
  assert.equal(d1ShadowQuantile([0, 10, 20, 30, 40], 0.5), 20);
  assert.ok(Math.abs(d1ShadowQuantile([0, 10, 20, 30, 40], 0.95) - 38) < 1e-9);
  const values = [4, 1, 3, 2, 0];
  assert.equal(d1ShadowQuantile([...values].sort((a, b) => a - b), 0.5), d1ShadowQuantile([...values].reverse().sort((a, b) => a - b), 0.5));
});

test("order-only mismatches are counted without failing parity", () => {
  const events = allGreenEvents();
  events[0] = { ...events[0], orderMatches: false };
  const reportValue = report(events);
  assert.equal(reportValue.totals.orderOnlyMismatch, 1);
  assert.equal(reportValue.m6EvidenceGate.status, "go_candidate");
});

test("safe output contains no hashes, diff paths, URLs, search_query, metadata, client_ip_hash or row content", () => {
  const secretEvent = validEvent({
    method: "listSources",
    primaryHash: "PRIMARY_HASH_SENTINEL",
    shadowHash: "PRIMARY_HASH_SENTINEL",
    search_query: "SELECT secret",
    metadata: { token: "metadata-secret" },
    client_ip_hash: "ip-hash-secret",
    url: "https://secret.example/row?q=secret",
    row: { cleaned_text: "row-content-secret" },
  } as Partial<D1ShadowEvent>);
  const mismatchEvent = validEvent({
    method: "listGlossaryTerms",
    outcome: "mismatched",
    reason: "result_mismatch",
    primaryHash: "PRIMARY_HASH_SENTINEL",
    shadowHash: "SHADOW_HASH_SENTINEL",
    diffPath: "listGlossaryTerms.secret.path",
  });
  const reportValue = report([secretEvent, mismatchEvent]);
  const json = JSON.stringify(reportValue);
  const markdown = renderD1ShadowParityReportMarkdown(reportValue);
  for (const forbidden of [
    "PRIMARY_HASH_SENTINEL",
    "SHADOW_HASH_SENTINEL",
    "listGlossaryTerms.secret.path",
    "secret.example",
    "metadata-secret",
    "ip-hash-secret",
    "row-content-secret",
    "SELECT secret",
  ]) {
    assert.ok(!json.includes(forbidden), `JSON report leaked ${forbidden}`);
    assert.ok(!markdown.includes(forbidden), `markdown report leaked ${forbidden}`);
  }
  const stats = methodStats(reportValue, "reference", "listGlossaryTerms");
  assert.equal(stats.diffPathPresent, 1);
});

test("unsafe reason and error codes are sanitized instead of emitted", () => {
  const event = validEvent({
    method: "listSources",
    outcome: "error",
    reason: "https://secret.example/query",
    errorCode: "row content secret",
    compared: false,
    readOutcome: "error",
    primaryCount: null,
    shadowCount: null,
    primaryHash: null,
    shadowHash: null,
  });
  const reportValue = report([event]);
  const json = JSON.stringify(reportValue);
  assert.ok(!json.includes("secret.example"));
  assert.ok(!json.includes("row content secret"));
  const stats = methodStats(reportValue, "reference", "listSources");
  assert.equal(stats.reasonCounts.unsanitized_code, 1);
  assert.equal(stats.errorCodeCounts.unsanitized_code, 1);
});

test("global GO-D1-READ remains blocked by all three obligations even with green M6 data", () => {
  const reportValue = report(allGreenEvents());
  assert.equal(reportValue.m6EvidenceGate.status, "go_candidate");
  assert.deepEqual(reportValue.globalGoD1Read.reasons, [
    "search_m7",
    "rpc_admin_dashboard_snapshot",
    "rpc_admin_analytics_health_snapshot",
  ]);
  assert.deepEqual(
    reportValue.deferredMethods.map((entry) => entry.blockerId),
    ["rpc_admin_dashboard_snapshot", "rpc_admin_analytics_health_snapshot"],
  );
});

test("strict-scope exit codes reflect m6 versus the always-blocked global gate", () => {
  const green = report(allGreenEvents());
  const insufficient = report([]);
  assert.equal(d1ShadowParityExitCode(green, "none"), 0);
  assert.equal(d1ShadowParityExitCode(green, "m6"), 0);
  assert.equal(d1ShadowParityExitCode(green, "global"), 1);
  assert.equal(d1ShadowParityExitCode(insufficient, "m6"), 1);
  assert.equal(d1ShadowParityExitCode(insufficient, "global"), 1);
});

test("empty/no-evidence fixture produces insufficient_evidence and a blocked global gate", () => {
  const text = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/d1-shadow-parity/no-evidence.ndjson"), "utf8");
  const parsed = parseD1ShadowNdjson(text);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.malformedJsonLines, 0);
  const reportValue = buildD1ShadowParityReport(parsed);
  assert.equal(reportValue.m6EvidenceGate.status, "insufficient_evidence");
  assert.equal(reportValue.globalGoD1Read.status, "blocked");
  assert.equal(reportValue.authority.goD1ReadClaimed, false);
  assert.equal(reportValue.authority.authoritySwitch, false);
});

test("CLI writes a markdown report and honors strict scope", async () => {
  const text = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/d1-shadow-parity/no-evidence.ndjson"), "utf8");
  let stdout = "";
  let stderr = "";
  const exitCode = await runD1ShadowParityReportCli({
    args: ["--input", "no-evidence.ndjson", "--format=markdown", "--strict-scope=m6"],
    readFile: () => text,
    readStdin: async () => text,
    writeFile: () => {},
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    stdinIsTty: false,
  });
  assert.equal(exitCode, 1);
  assert.match(stdout, /WorldCons D1 shadow parity report/);
  assert.match(stdout, /insufficient_evidence/);
  assert.match(stdout, /search_m7/);
  assert.equal(stderr, "");
});

test("CLI exits two on a TTY with no input and zero on help", async () => {
  const io = {
    args: [] as string[],
    readFile: () => "",
    readStdin: async () => "",
    writeFile: () => {},
    stdout: () => {},
    stderr: () => {},
    stdinIsTty: true,
  };
  assert.equal(await runD1ShadowParityReportCli(io), 2);
  let help = "";
  const helpCode = await runD1ShadowParityReportCli({ ...io, args: ["--help"], stdout: (value) => { help += value; } });
  assert.equal(helpCode, 0);
  assert.match(help, /--strict-scope/);
});

test("report and coverage modules stay free of Node builtins and runtime side effects", () => {
  for (const file of ["lib/cloudflare/d1/shadow/report.ts", "lib/cloudflare/d1/shadow/coverage.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, `${file} must not import a node: builtin`);
    assert.doesNotMatch(source, /\bprocess\.env\b|require\s*\(/, `${file} must stay pure`);
  }
});
