# WorldCons 백필 복구 기준선 (2026-09-15)

작성: 2026-09-15. 기준 커밋: `bcaef9f` (M0 진단 도구 변경은 이 문서와 같은 커밋에 포함).
대상 snapshot: 독일 `de-bverfg` / `d6c7b404-2252-4369-a719-8e17d2dfaba2` (2024-01-01~2024-12-31, DECISION).

## 0. 범위 원칙 (확정)

- **2025~현재**: 4개 source(`de-bverfg`, `es-tribunal-constitucional`, `fr-conseil-constitutionnel`, `us-scotus`)의 **incremental ingestion** 책임이다. 이 구간은 Gate 5 backfill로 다시 열지 않는다.
- **Gate 5 backfill**: 위 4개 source의 **2025년 이전 historical corpus 확장**이 주목적이다. 독일 2024 snapshot은 그 첫 적용 사례다.
- 이 기준선은 **읽기 전용 진단**만 기록한다. 수집 재시작, DB 수정, migration 적용, 배포, 커밋된 문서 외 파일 변경은 이 작업에서 하지 않았다.

## 1. 읽기 전용 확인 방법

진단 도구는 `lib/backfill/recovery-diagnostics.ts` + `scripts/backfill-recovery-diagnose.ts`이며 다음만 수행한다.

- `source_inventory_snapshots`의 `discovered_count`, `manifest_hash`, scope, policy, `status`를 **스냅샷 행에서 직접** 읽는다.
- `source_backfill_items`는 `snapshot_id` 기준으로 **정확한 총 건수**(`count: "exact", head: true`)와 claimed 항목만 읽는다. `discoveredCount`를 claim 수로 추정하지 않는다.
- `source_backfill_runs`, `admin_command_attempts`, `admin_command_runs`를 select-only로 조인해 run/attempt/fencing/lease 정합성을 판정한다.
- `.insert(`/`.update(`/`.delete(`/`.upsert(`/`.rpc(`/`.storage` 를 사용하지 않으며 출력에 `readOnly: true`, `productionWriteAuthorizedByThisCheck: false`를 남긴다.
- mismatch가 1건이라도 있으면 exit code 1로 종료한다. exit code 1은 도구 장애가 아니라 **중단 상태를 정확히 검출한 결과**다.

```powershell
pnpm diagnose:backfill-recovery -- --snapshot=d6c7b404-2252-4369-a719-8e17d2dfaba2
```

연결 경로: Supabase REST(service role, 읽기 전용 select). Supabase 직접 Postgres 호스트(`db.*.supabase.co`)는 이 환경에서 IPv6만 해석되어 사용할 수 없었다(§6 참조).

## 2. snapshot 기준선

| 항목 | 값 |
|---|---|
| snapshot id | `d6c7b404-2252-4369-a719-8e17d2dfaba2` |
| source | `de-bverfg` |
| scope | 2024-01-01 ~ 2024-12-31, `DECISION` |
| discovery method | `external_index_dejure_to_official_detail` |
| parser version | `bverfg-official-normalize-v2` |
| source policy version | `bverfg-unattended-canary-v1` |
| coverage assurance | `external_index_assisted` |
| status | `closed` |
| `discovered_count` | **287** |
| `manifest_hash` | `7971b3b988a338896bfc156f56ca9bbb81fe113e9db0eafd8f4cab4e36df3446` |
| created_by | `worldcons-unattended-operations` |
| opened_at / closed_at | 2026-09-04T06:29:39Z / 2026-09-04T06:38:58Z |

진단 도구가 실제 행에서 읽은 값이며, `observedItemCount = 287`로 스냅샷 `discovered_count`와 일치한다. `snapshot_discovered_count_mismatch`, `snapshot_manifest_hash_invalid`는 발생하지 않는다.

## 3. 항목(Item) 기준선 (총 287)

| status | 건수 |
|---|---|
| `discovered` | 56 |
| `fetching` | 1 |
| `fetched` | 223 |
| `verified` | 7 |
| `normalized` / `published` | 0 / 0 |
| `retry_wait` / `terminal_failure` / `waived_failure` | 0 / 0 / 0 |
| `excluded` / `duplicate` / `withdrawn` | 0 / 0 / 0 |

연결 pointer:

| pointer | 건수 |
|---|---|
| `current_fetch_artifact_id` 연결 | **230** |
| `current_normalization_artifact_id` 연결 | **7** |
| `verified_normalization_artifact_id` 연결 | **7** |
| `published_normalization_artifact_id` 연결 | 0 |
| `article_id` 연결 | 0 |

미완료 fetch 대상 = `discovered` 56 + 중단 `fetching` 1 = **57건**.

## 4. run / attempt / claim 기준선

`source_backfill_runs` 총 123행.

| phase | pass 수 | 상태 요약 |
|---|---|---|
| `discover` | 1 | pass 1 succeeded, claimed/succeeded 287/287 |
| `fetch` | 118 | succeeded 114, failed 2, **queued 1**, **running 1** |
| `normalize` | 2 | pass 1·2 succeeded (5/5, 2/2) |
| `verify` | 2 | pass 1·2 succeeded (5/5, 2/2) |

비종결 run:

| run id | phase/pass | 상태 | p1 attempt | fencing | command run | started_at |
|---|---|---|---|---|---|---|
| `eb5fa0d3-b472-4b18-9fce-210389e87ce7` | fetch pass 28 | `queued` | 없음 | 없음 | 없음 | 2026-09-04T11:22:06Z |
| `c29660e1-2095-4e07-af80-34b14897696f` | fetch pass 118 | `running` | `0b365886-d23e-46e9-b964-6b90ac297503` | 124 | `3354b79f-44d7-4428-9d5f-570d12e08e0c` | 2026-09-04T21:42:14Z |

- 마지막 성공 fetch pass: **117** (`4ba8dc25-4fd2-4abc-8a11-ae905b67f01e`, succeeded 2/2, fencing 123).
- fetch 실패 pass: 2 (`internal`), pass 2 fencing 4, pass 10 fencing 16.
- 중단 pass 118의 command run `3354b79f...`는 DB상 `running`, current attempt는 `0b365886...`로 일치한다.
- attempt `0b365886...`: status `running`, fencing token 124, lease_expires_at **2026-09-04T21:48:20Z** (이미 만료).

활성 claim 1건:

| item id | phase | attempt | fencing | item lease | attempt lease | attempt status | command run status |
|---|---|---|---|---|---|---|---|
| `53f3a217-9f40-4df4-88c6-0298d6f9b763` | fetch | `0b365886-d23e-46e9-b964-6b90ac297503` | 124 | 2026-09-04T21:47:58Z | 2026-09-04T21:48:20Z | running | running |

## 5. 진단 결과 (2026-09-15 기준)

`pnpm diagnose:backfill-recovery -- --snapshot=d6c7b404-...` 출력 요약:

```
summary: observedItemCount=287, discoveredCount=287, itemClaimCount=1,
         activeItemClaimCount=0, expiredItemClaimCount=1,
         runCount=123, runningRunCount=1, queuedRunCount=1
mismatches:
  backfill_run_queued_stale
  backfill_run_running_without_live_attempt
  item_claim_attempt_lease_expired
  item_claim_lease_expired
claimFindings:
  53f3a217-... : [item_claim_lease_expired, item_claim_attempt_lease_expired]
runFindings:
  eb5fa0d3-... : [backfill_run_queued_stale]
  c29660e1-... : [backfill_run_running_without_live_attempt]
```

해석:

1. `item_claim_lease_expired` / `item_claim_attempt_lease_expired`: 2026-09-04에 만료된 claim과 attempt lease다. 실패가 아니라 **회수 가능한 중단**이다.
2. `backfill_run_running_without_live_attempt`: pass 118이 DB상 `running`이지만 attempt lease가 만료돼 살아 있는 실행자가 없다.
3. `backfill_run_queued_stale`: fetch pass 28이 attempt/command run 없이 `queued`로 오래 남은 고아 행이다.
4. fencing token(124)과 `command_run.current_attempt_id`는 일치하므로 stale fence 문제는 아니다.
5. snapshot은 `closed`, `discovered_count=287 == observedItemCount=287`, `manifest_hash` 유효 → snapshot 자체는 신뢰 가능하다.

## 6. 금지 사항 (이 단계와 M2 모두 적용)

- 운영 DB에 **직접 쓰기**(update/delete/insert) 금지. claim/lease/run 종결은 반드시 기존 P1 RPC(`source_backfill_*`, `admin_*`)로만 처리한다.
- **Orca 사용 금지**.
- 운영 secrets/운영 DB를 CI release gate에 노출 금지(M1). CI는 disposable PostgreSQL+pgvector만 사용한다.
- public/Catalog/AI 경계 확대 금지: `CASE_CATALOG_WRITE_ENABLED`, `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED` false 유지, Gemini egress 금지.
- 발견(discover) 재실행·superseded 목록 재사용 금지. 기존 fetch/normalization artifact와 audit 원장을 보존한다.
- 기존 untracked `artifacts/`와 `docs/worldcons-recovery-and-improvement-plan-20260905.md`는 건드리지 않고 커밋하지 않는다.
- `snapshot` 전체 재생성이나 무제한 자동 재시작을 복구 수단으로 쓰지 않는다.

## 7. M2 진입 조건

M2(중단 복구 실행 및 private-shadow 완료)는 아래를 모두 만족할 때만 시작한다.

1. **진단 도구**: `tests/backfill-recovery-diagnostics.test.ts` 통과(정상/만료/manifest/카운트/fencing/queued 케이스 포함)와 위 실제 snapshot 진단 결과가 재현된다.
2. **release gate (M1)**: PR/push에서 disposable PostgreSQL+pgvector gate가 실행되고, P0/P1/P2/P3/P5/BACKFILL/CATALOG PostgreSQL 테스트 **skip 0**으로 통과한다.
3. **소유권**: snapshot/phase에 대해 살아 있는 다른 worker가 없음을 확인한다(pass 118 attempt lease 만료, `now > lease`). 실행 소유권을 확인한다.
4. **정리 계획 합의**: pass 118 `running`과 pass 28 `queued` 고아의 처리를 기존 P1 RPC로 어떻게 종결할지 결정한다(직접 UPDATE 금지). 만료 claim `53f3a217-...`은 기존 reclaim 경로로만 회수한다.
5. **정책 유효성**: `bverfg-unattended-canary-v1` review_due_at(2027-03-03) 이내, 공개·AI flag false, 운영 재개 승인 범위 유지.
6. **기대 종료식**: fetch 미완료 57건 → 0, 활성·고아 claim 0, retry/terminal 0, 그 후 normalize→verify→reconcile로 `verified + 명시적 excluded = 287`, article link/Catalog publication/AI payload 0.

## 8. 이번 기준선에서 실행하지 못한 검증 / 환경 한계

- 직접 Postgres(5432) 연결: `db.eawgnnytdvjuwhczyhlq.supabase.co`가 IPv6 AAAA만 반환해 `getaddrinfo ENOTFOUND`으로 실패. REST read-only로 우회했다.
- M1의 실제 PostgreSQL gate: 로컬에 disposable PostgreSQL+pgvector가 없어 이 환경에서는 실행하지 않았다. CI(PR/push)에서 실행되도록 M1 커밋에 포함한다.
- 운영 DB write, collection 재개, migration 적용, 배포는 수행하지 않았다.

## 9. 근거

- 진단 도구: `lib/backfill/recovery-diagnostics.ts`, `scripts/backfill-recovery-diagnose.ts`, `tests/backfill-recovery-diagnostics.test.ts`
- 스키마: `supabase/migrations/20260903120000_constitutional_case_backfill_gate1.sql`, `20260712090000_admin_command_control_plane.sql`
- 계획: `docs/worldcons-recovery-and-improvement-plan-20260905.md`(읽기 전용, 미커밋)
