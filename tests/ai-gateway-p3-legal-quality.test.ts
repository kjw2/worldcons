import assert from "node:assert/strict";
import test from "node:test";
import { auditLegalEvidence } from "@/lib/ai/legal-evidence-audit";
import { SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import type { SummaryJson } from "@/lib/db/types";

function sample(overrides: Partial<SummaryJson> = {}): SummaryJson {
  const output: SummaryJson = {
    koreanTitle: "법원의 헌법소원 잠정조치 결정",
    originalTitle: "Beschluss vom 15. Oktober 2026",
    summary: {
      coreSummary: ["재판소는 망명 신청인에 대한 송환을 잠정 금지했습니다."],
      background: "신청인이 긴급 구제를 청구했습니다.",
      caseStructure: "잠정처분 심리",
      implications: "회복하기 어려운 불이익을 방지합니다.",
      practicalNotes: "공식 원문을 확인해야 합니다.",
      referencedProvisions: [],
    },
    entities: [], tags: [], categories: [], riskFlags: [],
  };
  return {...output, ...overrides};
}

const german = {
  sourceKey: "de-bverfg",
  originalTitle: "Beschluss vom 15. Oktober 2026",
  cleanedText: "Bundesverfassungsgericht. Die Beschwerdeführerin stellte einen Asylantrag. "
    + "Die Abschiebung wird bis zur Entscheidung über die Verfassungsbeschwerde untersagt. "
    + "Die Entscheidung betrifft Art. 19 Abs. 4 GG und das Verfahren am Flughafen.",
};

test("P3 flags unsupported child/asylum content even when the JSON schema is valid", () => {
  const output=sample({summary:{...sample().summary,coreSummary:["법원은 신속 아동/망명 절차 위반을 심사했습니다."]}});
  const result=auditLegalEvidence(german,output);
  assert.equal(result.status,"block");
  assert.deepEqual(result.findings,[{code:"unsubstantiated_child_claim",severity:"block"}]);
  assert.equal(result.legalAccuracyVerified,false);
  assert.equal(JSON.stringify(result).includes("아동/망명"),false);
});

test("P3 avoids a false positive when the original expressly mentions children", () => {
  const output=sample({summary:{...sample().summary,coreSummary:["미성년 아동과 가족의 절차를 검토했습니다."]}});
  const result=auditLegalEvidence({...german,cleanedText:german.cleanedText+" Minderjährige Kinder und ihre Familien."},output);
  assert.equal(result.status,"pass");
  assert.equal(result.legalAccuracyVerified,false);
});

test("P3 catches observed German Asyl and Senat mistranslations missed by structural validation", () => {
  const source={...german,cleanedText:german.cleanedText+" 3. Kammer des Zweiten Senats. Asylantrag."};
  const bad=sample({
    koreanTitle:"제2센트의 아스일 신청 사건",
    summary:{...sample().summary,coreSummary:["제2센트는 아스일 신청인의 추방을 금지했습니다."]},
  });
  const result=auditLegalEvidence(source,bad);
  assert.equal(result.status,"block");
  assert.deepEqual(result.findings.map(f=>f.code),["unreliable_legal_terminology"]);
  const corrected=auditLegalEvidence(source,sample({
    koreanTitle:"독일 연방헌법재판소 제2부 망명 신청 사건",
    summary:{...sample().summary,coreSummary:["제2부 재판부는 난민 신청인의 추방을 금지했습니다."]},
  }));
  assert.equal(corrected.status,"pass");
});

test("P3 blocks drift in official French title and fabricated case identifiers", () => {
  const originalTitle="Décision n° 2026-1230/1231 QPC du 23 octobre 2026";
  const source={sourceKey:"fr-conseil-constitutionnel",originalTitle,cleanedText:originalTitle+" Non conformité totale."};
  const bad=auditLegalEvidence(source,sample({originalTitle:"Décision 2026-1230 QPC",koreanTitle:"2026-9999 QPC 헌법위원회 결정"}));
  assert.equal(bad.status,"block");
  assert.deepEqual(bad.findings.map(f=>f.code),["official_title_changed","case_number_not_in_source"]);
  const good=auditLegalEvidence(source,sample({originalTitle,koreanTitle:"프랑스 헌법위원회 2026-1230/1231 QPC 위헌 결정"}));
  assert.equal(good.status,"pass");
});

test("P3 flags US party-argument attribution as review, not as automatic fabrication", () => {
  const source={
    sourceKey:"us-scotus",
    originalTitle:"Mullin v. Friends of the Ruidosa Church",
    cleanedText:"Respondents claimed the waivers violated the major questions doctrine under the U. S. Constitution, Article I, Section 1. The Court granted a stay.",
  };
  const output=sample({
    originalTitle:source.originalTitle,
    summary:{
      ...sample().summary, coreSummary:["미국 연방대법원은 하급심의 금지명령을 정지했습니다."],
      referencedProvisions:[{jurisdiction:"US",lawName:"U.S. Constitution",article:"Article I, Section 1",description:"당사자 주장의 근거",confidence:"high"}],
    },
  });
  const result=auditLegalEvidence(source,output);
  assert.equal(result.status,"review");
  assert.deepEqual(result.findings.map(f=>f.code),["party_claim_attribution_review"]);
  assert.equal(result.legalAccuracyVerified,false);
});

test("P3 flags absent long statute numbers for human review", () => {
  const output=sample({
    summary:{...sample().summary,referencedProvisions:[{
      jurisdiction:"DE",lawName:"BVerfGG",article:"§ 99999",description:"요약상 조문",confidence:"high",
    }]},
  });
  const result=auditLegalEvidence(german,output);
  assert.equal(result.status,"review");
  assert.deepEqual(result.findings.map(f=>f.code),["reference_number_not_in_source"]);
});

test("P4 source audit catches wrong direction of German deportation", () => {
  const original = {
    sourceKey: "de-bverfg",
    originalTitle: "Beschluss vom 15. Oktober 2026",
    cleanedText: "Die Abschiebung der Beschwerdeführerin wird bis zur Entscheidung über die Verfassungsbeschwerde, längstens für die Dauer von sechs Monaten, untersagt.",
  };
  const bad = sample({ summary: {
    ...sample().summary,
    coreSummary: ["독일 연방헌재는 신청인에 대한 독일로의 송환을 6개월간 금지했습니다."],
  } });
  const review = auditLegalEvidence(original, bad);
  assert.equal(review.status, "block");
  assert.deepEqual(review.findings.map(x => x.code), ["unsupported_deportation_direction"]);
  const corrected = auditLegalEvidence(original, sample({ summary: {
    ...sample().summary,
    coreSummary: ["신청인에 대한 강제송환을 본안 결정 전까지 최장 6개월 금지했습니다."],
  } }));
  assert.equal(corrected.status, "pass");
  assert.equal(corrected.legalAccuracyVerified, false);
});

test("P4 French effect starts on DECISION publication, never vague law promulgation", () => {
  const source = {
    sourceKey: "fr-conseil-constitutionnel",
    originalTitle: "Décision n° 2026-1230/1231 QPC du 23 octobre 2026",
    cleanedText: "Celle-ci intervient donc à compter de la date de la publication de la présente décision. Elle est applicable à toutes les affaires non jugées définitivement à cette date.",
  };
  const baseline = sample({ originalTitle: source.originalTitle,
    summary: { ...sample().summary, coreSummary: ["이번 위헌 결정으로 해당 조항은 공포일부터 폐지되며 확정되지 않은 사건에 적용됩니다."] },
  });
  const review = auditLegalEvidence(source,baseline);
  assert.equal(review.status, "review");
  assert.deepEqual(review.findings.map(x=>x.code), ["judgment_effective_date_ambiguous"]);
  const clearer = auditLegalEvidence(source,sample({ originalTitle: source.originalTitle,
    summary: { ...sample().summary, coreSummary: ["위헌 결정의 효력은 이 결정이 공표된 날부터 발생하며 아직 확정되지 않은 사건에 적용됩니다."] },
  }));
  assert.equal(clearer.status, "pass");
});

test("P4 Spanish party-cited art 219.1 marked sic cannot be treated uncritically", () => {
  const source = {
    sourceKey: "es-tribunal-constitucional",
    originalTitle: "AUTO 48/2026, 2026-07-21",
    cleanedText: "El recusante cita el art. 219.1 e) LOPJ [sic, la causa primera prevista en el art. 219 LOPJ es el vínculo matrimonial] y alega parcialidad.",
  };
  const output = sample({ originalTitle: source.originalTitle, summary: {
    ...sample().summary,
    referencedProvisions: [{jurisdiction:"ES",lawName:"LOPJ",article:"art. 219.1",description:"친족관계 제척",confidence:"high"}],
  } });
  const result=auditLegalEvidence(source,output);
  assert.equal(result.status,"review");
  assert.deepEqual(result.findings.map(x=>x.code),["party_citation_marked_sic"]);
  const htmlWhitespaceSource={...source,cleanedText:source.cleanedText.replace("[sic,","[ sic ,")};
  assert.deepEqual(auditLegalEvidence(htmlWhitespaceSource,output).findings.map(x=>x.code),["party_citation_marked_sic"]);
});

test("P4 flags the French social-security finance statute's observed stray digit", () => {
  const source={
    sourceKey:"fr-conseil-constitutionnel",
    originalTitle:"Décision n° 2026-1230/1231 QPC du 23 octobre 2026",
    cleanedText:"Loi n° 2025-1403 du 30 décembre 2025 de financement de la sécurité sociale pour 2026.",
  };
  const wrong=sample({originalTitle:source.originalTitle,
    summary:{...sample().summary,coreSummary:["프랑스 헌법위원회는 2026년 사회보장재정1법 조항을 위헌으로 판단했습니다."]}});
  assert.deepEqual(auditLegalEvidence(source,wrong).findings.map(x=>x.code),["garbled_french_social_security_law_name"]);
  const corrected=sample({originalTitle:source.originalTitle,
    summary:{...sample().summary,coreSummary:["프랑스 헌법위원회는 2026년도 사회보장재정법 조항을 위헌으로 판단했습니다."]}});
  assert.equal(auditLegalEvidence(source,corrected).status,"pass");
});

test("P4 live summary prompt cautions against all three observed baseline legal errors", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /removal OF a person from removal TO a destination/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /publication OF THE DECISION/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /citation as "\[sic\]"/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /사회보장재정법/);
});
