# WorldCons P4 — Official-source comparison and proposed Korean corrections

Date: 2026-11-14 KST. Branch: feat/worldcons-ai-gateway-p3.

## Evidence and scope

The four court URLs below were retrieved directly using read-only HTTP GET. All returned 200. Their case identifiers and selected dispositive passages matched the WorldCons Core D1 excerpts inspected earlier. The newly fetched US Supreme Court PDF had exactly 64,875 bytes and SHA-256 c8dcdbba8c419cded45bd9e042b8b53ab8c7b3002a3345633700994c10e7327b, matching the production WorldCons source metadata.

Reproducible verification: node scripts/verify-p4-official-sources.mjs. Result 4/4 PASS on 2026-11-14. This script fetches public court documents only, performs no D1/R2/Worker mutations and returns result codes, not raw texts.

These checks establish document identity and particular holding anchors, NOT a fully certified bilingual legal summary. Independent legal review is still required before changing public content.

## German decision — 2 BvR 1735/26, 2026-10-15

Official: https://www.bverfg.de/e/rk20261015_2bvr173526

The operative order prohibits deportation OF the applicant until the constitutional complaint is decided, for at most six months. It does not identify Germany as the destination of removal. The source describes the applicant as being of Somali nationality according to her account; do not infer independent judicial confirmation.

- Existing error: "독일로의 송환을 ... 금지" misidentifies the destination.
- Proposed corrected first core point: "독일 연방헌법재판소 제2부 제3재판부는 신청인에 대한 강제송환을 헌법소원에 대한 결정이 나올 때까지, 최장 6개월간 금지하는 잠정처분을 명했다."
- Classification: BLOCK — unsupported_deportation_direction.

## Spanish decision — AUTO 48/2026, 2026-07-21

Official: https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32133

The Plenary of the Constitutional Court did not admit the recusal application against judge José María Macías Castaño. The litigant's citation "art. 219.1 e) LOPJ" is marked sic by the court due to the incorrect description. The Court separately explains statutory recusal grounds are exhaustive and restrictively interpreted. A litigant's complaint against a judge does not automatically qualify.

- Existing risk: art. 219.1 appears as an unqualified high-confidence referenced provision.
- Proposed correction: identify it as a mistaken party citation, not a provision independently adopted by the court. Explain separately the actually applicable LOPJ grounds.
- Classification: REVIEW — party_citation_marked_sic.
- The existing Korean disposition "기피신청 각하" correctly reflects the official order.

## French decision — 2026-1230/1231 QPC, 2026-10-23

Official: https://www.conseil-constitutionnel.fr/decision/2026/20261230_1231QPC.htm

The Conseil constitutionnel held unconstitutional the second sentence of the second paragraph of paragraph I of Article 13 of law no. 2025-1403, the social-security financing law for 2026 dated 30 December 2025. Under paragraph 16, the declaration takes effect when THIS constitutional decision is published and applies to cases not finally resolved then. The Council did not postpone the effects.

- Existing corruption: "2026년 사회보장재정1법"; existing ambiguity: "공포일부터".
- Proposed corrected first core point: "프랑스 헌법위원회는 2026년도 사회보장재정법(2025년 12월 30일 법률 제2025-1403호) 제13조 I항 제2단락 제2문에 따른 보충 건강보험료 동결 규정을 위헌으로 결정했다."
- Proposed corrected effects point: "위헌 선언의 효력은 이 헌법위원회 결정이 공표된 날부터 발생하며, 그날까지 확정되지 않은 사건에도 적용된다."
- Classifications: REVIEW — judgment_effective_date_ambiguous and garbled_french_social_security_law_name.

## United States — Mullin v. Friends of the Ruidosa Church, 26A560, 2026-11-09

Official PDF: https://www.supremecourt.gov/opinions/26pdf/26a560_onkq.pdf

The official PDF is 64,875 bytes, header PDF-1.6, and its SHA-256 matches WorldCons original PDF metadata. Respondents invoked Article I, Section 1 in their claim. The Court granted a stay of the district court injunction for the specified certiorari process. It did not treat the major-questions statutory argument as an independently sufficient constitutional claim. Justice Jackson would deny the application.

- Proposed PRIVATE review note: "연방대법원은 국경 장벽 건설 관련 지방법원 금지명령의 효력을 정지했다. 상대방 측의 헌법 제1조 제1항 주장을 법원의 독립적인 헌법 위반 판단으로 오인해서는 안 되며, 다수의견은 중요문제 원칙에 기초한 법률적 주장을 곧바로 헌법적 주장으로 볼 수 없다고 보았다. 잭슨 대법관은 정지 신청 기각 입장을 밝혔다."
- No existing public Korean summary is stored. Maintain publishable=false and review.required=true. This is not an instruction to publish.

## Staging changes and release gate

The staging audit now accepts HTML whitespace around Spanish [sic] and flags the observed stray digit in the French statute name. The summary prompt specifies the proper translation of the social-security financing law. All these changes remain local until explicitly deployed; they do not correct existing public entries.

**Official court source anchors: 4/4 PASS. US official PDF SHA-256: PASS. Full legal accuracy / independent approval: OPEN.**

Updated: G1-only candidate Worker version 116 (ac4d2176-b462-43d7-89d2-b06bd9978ba5) has been uploaded INACTIVE, superseding the earlier candidate 115 for future evaluation. Worker 114 (88665194-9712-4246-93c0-1233a09fbf52) continues to serve 100% of production traffic with all summary lanes on direct Gemini. No content publication, D1 edits or G1 Gateway production switch were authorized by these source checks.
