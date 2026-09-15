# WorldCons M4 국가별 역사 경계·source policy·실행 guard 증거 (2026-09-16)

작성: 2026-09-16. M4 시작 기준(base) 커밋: `bd1f597`.
범위: Gate 5 역사 백필의 연도 경계, source policy 승인, 국가별 확대 순서, 미국 candidate graph 상태를 명시적·테스트 가능한 계약으로 고정한다. M5 확대, 실제 백필 실행, 공개, AI 호출은 포함하지 않는다.

## 1. 범위와 금지 준수

- production DB에 쓰지 않았다. snapshot 생성·변경, 항목 claim, backfill run 생성, bulk historical backfill을 실행하지 않았다.
- Catalog/article 공개와 AI/Gemini 호출을 하지 않았다. `CASE_CATALOG_WRITE_ENABLED`, `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED`는 건드리지 않았다.
- 기존 migration을 수정하지 않았고 새 migration도 추가하지 않았다. 연도 경계와 source policy 승인은 application guard이므로 schema 변경이 필요 없다.
- Orca를 사용하지 않았고 coordinator SQLite DB를 수정하지 않았다.
- untracked `artifacts/`, `docs/worldcons-recovery-and-improvement-plan-20260905.md`를 건드리지 않았다.
- 구현·검증 중 push/deploy를 하지 않았다. M4 완료 변경은 검증 후 별도 로컬 커밋으로 고정하며 push/deploy는 하지 않는다.

## 2. 공통 machine-readable 계약

`lib/backfill/country-history-policy.ts` (신규):

```text
CASE_HISTORY_BOUNDARY =
  gate: 5
  historicalMaxYear: 2024
  incrementalOwnedFromYear: 2025
  rule: pre_2025_gate5_historical

COUNTRY_HISTORY_EXPANSION_ORDER:
  1 Germany  de-bverfg                  DECISION                              1998-2024  approved_private_shadow   bverfg-unattended-canary-v1     due 2027-03-03
  2 France   fr-conseil-constitutionnel QPC,DC                               2010-2024  approved_source_policy    france-dila-constit-2026-09-v1  due 2027-03-15
  3 France   fr-conseil-constitutionnel L,LP,OTHER_CONSEIL_NATURE            2010-2024  pending_owner_approval
  4 Spain    es-tribunal-constitucional SENTENCIA                            2020-2024  blocked_source_policy
  5 Spain    es-tribunal-constitucional SENTENCIA,DECLARACION                1980-2019  blocked_source_policy
  6 Spain    es-tribunal-constitucional AUTO                                 1980-2024  blocked_source_policy
  7 U.S.     us-constitution-annotated  CONSTITUTION_ANNOTATED_TABLE_CITATION 1789-2024 candidate_graph_only
```

- `assertHistoricalGateYear` / `assertHistoricalSnapshotBoundary`가 2025년 이후 연도를 `case_backfill.historical_year_out_of_gate5_boundary` / `case_backfill.incremental_year_not_historical`로 거부한다.
- `runCaseBackfillPass`가 discover와 비-discover 경로 모두에서 `repository.beginRun` 이전에 `assertHistoricalSnapshotBoundary`를 호출한다. 즉 P1 worker의 backfill handler가 run row를 만들기 전에 같은 guard를 통과한다.
- CLI `pnpm backfill:corpus plan`은 `boundary`, `expansionOrder`, 국가별 `sourcePolicyStatus`/`approvedPolicy`를 출력한다.

## 3. 국가별 실행 guard

### Germany

- 공식 공개 결정 범위 1998~2024. Gate 5 경계상 2025+는 역사 scope에서 제외한다.
- 2024 private-shadow canary는 승인됐고 `bverfg-unattended-canary-v1`(review due 2027-03-03)이 그 한 해만 승인한다.
- `germanyBverfgExpansionGuard(2024) = allowed`, 2023/2025 등은 `case_backfill.germany_expansion_not_approved` 또는 `germany_year_not_supported`. history flag가 true여도 2024 외 연도는 열리지 않는다(M5 미시작).
- `germanyBverfgApprovedPolicyDescriptor()`가 승인 policy version, review due, canary year, boundary를 노출한다.

### France

- 2010~2024, `QPC`/`DC` 우선, 기타 `NATURE`는 후속 단계(`COUNTRY_HISTORY_EXPANSION_ORDER` 2·3번).
- 2026-09-16 owner가 QPC/DC source policy를 승인했다: `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS=approved_source_policy`, `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED=true`, policy `france-dila-constit-2026-09-v1`(review due 2027-03-15, migration `20260916090000`).
- QPC/DC는 `policyAuthorized=true`지만 history flag가 없으면 `case_backfill.france_history_disabled`로 run 생성 전에 종료한다. flag를 켜도 `L`/`LP`/`OTHER_CONSEIL_NATURE`는 `case_backfill.france_history_source_policy_not_approved`로 deferred된다. env flag만으로는 승인을 우회할 수 없다.

### Spain

- 단계 순서: 2020~2024 `SENTENCIA` → 1980~2019 `SENTENCIA`+`DECLARACION` → `AUTO`.
- `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_STATUS=blocked_pending_legal_robots_review`, `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED=false`.
- 2020~2023은 history flag가 true여도 `case_backfill.spain_history_source_blocked`로 fail-closed한다.
- 2024는 Gate 1 baseline이라는 개념을 유지하지만, source policy 승인 없이는 discover가 열리지 않는다. 2024는 history flag를 요구하지 않는 대신 `policyApproved`를 요구하며, 기본값에서는 `case_backfill.spain_history_source_blocked`로 run 생성 전에 종료한다. 오늘 `plan --year=2024`는 `executionEnabled=false`다. `policyApproved`가 명시적으로 주입·기록된 경우에만 history flag 없이 2024 discover가 열린다.
- 2025+는 `spain_year_not_supported`.

### United States

- Constitution Annotated Table of Cases는 `US_CONAN_CORPUS_STATUS=candidate_graph_only`이며 검증 corpus가 아니다.
- `US_CONAN_VERIFICATION_PIPELINE`: `candidate_citation → official_scotus_identity → constitutional_essay_context → govinfo_authority → constitutional_holding → verified`.
- `assertCandidateGraphNotVerifiedCorpus`가 candidate graph를 `verified_corpus`로 취급하는 입력을 `us_conan.candidate_graph_not_verified_corpus`로 거부한다.
- 비공개 import 결과는 `corpusStatus="candidate_graph_only"`, `verifiedCorpus=false`를 명시한다.

## 4. 2025+ 증분 workflow 회귀

- Gate 5 역사 ledger는 2024년 이하만 열거나 재개한다. 2025+ 연도 snapshot은 discover/fetch/normalize/verify/reconcile 모든 phase에서 run 생성 전에 거부된다.
- `lib/ingest/run.ts`는 `country-history-policy`를 import하지 않는다. 증분 수집(`p1.collect`/`runIngest`)은 새 guard와 결합되지 않으며, `isIncrementalIngestionYear(2025|2026) = true`로 경계를 표현한다.
- 회귀 테스트 `tests/constitutional-case-history-boundary-gate5.test.ts`가 5개 phase 각각에서 2025 snapshot의 run 미생성과 ingest 모듈 비결합을 검증한다.

## 5. 변경 파일

코드·테스트:

- `lib/backfill/country-history-policy.ts` (신규)
- `lib/backfill/germany-scope.ts`, `lib/backfill/france-scope.ts`, `lib/backfill/spain-scope.ts`
- `lib/backfill/source-strategies.ts`, `lib/backfill/service.ts`
- `lib/backfill/us-constitution-annotated.ts`, `lib/backfill/us-conan-import.ts`
- `scripts/backfill-corpus.ts`
- `scripts/verify-france-conseil-inventory.ts` (read-only probe 기본 연도를 Gate 5 경계인 2024로 clamp)
- `tests/constitutional-case-backfill-germany-gate5.test.ts`, `tests/constitutional-case-backfill-france-gate5.test.ts`, `tests/constitutional-case-backfill-gate1.test.ts`, `tests/constitutional-case-backfill-us-gate5.test.ts`
- `tests/constitutional-case-history-boundary-gate5.test.ts` (신규)
- `package.json` (`test:backfill`에 신규 테스트 포함)

문서:

- `docs/worldcons-constitutional-case-backfill-design-20260903.md`
- `docs/spain-sentencia-history-gate5-runbook.md`, `docs/france-conseil-history-gate5-runbook.md`, `docs/us-constitution-annotated-gate5-runbook.md`
- `docs/germany-bverfg-source-policy-review-20260904.md`
- `docs/worldcons-m4-country-history-boundary-20260916.md` (이 문서)

## 6. 검증

실행:

```text
pnpm typecheck          통과
pnpm lint               통과
pnpm check              All checks passed.
pnpm test:backfill      99 pass / 0 fail / 1 skip (disposable PostgreSQL 부재)
pnpm test:p1            22 pass / 0 fail / 1 skip
pnpm test:ingest-workflow 18 pass / 0 fail
pnpm test:postgres:release:static 7 pass / 0 fail / 0 skip
git diff --check        공백 오류 없음
```

PostgreSQL 통합 테스트 1건은 이 환경에 disposable DB가 없어 skip이며, M1 CI release gate가 skip 0을 강제한다. 기존 migration을 수정하지 않았고 새 migration도 없다.

## 7. 실행하지 않은 것 / 남은 단계

- M5 독일 다연도 확대와 France/Spain historical 실행은 별도 승인 gate다.
- France QPC/DC source policy row는 이 M4 작업 이후인 2026-09-16 owner 승인으로 migration `20260916090000_constitutional_case_france_policy_approval.sql`에서 추가됐다. 이 M4 변경 자체는 source policy·migration·공개 flag·AI egress 변경을 포함하지 않았다.
- M4 변경은 검증 후 별도 로컬 커밋으로 고정한다. push/deploy는 하지 않는다.
