# WorldCons P4 — Legal QA / Rollback Readiness

Date: 2026-11-11 (KST). Local feature branch: feat/worldcons-ai-gateway-p3.

## Actual production state (Cloudflare management read-only)

- The deployed worldcons Worker returned 60 bindings and **no native AI binding** or backend flags WORLDCONS_SUMMARY_BACKEND / G1–G4. The deployed worldcons-ingest Worker likewise had no native AI binding.
- The feature branch's wrangler.jsonc DOES include an AI binding and four default direct-gemini flags. **This branch has not been deployed**. Production cannot be switched to Gateway by only changing a flag until an authorized Worker deployment includes the AI binding.
- The deployed default/dynamic/gemini-flash-fallback route is still the four Gemini model fallback chain with BYOK-only and authentication enabled. Do not change the route to roll back a Worker.

## Stored original-text versus existing Korean summary review

The table compares actual judicial source text stored in the WorldCons Core D1 against the stored summary, using read-only SQL. No court's official website was independently re-fetched in this pass, and no human legal reviewer has signed off. The findings are narrow documented issues, not an exhaustive legal accuracy assessment.

| Court / Core article ID | Anchored original-text finding | Stored-summary risk and review status |
| --- | --- | --- |
| Germany, BVerfG 2 BvR 1735/26; afbbb6ef-ad3d-4494-bbf3-563e705efce1 | “Die Abschiebung der Beschwerdeführerin wird ... untersagt” prohibits the applicant's deportation pending the constitutional appeal, at most six months | **BLOCK** unsupported_deportation_direction: “독일로의 송환” incorrectly suggests deportation **to Germany**. Correct: “신청인에 대한 강제송환을 헌법소원 결정 전까지 최장 6개월간 금지” |
| Spain, Tribunal Constitucional AUTO 48/2026; 864accea-90da-4397-a158-ab4397da7a9c | Party's cited “art. 219.1 e) LOPJ” is identified by the court as [sic], with restrictive statutory rules for judicial recusal | **REVIEW** party_citation_marked_sic: high-confidence reference art. 219.1 must not be treated as valid adopted judicial reasoning without explaining the mistaken party citation |
| France, Conseil constitutionnel 2026-1230/1231 QPC; f252de7d-53be-4137-ad80-ea4500d1de02 | “date de la publication de la présente décision”; effects apply to cases not yet finally decided | **REVIEW** judgment_effective_date_ambiguous: prior “공포일부터 폐지” is unclear. Correct: “이 결정이 공표된 날부터 위헌 선언의 효력이 발생하며 그때까지 확정되지 않은 사건에 적용” |
| US, Supreme Court Mullin v. Friends of the Ruidosa Church; 20353a3d-af47-44de-baa3-98d8fca1bdde | Respondents cited Constitution Article I Section 1 in a major-questions statutory claim. The Court granted a stay and found the statutory claim did not automatically become a constitutional claim | **REVIEW** private case has NO stored summary to compare. A P3 generated summary's Article I reference must be marked as respondents' argument, not automatically a holding |

The official-source URLs and article hashes are retained in tests/fixtures/ai-gateway-p3-20261111.json. No production Core D1 rows or summaries were changed.

The staging-only legal audit now catches the first three issues with reason codes and tests. A PASS is NOT a human legal accuracy certification and does NOT approve publication or private-hold release. Any existing public summary corrections must use the ordinary versioned review/publication workflow.

## Configuration rollback rehearsal

Completed locally: tests/ai-gateway-p4-rollback.test.ts simulates explicit G1 → G2 → G3 → G4 activation and reverse G4 → G3 → G2 → G1 direct-Gemini rollback at all intermediate steps. Missing AI binding rejects gateway use. The current source configuration defaults to direct-gemini for all paths. This is configuration-level rehearsal, **not** live production rollback.

Important G3 queued-work hazard: an admin retry queued while Gateway is enabled retains its gateway provider marker. After rollback to direct, the Worker deliberately rejects that stale request instead of silently switching upstream models. During actual rollback, stop G3 ingestion, drain or cancel pending Gateway jobs, inspect the Ops queue, then explicitly requeue under direct Gemini if appropriate; no silent migration of queued jobs.

## Operational P4 deployment gates / rollback sequence

1. Capture the exact current deployed Worker version/settings (without secrets), authorized operator, all other service bindings, and Gateway route version.
2. Get documented legal signoff on the four actual court originals and translations: source provisions, holding versus party allegations, dates, authority, and safe publication. **Not yet met.**
3. Deploy the feature code with AI binding but **all G1–G4 still direct-gemini**. Confirm normal WorldCons and direct-Gemini behavior immediately. If that fails, restore the captured prior Worker deployment before any lane switches.
4. Recheck Gateway BYOK-only, authentication, four-node order, response model and payload-log suppression; do not edit the Gateway route.
5. Enable G1, G2, G3, then G4 one at a time after approval. For each obtain an actual authorized workflow receipt, summary validation and provenance, error/latency and byok logs, and no unintended publication/Search or human approval. Never automatically release G4 private review holds.
6. On a failure, explicitly restore the affected lane's direct-gemini backend; drain/cancel/requeue G3 pending jobs as necessary; verify resumed direct operation. If flag restoration is inadequate, restore the previous Worker deployment version. Prove D1 consistency and pending-queue safety.
7. Close P4 only with four real production receipts, legal approvals, and a verified production rollback drill. No automatic background cutover is authorized.

**P4 verdict: NO-GO.** Isolated remote D1/R2 integration passed, but production AI binding has not been deployed and legal-quality issues remain.
