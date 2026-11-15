import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

// Standalone implementation-level verification when the TSX / Next.js test
// runner is unavailable. Only the audit source is transpiled: no network,
// Cloudflare bindings, persistent D1, or production data are used.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync("lib/ai/legal-evidence-audit.ts", "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "legal-evidence-audit.ts",
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
});
const errors = (compiled.diagnostics ?? []).filter(x => x.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0, "Audit TypeScript isolated transpilation");
const exports = {};
runInNewContext(compiled.outputText, {
  exports,
  module: { exports },
  Object,
  Set,
  RegExp,
});
assert.equal(typeof exports.auditLegalEvidence, "function");

function summary({
  title = "신청인에 대한 강제송환 잠정금지 결정",
  core = "연방헌법재판소는 신청인에 대한 강제송환을 최장 6개월간 잠정 금지했습니다.",
  originalTitle = "Beschluss vom 15. Oktober 2026",
} = {}) {
  return {
    originalTitle,
    koreanTitle: title,
    summary: {
      coreSummary: [core],
      background: "",
      caseStructure: "",
      implications: "",
      practicalNotes: "",
      referencedProvisions: [],
    },
    entities: [],
    tags: [],
    categories: [],
    riskFlags: [],
  };
}
const sourceInput = {
  sourceKey: "de-bverfg",
  originalTitle: "Beschluss vom 15. Oktober 2026",
  cleanedText: [
    "Bundesverfassungsgericht - 2 BvR 1735/26.",
    "Die Abschiebung der Beschwerdeführerin wird bis zur Entscheidung über die Verfassungsbeschwerde, längstens für die Dauer von sechs Monaten, untersagt.",
    "Die Beschwerdeführerin ist nach ihren Angaben somalische Staatsangehörige.",
  ].join(" "),
};
const audit = (output) => exports.auditLegalEvidence(sourceInput, output);
function expectCode(result, code, severity) {
  assert(result.findings.some(f => f.code === code && f.severity === severity), code);
}

const base = audit(summary());
assert.equal(base.status, "pass");
assert.equal(base.legalAccuracyVerified, false);

const wrongNationality = audit(summary({ title: "소말리아 국적 신청인의 강제송환" }));
expectCode(wrongNationality, "applicant_nationality_attribution_review", "review");

const qualifiedNationality = audit(summary({
  core: "신청인의 진술에 따르면 소말리아 국적이며, 재판소는 강제송환을 잠정 금지했습니다.",
}));
assert(!qualifiedNationality.findings.some(f => f.code === "applicant_nationality_attribution_review"));

const wrongDirection = audit(summary({
  core: "독일 연방헌법재판소는 독일로의 송환을 최장 6개월 금지했습니다.",
}));
expectCode(wrongDirection, "unsupported_deportation_direction", "block");

const wrongTitle = audit(summary({ originalTitle: "변경된 외국어 제목" }));
expectCode(wrongTitle, "official_title_changed", "block");

const prompt = readFileSync("lib/ai/prompts.ts", "utf8");
assert(prompt.includes("originalTitle exactly"));
assert(prompt.includes("nach ihren Angaben"));
assert(prompt.includes("removal OF a person"));

console.log(JSON.stringify({
  isolatedAuditTests: 5,
  allPassed: true,
  officialTitleProtection: true,
  reportedNationalityReview: true,
  inventedDestinationBlocked: true,
  changedCodeDeployed: false,
  legalAccuracyVerified: false,
}));
