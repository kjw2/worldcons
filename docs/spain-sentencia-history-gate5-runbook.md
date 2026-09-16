# Spain 2020~2024 Sentencia Gate 5 운영 런북

> **백필 불변 원칙:** 스페인의 법률/robots source-policy 차단은 반드시 지키되, 그 차단이 해소된 뒤의 historical inventory/fetch/normalize/verify/reconcile은 Gemini 한도나 기존 공개 대기분 때문에 지연시키지 않는다. AI 번역·요약·공개는 별도 후행 backlog로 관리한다. 공통 정책은 `docs/worldcons-historical-backfill-operating-principles-20260916.md`를 따른다.

상태: 연도별 scope·P1 이중 잠금·주입형 discovery 검증 완료, 운영 2024 canary 및 historical 실행 전

## 범위

Gate 5의 첫 확대는 스페인 헌법재판소 HJ의 `SENTENCIA` 2020~2024다. 2024는 Gate 1 baseline이며 2020~2023은 history flag가 필요한 확대 범위다. 연도를 합친 snapshot을 만들지 않는다.

```text
2020-01-01 ~ 2020-12-31  snapshot 1
2021-01-01 ~ 2021-12-31  snapshot 2
2022-01-01 ~ 2022-12-31  snapshot 3
2023-01-01 ~ 2023-12-31  snapshot 4
2024-01-01 ~ 2024-12-31  Gate 1 baseline snapshot
```

각 snapshot은 자체 policy version, manifest hash, coverage evidence, reconciliation 결과를 가진다. 한 연도의 parser·coverage 문제가 다음 연도의 완료율에 가려지지 않는다.

## 1. 안전 잠금

기본값은 다음과 같다.

```text
CASE_CATALOG_SPAIN_HISTORY_ENABLED=false
```

2020~2023 discover는 CLI에서 한 번, P1 worker의 `runCaseBackfillPass`에서 다시 한 번 검사한다. flag가 없으면 `case_backfill.spain_history_disabled`로 run 생성 전에 종료한다. 2019 이하와 2025 이상은 flag와 무관하게 `case_backfill.spain_year_not_supported`로 거부한다.

M4부터 이 단계는 **source policy 차단 상태를 코드에 고정**한다. `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_STATUS=blocked_pending_legal_robots_review`이고 `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED=false`이므로, history flag가 true여도 2020~2023 discover는 `case_backfill.spain_history_source_blocked`로 run 생성 전에 종료한다. `robots.txt` 404와 법적 고지 403에 대한 명시적 승인 근거가 source policy version에 기록되기 전에는 이 상태를 바꾸지 않는다. 연도·유형 확대 순서는 `COUNTRY_HISTORY_EXPANSION_ORDER`에 고정된다: 2020~2024 `SENTENCIA` → 1980~2019 `SENTENCIA`+`DECLARACION` → `AUTO`.

2024 baseline이라는 개념은 유지하지만, **source policy 승인 없이는 2024 discover도 fail-closed**다. 2024는 history flag를 요구하지 않는 대신 `policyApproved`가 반드시 필요하며, 기본값(`SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED=false`)에서는 `case_backfill.spain_history_source_blocked`로 run 생성 전에 종료한다. `policyApproved`가 명시적으로 주입·기록된 경우에만 history flag 없이 2024 discover가 열린다. 2020~2023은 history flag와 `policyApproved`를 모두 요구한다. 기존 P1 authority, immutable source policy, phase별 command allowlist와 Catalog write flag는 그대로 적용된다.

## 2. 실행 전 필수 조건

1. Gate 1의 2024 inventory→fetch→normalize→verify→reconcile 운영 증거가 모두 통과한다.
2. 2024 Catalog canary를 공개했다면 source-only 상세·검색·플러그인과 rollback을 검증한다.
3. source policy의 `review_due_at`이 유효하고 2024 baseline과 2020~2023 보관·공개 범위를 포함하는지 법률 검토한다.
4. 공식 HJ 검색에서 연도별 결과 count 또는 exhaustive pagination 근거를 다시 수집한다.
5. 요청 지연·동시성·재시도 예산을 2024 실측에 맞춘다.
6. `CASE_CATALOG_SPAIN_HISTORY_ENABLED=true`는 위 승인 뒤에만 실행 환경에 설정한다.

## 3. 연도별 실행

계획은 DB 없이 확인할 수 있다.

```text
pnpm backfill:corpus plan --year=2020
pnpm backfill:corpus plan --year=2024
```

source policy 차단 상태에서는 2020~2023은 물론 **2024도 `executionEnabled=false`, `sourcePolicyStatus=blocked_pending_legal_robots_review`, `sourcePolicyApproved=false`**를 출력한다. history flag를 켜도 2020~2023은 `executionEnabled=false`다. `policyApproved`가 기록된 뒤에만 승인 순서대로 한 연도씩 다음을 수행한다.

```text
pnpm backfill:corpus discover --year=2020 --policy-version=<approved-version>
pnpm backfill:corpus fetch --snapshot=<snapshot-id>
pnpm backfill:corpus normalize --snapshot=<snapshot-id>
pnpm backfill:corpus verify --snapshot=<snapshot-id>
pnpm backfill:corpus reconcile --snapshot=<snapshot-id>
```

각 phase는 기존 P1 allowlist에 해당 command 하나만 넣고 실행한다. reconcile이 clean하기 전에는 publish하지 않으며, 한 연도가 완료되기 전에 다음 연도를 열지 않는다. source-only publish에는 별도로 `CASE_CATALOG_WRITE_ENABLED=true` 승인이 필요하다.

## 4. 연도별 완료 기준

- 공식 pagination이 exhaustion을 증명하고 manifest가 닫혀 있다.
- 중복 HJ ID 0건, scope 밖 decision date 0건, 설명되지 않은 terminal failure 0건이다.
- fetch artifact는 승인된 bounded replay field만 포함한다.
- normalize 재실행의 네트워크 호출이 0회다.
- verify된 `resolutionType`이 모두 `SENTENCIA`이고 canonical URL의 HJ ID가 inventory와 일치한다.
- processing completion과 coverage assurance를 별도로 보고한다.
- 공개 전후 기존 P3와 다른 연도 snapshot의 digest가 변하지 않는다.
- Gemini 호출은 0회다.

## 5. 중단과 롤백

문제가 난 연도의 신규 P1 claim을 중단하고 history flag를 false로 되돌린다. 이미 생성된 immutable snapshot·artifact·event는 삭제하지 않는다. 공개 전이면 해당 연도는 private shadow로 남긴다. 공개 후 correction이 필요하면 publication withdrawal/correction event를 사용하며 mutable article을 직접 덮어쓰지 않는다.

2020~2023 네 연도의 개별 완료 증거가 모두 모인 뒤에만 문서상 `Spain 2020~2024 Sentencia` 단계를 완료로 표시한다.
