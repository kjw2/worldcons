# WorldCons M5 rollout readiness·orchestration runbook (2026-09-16)

작성: 2026-09-16. M5 시작 기준(base) 커밋: `e3337a6` (M0~M4 완료).
범위: Gate 5 역사 백필의 국가·연도·유형 rollout 선택, tranche readiness, snapshot/run 생성 전 fail-closed preflight, 증거·보고를 구현한다. 실제 역사 corpus 쓰기, 공개, AI 호출, migration 변경은 포함하지 않는다.

## 1. 범위와 금지 준수

- production DB에 쓰지 않았다. snapshot 생성·변경, 항목 claim, backfill run 생성, bulk historical backfill을 실행하지 않았다.
- Catalog/article 공개와 AI/Gemini 호출을 하지 않았다. `CASE_CATALOG_WRITE_ENABLED`, `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED`는 건드리지 않았다.
- 기존 migration을 수정하지 않았고 새 migration도 추가하지 않았다. rollout readiness/preflight는 application guard이므로 schema 변경이 필요 없다.
- Orca를 사용하지 않았고 coordinator SQLite DB를 수정하지 않았다.
- untracked `artifacts/`, `docs/worldcons-recovery-and-improvement-plan-20260905.md`를 건드리지 않았다.
- push/deploy를 하지 않았다.

## 2. M5 아키텍처

M4는 국가별 경계·정책·guard를 각 scope 모듈과 `runCaseBackfillPass`에 고정했다. M5는 그 위에 하나의 machine-readable orchestration 계층을 추가한다.

```text
Gate 5 historical scope
  ├─ M4 country/year/type guards  (country-history-policy.ts, *-scope.ts)
  └─ M5 rollout readiness          (rollout-readiness.ts)
       ├─ caseBackfillRolloutReadiness()            읽기 전용 tranche 보고서
       ├─ selectCaseBackfillRollout()               국가/연도/유형 선택 판정
       ├─ preflightCaseBackfillRollout()            선택 + 차단 사유 JSON
       └─ assertCaseBackfillRolloutPreflight()      snapshot/run 생성 전 fail-closed gate
```

핵심 원칙:

- M5는 **새 승인 경로를 만들지 않는다**. 이미 존재하는 M4 guard와 immutable source policy만 읽는다.
- 승인되지 않은 tranche는 flag를 켜도 열리지 않는다. `policyAuthorized`(정책 승인)와 `executionEnabled`(정책 + env flag)를 분리해 보고한다.
- M5는 Catalog publication rollout과 분리한다. `catalogWriteEnabled`/`publicCatalogEnabled`는 readiness 보고서의 정보 필드일 뿐, M5 preflight가 공개를 켜지 않는다.
- 2025+ 연도는 역사 ledger가 아니라 증분 수집(`p1.collect`/`runIngest`)이 소유한다. readiness와 선택 모두에서 `case_backfill.incremental_year_not_historical`로 거부한다.

## 3. tranche readiness

`lib/backfill/rollout-readiness.ts`:

- `caseBackfillRolloutReadiness()`가 `COUNTRY_HISTORY_EXPANSION_ORDER` 7개 tranche 각각에 대해 `approvedYears`, `policyAuthorized`, `executionEnabled`, `blocking`을 계산한다.
- `approvedSelections`는 정확한 (sourceKey, year, documentType) 단위로 정책이 승인한 선택만 담는다. 현재는 `de-bverfg 2024 DECISION` 1건뿐이다.
- `newlyAuthorizedSelectionCount = 0`, `m5ExpansionExecutionReady = false`, `nextApprovalRequired = France QPC/DC`.
- `geminiCalls: 0`, `publicCatalogEnabled: false`, `catalogWriteEnabled`는 env 실제값을 보고한다(기본 false).

## 4. 국가/연도/유형 rollout 선택과 fail-closed preflight

`selectCaseBackfillRollout({sourceKey, year, documentType})`는 M4 guard를 그대로 사용해 판정한다.

| selection | 결과 | errorCode |
| --- | --- | --- |
| Germany 2024 DECISION, flag on | allowed | - |
| Germany 2024 DECISION, flag off | blocked | `case_backfill.germany_history_disabled` |
| Germany 1998~2023 DECISION | blocked | `case_backfill.germany_expansion_not_approved` |
| Germany <1998 | blocked | `case_backfill.germany_year_not_supported` |
| France 2010~2024 QPC/DC | blocked | `case_backfill.france_history_source_policy_not_approved` |
| France L/LP/OTHER | blocked | `case_backfill.france_history_source_policy_not_approved` |
| France unknown type | blocked | `case_backfill.discovery_scope_not_enabled` |
| Spain 2020~2024 SENTENCIA | blocked | `case_backfill.spain_history_source_blocked` |
| Spain AUTO/DECLARACION | blocked | `case_backfill.discovery_scope_not_enabled` |
| U.S. Constitution Annotated | blocked | `us_conan.candidate_graph_not_verified_corpus` |
| any 2025+ | blocked | `case_backfill.incremental_year_not_historical` |

M5 gate는 CLI와 worker/service 두 계층에 모두 연결된다. CLI만 막고 P1 command가 다른 승인 경로로 worker handler에 도달하면 방어가 비는 문제를 막기 위한 defense-in-depth다.

1. **CLI**: `scripts/backfill-corpus.ts`의 `snapshotForDiscovery()`에서 각 source의 기존 scope assert 직후, `openSnapshot()` **이전**에 `preflightRolloutOrThrow()`를 실행하고 preflight JSON을 출력한다.
2. **CLI**: `submitPhase()`에서 snapshot을 읽은 직후 `assertCaseBackfillRolloutPreflight()`를 실행해 run/command 생성 전에 막는다.
3. **Service/worker**: `lib/backfill/service.ts`의 `runCaseBackfillPass()`가 `assertRolloutAuthorized()`로 discover와 non-discover **양쪽** 경로 모두에서 `repository.beginRun()` 이전에 M5 gate를 다시 실행한다. non-discover 경로는 기존 M4 코드가 국가 정책을 재검사하지 않던 지점이므로 이것이 실질적인 worker-level 방어다.

`assertRolloutAuthorized()`는 `dependencies.environment`, `dependencies.now().getUTCFullYear()`, `dependencies.franceHistorySourcePolicyApproved`, `dependencies.spainHistorySourcePolicyApproved`를 그대로 사용한다. 즉 테스트 주입과 실제 운영 policy가 같은 계약을 통과한다.

기존 M4 `assertDiscoveryScope`와 `assertHistoricalSnapshotBoundary`는 그대로 유지된다. worker 계층에서 snapshot status와 M4 boundary가 먼저, 기존 phase 오류(`catalog_write_disabled`, `source_request_governor_not_supported`)가 그다음, M5 rollout gate가 `beginRun` 직전에 온다. 기존 오류 우선순위와 P1 worker 계약을 가능한 한 바꾸지 않는다.

## 5. 증거·보고 CLI

```bash
# 전체 tranche readiness (DB/네트워크/AI 없음, read-only)
pnpm rollout:readiness

# 단일 선택의 preflight (blocked여도 exit 0, JSON으로 사유 보고)
pnpm rollout:readiness --source=france --year=2024 --document-type=QPC

# 승인되지 않은 선택을 exit 2로 fail-closed 증명
pnpm rollout:readiness --source=france --year=2024 --document-type=QPC --require-authorized
```

`backfill:corpus plan`도 각 source의 `rolloutSelection`을 additive로 포함하므로 기존 plan 소비자는 영향을 받지 않는다.

## 6. 현재 승인 상태와 정확한 승인 blocker

**새로 승인된 tranche는 없다.** M5 실행은 여전히 차단되어 있다.

```text
approvedSelectionCount         = 1   (Germany 2024 DECISION, 기존 canary)
newlyAuthorizedSelectionCount  = 0
m5ExpansionExecutionReady      = false
nextApprovalRequired           = France QPC/DC (order 2)
```

국가별 blocker:

- **Germany 1998~2023**: `germany_expansion_not_approved`. 기존 `bverfg-unattended-canary-v1`(review due 2027-03-03)은 2024 한 해만 승인한다. 새 연도는 새 owner-approved policy version이 필요하다.
- **France QPC/DC(2010~2024)**: `owner_source_policy_not_approved`. `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED=false`이며, owner가 [france-constit-source-policy-review-20260903.md](./france-constit-source-policy-review-20260903.md)를 승인하고 named reviewer·retention·`review_due_at`·DILA/Conseil identity-set 계약·AI egress 거부를 포함한 immutable `source_corpus_policies` row를 만든 뒤에만 guard가 열린다. env flag만으로는 절대 열리지 않는다.
- **France L/LP/OTHER**: 위 승인 + QPC/DC 이후 순서(`deferred_after_qpc_dc`).
- **Spain SENTENCIA(2020~2024)**: `spain_hj_legal_robots_policy_blocked`. `robots.txt` 404, 법적 고지 403에 대한 법률·robots 검토와 명시적 policy 승인 전에는 2024 baseline조차 fail-closed다.
- **Spain 1980~2019 SENTENCIA/DECLARACION, AUTO**: 위 승인 + 단계 순서(`deferred_after_*`).
- **U.S. Constitution Annotated**: `us_conan.candidate_graph_not_verified_corpus`. Table of Cases는 검증 corpus가 아니며, 전체 검증 pipeline과 별도 `us-scotus` authority policy가 필요하다. rollout tranche가 아니다.

승인 없이 다음을 해서는 안 된다.

- `*-scope.ts`의 `*_SOURCE_POLICY_APPROVED` 상수를 true로 바꾸기
- owner review 없는 `source_corpus_policies` row 생성
- M5 preflight를 우회하거나 snapshot/run을 직접 생성

## 7. 새 tranche 승인 절차 (M5 이후)

1. 해당 국가 source policy review 문서를 owner가 검토·승인하고 named reviewer/retention/review deadline을 확정한다.
2. immutable `source_corpus_policies` row를 만든다.
3. scope guard가 상수가 아니라 승인된 policy row를 읽도록 변경한다(별도 코드 변경 + migration 없음).
4. `pnpm rollout:readiness --source=... --year=... --document-type=... --require-authorized`가 exit 0이 되는지 확인한다.
5. 그 뒤에만 `backfill:corpus discover`로 한 tranche씩 진행한다. Catalog 공개는 별도 단계다.

## 8. 검증

```text
pnpm typecheck                          통과
pnpm lint                               통과
pnpm check                              All checks passed.
pnpm test:backfill                      114 pass / 0 fail / 1 skip (disposable PostgreSQL 부재)
pnpm test:p1                            22 pass / 0 fail / 1 skip
pnpm test:ingest-workflow               18 pass / 0 fail
pnpm test:postgres:release:static       7 pass / 0 fail / 0 skip
git diff --check                        공백 오류 없음
pnpm rollout:readiness                  newlyAuthorizedSelectionCount=0, m5ExpansionExecutionReady=false
pnpm rollout:readiness --source=france --year=2024 --document-type=QPC --require-authorized  exit 2
```

service defense 회귀 테스트(`constitutional-case-rollout-readiness-gate5.test.ts`)는 직접 `runCaseBackfillPass`를 호출해 다음을 증명한다.

- non-discover 및 discover 양쪽에서 Germany 2023(flag on), France 2024 QPC(owner 미승인), Spain 2024(source policy 미승인), 2025+는 `beginRun` 호출 전에 거부된다.
- Germany 2024는 기존 policy + history flag 조건이 성립할 때만 fetch가 진행된다.
- `lib/backfill/service.ts`가 discover/non-discover 두 경로 모두에서 `beginRun` 이전에 gate를 호출한다.

PostgreSQL 통합 테스트 1건은 이 환경에 disposable DB가 없어 skip이며, M1 CI release gate가 skip 0을 강제한다. 기존 migration을 수정하지 않았고 새 migration도 없다.

## 9. Catalog publication rollout과의 분리

M5는 역사 corpus ledger의 orchestration만 다룬다. `/articles` 노출, Catalog publication, 통합 검색, MCP 플러그인은 기존 Gate 2~4 precedence와 별도 canary 승인을 따른다. M5 readiness의 `publicCatalogEnabled`/`catalogWriteEnabled`는 상태 보고일 뿐이며, M5 구현·검증은 두 flag를 켜지 않았다.

## 10. 변경 파일

코드·테스트:

- `lib/backfill/rollout-readiness.ts` (신규)
- `lib/backfill/service.ts` (discover/non-discover 양쪽 `beginRun` 이전 worker-level rollout gate)
- `scripts/backfill-corpus.ts` (rollout preflight + plan rolloutSelection)
- `scripts/rollout-readiness.ts` (신규, read-only 증거 CLI)
- `tests/constitutional-case-rollout-readiness-gate5.test.ts` (신규)
- `tests/constitutional-case-backfill-gate1.test.ts` (Spain non-discover 테스트에 `spainHistorySourcePolicyApproved: true` 주입)
- `package.json` (`rollout:readiness` script, `test:backfill`에 신규 테스트 포함)

문서:

- `docs/worldcons-m5-rollout-readiness-runbook.md` (이 문서)
- `docs/worldcons-constitutional-case-backfill-design-20260903.md` (M5 섹션 추가)
