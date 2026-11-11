import assert from "node:assert/strict";
import test from "node:test";
import { auditLegalEvidence } from "@/lib/ai/legal-evidence-audit";
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
