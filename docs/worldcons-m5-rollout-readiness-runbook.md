# WorldCons M5 rollout readiness·orchestration runbook (2026-09-16)

> **Canonical backfill operating principle:** historical corpus acquisition and Gemini/publication are independent pipelines. Inventory/fetch/normalize/verify/reconcile must continue independently of Gemini quota; AI enrichment and public release may trail as a separately measured backlog. See `docs/worldcons-historical-backfill-operating-principles-20260916.md`. In this runbook, `production-complete` for a historical tranche means corpus acquisition/verification complete unless public completion is explicitly stated.

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
- `approvedSelections`는 정확한 (sourceKey, year, documentType) 단위로 정책이 승인한 선택만 담는다. Germany 2023·2024 DECISION 2건과 France 2010~2024 QPC/DC 30건이다.
- `newlyAuthorizedSelectionCount = 31`, `approvedSelectionCount = 32`, `nextApprovalRequired = France L/LP/OTHER`(order 3).
- France QPC/DC는 `policyAuthorized=true`이지만 `CASE_CATALOG_FRANCE_HISTORY_ENABLED`가 꺼져 있으면 `executionEnabled=false`다. `m5ExpansionExecutionReady`는 **기록된 정책 승인과 실행 준비를 분리**한다: 새로 승인된 non-baseline tranche가 실제로 `executionEnabled=true`일 때만 true다. Germany 2024 baseline은 새로 승인된 tranche가 아니지만, 2026-09-16 owner 승인으로 추가된 Germany 2023 successor는 non-baseline이므로 Germany flag가 켜지면 `executionEnabled=true`가 되어 `m5ExpansionExecutionReady=true`가 된다. France flag를 켠 테스트에서도 France QPC/DC가 `executionEnabled=true`가 되고 `m5ExpansionExecutionReady=true`가 된다.
- `geminiCalls: 0`, `publicCatalogEnabled: false`, `catalogWriteEnabled`는 env 실제값을 보고한다(기본 false).

## 4. 국가/연도/유형 rollout 선택과 fail-closed preflight

`selectCaseBackfillRollout({sourceKey, year, documentType})`는 M4 guard를 그대로 사용해 판정한다.

| selection | 결과 | errorCode |
| --- | --- | --- |
| Germany 2024 DECISION, flag on | allowed | - |
| Germany 2024 DECISION, flag off | blocked | `case_backfill.germany_history_disabled` |
| Germany 1998~2022 DECISION | blocked | `case_backfill.germany_expansion_not_approved` |
| Germany 2023 DECISION, flag on | allowed | - (owner-approved successor `bverfg-unattended-canary-v2`) |
| Germany <1998 | blocked | `case_backfill.germany_year_not_supported` |
| France 2010~2024 QPC/DC, flag off | blocked | `case_backfill.france_history_disabled` |
| France 2010~2024 QPC/DC, flag on | allowed | - |
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

**2026-09-16 France 2010~2024 QPC/DC tranche가 owner 승인됐고, production policy 적용, 2024 QPC/DC private-shadow canary, Crawlee listener/RequestQueue hardening(M5-B2.1), 2023 QPC/DC expansion wave(M5-B3.1)까지 완료됐다.** 기본 환경에서는 `CASE_CATALOG_FRANCE_HISTORY_ENABLED`가 계속 꺼져 있어 후속 historical 실행은 fail-closed다. 실행 flag는 각 bounded CLI 프로세스에서만 켰으며 종료 후 readiness가 다시 `france_history_disabled`를 반환하는 것을 확인했다.

```text
approvedSelectionCount         = 32  (Germany 2023·2024 DECISION 2 + France QPC/DC 2010~2024 30)
newlyAuthorizedSelectionCount  = 31  (Germany 2023 successor + France QPC/DC, L/LP/OTHER 아님)
m5ExpansionExecutionReady      = false  (flag off: 신규 non-baseline tranche가 executionEnabled 아님)
nextApprovalRequired           = France L/LP/OTHER (order 3)
```

2026-09-16 owner 지시로 Germany 2023이 additive successor `bverfg-unattended-canary-v2`(migration `20260916110000`, supersedes `bverfg-unattended-canary-v1`, review due 2027-03-15)로 승인됐다. 2024 baseline은 계속 v1 row에 bind되어 immutable하며, 2022 이하는 여전히 `germany_expansion_not_approved`다.

`CASE_CATALOG_FRANCE_HISTORY_ENABLED=true`인 테스트에서는 France QPC/DC가 `executionEnabled=true`가 되어 `m5ExpansionExecutionReady=true`가 되고, `L`/`LP`/`OTHER_CONSEIL_NATURE`는 여전히 차단된다. 즉 정책 승인 기록과 실제 M5 확대 실행 준비는 분리된다.

국가별 blocker:

- **Germany 1998~2022**: `germany_expansion_not_approved`. 기존 `bverfg-unattended-canary-v1`(review due 2027-03-03)은 2024 한 해를, successor `bverfg-unattended-canary-v2`(review due 2027-03-15)는 2023 한 해를 추가 승인한다. 2022 이하는 새 owner-approved policy version이 필요하다.
- **France QPC/DC(2010~2024)**: 승인됨. `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS=approved_source_policy`, `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED=true`, 현재 successor immutable row `fr-conseil-constitutionnel` / `france-dila-constit-2026-09-v2`(review due 2027-03-15, migration `20260916100000`). v1 row `france-dila-constit-2026-09-v1`(migration `20260916090000`)은 immutable하며 closed 2024/2023 snapshot을 계속 bind한다. v2는 owner가 승인한 E1/E2 exact tuple만 추가하고 year/type scope는 넓히지 않는다. history flag off이면 `case_backfill.france_history_disabled`로 fail-closed다. env flag만으로는 열리지 않으며, 코드에 기록된 승인 metadata와 정확한 flag가 모두 필요하다. **v2 migration은 아직 production에 적용되지 않았고, 2022 production backfill/snapshot은 실행되지 않았다.**
- **France L/LP/OTHER**: `owner_source_policy_not_approved` + `deferred_after_qpc_dc`. 위 QPC/DC 승인에 포함되지 않으며 새 policy version이 필요하다.
- **Spain SENTENCIA(2020~2024)**: `spain_hj_legal_robots_policy_blocked`. `robots.txt` 404, 법적 고지 403에 대한 법률·robots 검토와 명시적 policy 승인 전에는 2024 baseline조차 fail-closed다.
- **Spain 1980~2019 SENTENCIA/DECLARACION, AUTO**: 위 승인 + 단계 순서(`deferred_after_*`).
- **U.S. Constitution Annotated**: `us_conan.candidate_graph_not_verified_corpus`. Table of Cases는 검증 corpus가 아니며, 전체 검증 pipeline과 별도 `us-scotus` authority policy가 필요하다. rollout tranche가 아니다.

승인 없이 다음을 해서는 안 된다.

- owner 승인 없는 `source_corpus_policies` row 생성 또는 `*-scope.ts` 승인 metadata 임의 변경
- 승인된 immutable policy version과 다른 값으로 guard/readiness를 넓히기
- M5 preflight를 우회하거나 snapshot/run을 직접 생성

## 7. 새 tranche 승인 절차 (M5 이후)

1. 해당 국가 source policy review 문서를 owner가 검토·승인하고 named reviewer/retention/review deadline을 확정한다.
2. immutable `source_corpus_policies` row를 삽입하는 새 timestamp migration을 추가한다(Germany `20260903188000`, France `20260916090000`/v2 successor `20260916100000` 패턴: conflict-detecting, 재실행 멱등). successor는 `supersedes_policy_version`으로 lineage만 기록하고 이전 row를 수정·삭제하지 않는다.
3. scope module의 승인 metadata(policy version, review due, approved 범위)를 그 immutable row와 일치하도록 갱신한다. env flag는 계속 별도로 요구한다.
4. `pnpm rollout:readiness --source=... --year=... --document-type=... --require-authorized`가 승인 후 flag를 켰을 때만 exit 0이 되는지 확인한다.
5. 그 뒤에만 `backfill:corpus discover`로 한 tranche씩 진행한다. Catalog 공개는 별도 단계다.

## 8. 검증

```text
pnpm typecheck                          통과
pnpm lint                               통과
pnpm check                              All checks passed.
pnpm test:backfill                      142 pass / 0 fail / 1 skip (disposable PostgreSQL 부재)
pnpm test:p1                            22 pass / 0 fail / 1 skip
pnpm test:ingest-workflow               18 pass / 0 fail
pnpm test:postgres:release:static       7 pass / 0 fail / 0 skip
git diff --check                        공백 오류 없음
pnpm rollout:readiness                  Germany 2023·2024 + France QPC/DC policyAuthorized=true executionEnabled=false, newlyAuthorizedSelectionCount=31, m5ExpansionExecutionReady=false
pnpm rollout:readiness --source=france --year=2024 --document-type=QPC --require-authorized  exit 2 (france_history_disabled)
```

service defense 회귀 테스트(`constitutional-case-rollout-readiness-gate5.test.ts`)는 직접 `runCaseBackfillPass`를 호출해 다음을 증명한다.

- non-discover 및 discover 양쪽에서 Germany 2023(flag on), France 2024 QPC를 명시적으로 미승인 주입한 경우, Spain 2024(source policy 미승인), 2025+는 `beginRun` 호출 전에 거부된다.
- Germany 2024는 기존 policy + history flag 조건이 성립할 때만 fetch가 진행된다.
- `lib/backfill/service.ts`가 discover/non-discover 두 경로 모두에서 `beginRun` 이전에 gate를 호출한다.

PostgreSQL 통합 테스트 1건은 이 환경에 disposable DB가 없어 skip이며, M1 CI release gate가 skip 0을 강제한다. 기존 migration은 수정하지 않았다. France owner approval은 새 timestamp migration `20260916090000`으로, 2024 canary에서 발견된 open authoritative-count 제약 보정은 별도 새 migration `20260916093000`으로 추가했다. 2026-09-16 owner의 E1/E2 승인 이후 v2 successor는 새 timestamp migration `20260916100000`(policy row), `20260916101000`(strict `source_inventory_item_upsert_v3` E1 branch), `20260916102000`(attribution v2)으로 추가했으며, production에는 아직 적용하지 않았다.

### M5-B1/B2 production evidence (2026-09-16)

- `20260916090000_constitutional_case_france_policy_approval.sql`: production 적용 완료.
- 최초 QPC discover에서 기존 authoritative-count constraint가 open snapshot의 미확정 count를 막는 결함을 발견했다. 기존 migration을 수정하지 않고 `20260916093000_constitutional_case_open_authoritative_count.sql`을 추가해 open/failed에서만 count 미확정을 허용하고 closed/superseded에서는 count를 계속 강제했다 (`33c7e97`).
- 2024 QPC snapshot `473522ae-2b03-4581-8ba7-7632a8e41048`: 42/42 discovered/fetched/normalized/verified, errors 0, published 0, manifest `9e61bcc34d61d99a8f6216b287cfd13ab9290a687368f5e304e7ca58abea4523`.
- 2024 DC snapshot `bc1ebccd-8cbc-4821-babe-5fe850925875`: 12/12 discovered/fetched/normalized/verified, errors 0, published 0, manifest `b88b4a0d1d0a28a22a9e5304663db18cb3daf5918340167bd253bb477baadd5f`.
- 두 snapshot의 discover/fetch/normalize/verify/reconcile run은 전부 `succeeded`, retryable/terminal failure 0, completion 후 active claim 0.
- France policy의 `case_catalog_publications_v1` row 0, `p1.case-backfill.publish` command 0, Gemini/AI 0.
- QPC 42-item fetch 중 Crawlee `AsyncEventEmitter` migrating-listener warning이 1회 관측됐다. 원인은 fixed detail-only crawl에도 `RequestQueue`를 생성해 global listener가 누적되던 구조였다.
- M5-B2.1에서 fixed `DETAIL` 요청은 `RequestList`, 동적 `LIST` discovery는 기존 `RequestQueue`를 사용하도록 분리했다. 60개 detail URL 실회귀에서 60/60 성공했고 `migrating`/`aborting` listener 수가 실행 전후 동일했다.
- 따라서 France 2010~2023 QPC/DC 확대의 선행 listener lifecycle blocker는 해소됐다.
- M5-B3.1 2023 QPC snapshot `f7356ffa-e45e-453d-a6e3-bfffe92ea688`: 45/45 discovered/fetched/normalized/verified, error 0, active claim 0, published 0, manifest `71e2aecebd5a55882ce576e6bbcfbd497d1352d8036536c216b9fe645a64e03b`.
- M5-B3.1 2023 DC snapshot `8c1a5ea8-b221-4b78-8df1-e74ef51e6da1`: 15/15 discovered/fetched/normalized/verified, error 0, active claim 0, published 0, manifest `0c65b361ac6b460dcf147c70f0f031b84b6b394e2c30a2de8ba9bb694135d400`.
- 2023 wave의 10개 discover/fetch/normalize/verify/reconcile run은 모두 `succeeded`, retryable/terminal failure 0이었다. 45-item QPC production fetch에서도 listener warning은 재발하지 않았다.
- M5-B2.2에서 승인 policy v1에 이미 명시된 `latest global stock + ordered increment archives` 규칙이 실제 구현에서 빠져 있음을 발견하고 보완했다. 2026-09-16 live directory 기준 base stock 이후 increment 21개를 순서대로 적용하며, 같은 DILA ID만 last-write overlay하고 서로 다른 DILA ID가 같은 Conseil identity를 가리키면 fail-closed한다. 전체 archive provenance는 기존 append-only enumeration artifact ledger에 저장·봉인하고, `coverage_evidence`는 16 KiB 한도를 넘지 않도록 count/first/last/chain-hash 요약만 보관한다.
- ordered overlay read-only 재검증은 2024 QPC 42/42, 2024 DC 12/12, 2023 QPC 45/45, 2023 DC 15/15 exact identity-set을 유지했다. 기존 closed production snapshot은 수정하지 않았다.
- 2022 QPC는 `20225813AN_QPC`에 DILA ID `CONSTEXT000046216504`와 `CONSTEXT000047955984`가 동시에 존재해 `france_dila_conseil_identity_duplicate`로 차단된다.
- 2022 DC는 complete stock+21 increments에도 Conseil identity `2022847DC`가 없어 `france_inventory_identity_mismatch:dila=;web=2022847dc`로 차단된다.
- 따라서 M5-B3.2는 **production write 0인 blocked 상태**이며, staged newest-to-oldest 규칙에 따라 2021로 건너뛰지 않는다. 두 anomaly에 대한 새 reviewed source-policy 결정 전에는 진행하지 않는다.
- M5-B2.3은 owner가 **E1과 E2 모두 승인**했고 로컬 구현·controller hardening·live read-only 검증까지 완료됐다. E1은 exact one-case Conseil fallback `2022847DC`에 한정되며 매 discover마다 전체 DILA raw XML chain에서 sourceRecordId/NOR를 재검색하고 공식 Conseil detail ECLI/JORF를 corroborate한다. E2는 exact pair `CONSTEXT000047955984`/`CONSTEXT000046216504`만 허용하며 frozen Conseil title/ECLI와 현재 공식 detail이 일치할 때만 canonicalization한다. live v2 verifier는 **2022 QPC 67/67**, **2022 DC 13/13** exact match를 확인했다. v2 migrations는 아직 production에 적용되지 않았고 2022 snapshot/backfill도 실행하지 않았으므로 France 진행도는 계속 **4/30 production-complete**다. history flag 기본값은 `france_history_disabled`, Catalog/Gemini는 off, 2024/2023 snapshot은 immutable, 2021 진행도 계속 금지한다.
- M5-B3.2 production rollout preflight는 read-only로 완료했다. linked Supabase dry-run은 pending migration이 정확히 `20260916100000`/`101000`/`102000` 세 개뿐임을 확인했다. `101000`이 `service_role`의 inventory-upsert 권한을 v2에서 v3로 교체하므로 production 적용 시에는 모든 case-backfill worker/command를 idle로 고정하고, migration 직후부터 HEAD `95505c7` 호환 v3 worker만 사용해야 한다. 실제 production migration/2022 snapshot/backfill은 아직 실행하지 않았다. 상세 절차와 stop condition은 `docs/worldcons-m5b32-france-2022-production-rollout-preflight-20260916.md`를 따른다.
- M5-B3.2 production execution도 완료했다. v2 migration 3개를 production에 적용하고 v3 privilege cutover를 확인한 뒤 2022 QPC `1273e11d-e754-4fcc-809a-e23d7de2a231`을 67/67, DC `de5e7ff3-75ff-4458-b2d7-44c1268618a3`을 13/13 verified로 완료했다. QPC에는 E2가 정확히 1건, DC에는 E1이 정확히 1건 적용됐다. 10개 P1 run이 모두 `succeeded`, item error/retryable/terminal/active claim은 모두 0, Catalog publication/publish command/Gemini는 0이며 기존 2024/2023 manifest도 변하지 않았다. France QPC/DC 진행도는 **6/30 production-complete**이고 다음 bounded wave는 2021 QPC/DC다. 상세 증적은 `docs/worldcons-m5b32-france-2022-private-shadow-completion-20260916.md`에 기록했다.
- M5-B4.1 Germany 2023: owner가 2026-09-16 reviewed 2024 가정을 그대로 유지한 채 2023 한 해만 추가 승인했다. 새 immutable successor `bverfg-unattended-canary-v2`(migration `20260916110000`, supersedes v1, review due 2027-03-15)를 production에 적용했고, discover가 snapshot `57948d51-1300-4ff1-86db-be00a6572bc9`(354 item, manifest `d93af2b195b2ec0b667f8c56f46c20e4b7a6ea74dc9bd9431d4bf3439c745c76`)로 봉인됐다. fetch는 reviewed 30초 request floor 때문에 tranche 전체가 약 20시간이 걸려 한 bounded run에서 완료되지 못했고, drain을 실행한 상태로 남겼다. 2024 snapshot/hash는 불변, 2022 이하는 계속 차단. 상세 증적: `docs/worldcons-m5b41-germany-2023-production-blocker-20260916.md`.
- 상세 증적: `docs/worldcons-m5b2-france-2024-private-shadow-canary-20260916.md`.
- hardening 증적: `docs/worldcons-m5b21-france-crawlee-listener-hardening-20260916.md`.
- 2023 expansion 증적: `docs/worldcons-m5b31-france-2023-private-shadow-expansion-20260916.md`.
- ordered-increment/2022 blocker 증적: `docs/worldcons-m5b22-france-dila-ordered-increment-overlay-20260916.md`.

## 9. Catalog publication rollout과의 분리

M5는 역사 corpus ledger의 orchestration만 다룬다. `/articles` 노출, Catalog publication, 통합 검색, MCP 플러그인은 기존 Gate 2~4 precedence와 별도 canary 승인을 따른다. M5 readiness의 `publicCatalogEnabled`/`catalogWriteEnabled`는 상태 보고일 뿐이며, M5 구현·검증은 두 flag를 켜지 않았다.

## 10. 변경 파일

M5 초기 구현(커밋 `7b9788b`):

- `lib/backfill/rollout-readiness.ts` (신규)
- `lib/backfill/service.ts` (discover/non-discover 양쪽 `beginRun` 이전 worker-level rollout gate)
- `scripts/backfill-corpus.ts` (rollout preflight + plan rolloutSelection)
- `scripts/rollout-readiness.ts` (신규, read-only 증거 CLI)
- `tests/constitutional-case-rollout-readiness-gate5.test.ts` (신규)
- `tests/constitutional-case-backfill-gate1.test.ts` (Spain non-discover 테스트에 `spainHistorySourcePolicyApproved: true` 주입)
- `package.json` (`rollout:readiness` script, `test:backfill`에 신규 테스트 포함)

France owner 승인 반영(2026-09-16):

- `supabase/migrations/20260916090000_constitutional_case_france_policy_approval.sql` (신규 immutable policy row)
- `lib/backfill/france-scope.ts` (approved policy metadata/descriptor)
- `lib/backfill/country-history-policy.ts` (France QPC/DC tranche `approved_source_policy`)
- `lib/backfill/rollout-readiness.ts` (France approved years/selections, 다음 blocker)
- `tests/constitutional-case-rollout-readiness-gate5.test.ts`, `tests/constitutional-case-backfill-france-gate5.test.ts`, `tests/constitutional-case-history-boundary-gate5.test.ts`, `tests/constitutional-case-catalog-gate2.postgres.test.ts`

문서:

- `docs/worldcons-m5-rollout-readiness-runbook.md` (이 문서)
- `docs/worldcons-constitutional-case-backfill-design-20260903.md` (M5 섹션 추가)
- `docs/france-constit-source-policy-review-20260903.md`, `docs/france-conseil-history-gate5-runbook.md`, `docs/worldcons-m4-country-history-boundary-20260916.md` (France 승인 반영)
