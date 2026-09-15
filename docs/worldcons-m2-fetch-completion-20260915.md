# WorldCons M2 복구 완료 증거: 독일 2024 private-shadow fetch (2026-09-15)

작성: 2026-09-15. 코드 기준 커밋: `ef2a350` (M1 release gate) + 이 문서와 같은 변경에 포함된 R1 코드 보완.
대상 snapshot: `de-bverfg` / `d6c7b404-2252-4369-a719-8e17d2dfaba2` (2024-01-01~2024-12-31, `DECISION`).
목표 범위: **fetch 단계 완료**까지. normalize/verify/reconcile은 다음 단계(R3)이므로 실행하지 않았다.

## 1. 범위와 금지 준수

- 새 discovery, 새 snapshot, supersession을 실행하지 않았다. 기존 `closed` snapshot 하나만 재개했다.
- 운영 DB에 직접 update/delete/insert/upsert를 하지 않았다. 항목 claim/reclaim/종결은 기존 P1 RPC(`admin_*`, `source_backfill_*`)와 기존 bounded fetch drain만 사용했다.
- coordinator SQLite DB를 수정하지 않았다. Orca를 사용하지 않았다.
- `CASE_CATALOG_WRITE_ENABLED`, `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED`는 false로 유지했고, private-shadow Gemini 호출은 0이었다.
- 기존 untracked `artifacts/`, `docs/worldcons-recovery-and-improvement-plan-20260905.md`, `scripts/.tmp-wc-inspect.ts`는 건드리지 않았다.
- push/deploy를 하지 않았다.

## 2. M2 진입 상태 (기준선, `bcaef9f` 진단)

`pnpm diagnose:backfill-recovery -- --snapshot=d6c7b404-...` 결과(2026-09-15, 실제 행 읽기):

- `observedItemCount=287`, `discoveredCount=287`, `manifest_hash` 유효, snapshot `closed`.
- fetch 미완료: `discovered` 56 + 중단 `fetching` 1 = 57.
- 비종결 pass: fetch pass 28 `queued`(고아, attempt 없음), fetch pass 118 `running`(attempt `0b365886-...`, fencing 124, lease 만료).
- 만료 claim 1건과 `backfill_run_running_without_live_attempt`, `backfill_run_queued_stale` mismatch.

## 3. M2에서 확인한 결함과 코드 보완 (R1)

운영 재개 중 아래 결함을 확인해 코드로 보완했다(테스트 포함).

1. **완료 판정이 claim/진행 중 pass를 보지 않음.** 기존 drain은 `due backlog=0`, `retry=0`, `terminal failure=0`만 확인했다. lease가 만료된 `fetching` 항목은 backlog 계산에서 제외되므로, claim이 남아 있어도 “완료”로 오판할 수 있었다. → 완료 조건에 활성 claim, 잔여 claim, 비종결 pass를 추가했다.
2. **활성 run과 충돌할 때 고아 queued pass 생성.** CLI가 항상 `pass_allocate`로 새 pass를 만든 뒤 submit했고, active dedupe에 걸리면 그 queued pass가 영구 고아로 남았다(실제로 pass 28, 그리고 이번 재개 중 pass 119 발생). → `resolvePassNumber`가 기존 queued/running pass를 먼저 재사용하고, 없을 때만 새 pass를 할당한다. 기존 `source_backfill_run_begin_v1`의 `on conflict`가 재사용 pass를 running으로 전이한다.
3. **살아 있는 다른 실행자를 덮어쓸 위험.** → live attempt lease가 있으면 새로 submit하지 않고 관측 대기한다. lease가 만료된 run은 기존 P1 claim 경로가 `lease_expired`로 회수하고 item claim을 `retry_wait`로 되돌린다(stale fence는 종결에 사용할 수 없음).

변경 파일:

- `lib/backfill/repository.ts`: select-only `listNonTerminalRuns`, `countResidualClaims` 추가.
- `lib/backfill/bverfg-fetch-drain.ts`(신규): 완료/대기/실행 판정 순수 함수.
- `scripts/backfill-corpus.ts`: `resolvePassNumber`로 고아 pass 재사용.
- `scripts/drain-bverfg-fetch.ts`: 상태 기반 완료·대기·진행, no-progress/idle 상한, bounded stop을 “중단점”으로 보고.
- `tests/bverfg-fetch-drain.test.ts`(신규), `tests/constitutional-case-backfill-germany-gate5.test.ts`(정적 계약 갱신), `package.json`(`test:backfill`에 신규 테스트 포함).

검증: `pnpm typecheck`, `pnpm lint`, `pnpm check`, `pnpm test:backfill`, `pnpm test:ingest-workflow`, `pnpm test:p1` 통과. PostgreSQL 통합 테스트는 이 환경에 disposable DB가 없어 1건 skip이며, M1 CI release gate가 skip 0으로 강제한다.

## 4. 실행한 복구 (기존 명령만 사용)

운영 재개의 실행 플래그는 프로세스 환경변수로만 주입했고, 공개/Catalog/AI 플래그는 false로 고정했다.

```powershell
$env:ADMIN_QUEUE_V3_WORKER_ENABLED="true"
$env:ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES="p1.case-backfill.fetch"
$env:ADMIN_QUEUE_V3_WORKER_COHORTS="catalog-backfill"
$env:CASE_CATALOG_GERMANY_HISTORY_ENABLED="true"
$env:CASE_CATALOG_WRITE_ENABLED="false"
$env:CASE_CATALOG_PUBLIC_ENABLED="false"
$env:CASE_CATALOG_PLUGIN_ENABLED="false"
pnpm backfill:bverfg-fetch-drain -- --snapshot=d6c7b404-2252-4369-a719-8e17d2dfaba2 --max-passes=200 --batch-limit=2 --execute --requested-by=worldcons-unattended-operations
```

- 첫 재개 pass에서 stale attempt `0b365886-...`가 `lease_expired`로 회수되고, 만료 claim이 `retry_wait`로 해제된 뒤 같은 pass가 재실행됐다(`case_backfill_submitted` deduplicated=true → fencing 124 stale fence는 종결에 사용되지 않음).
- 고아 pass 28, 119는 `case_backfill_pass_reused`로 재사용되어 소진됐다(재사용 로그 3회: 28, 28→118 reclaim, 119).
- 최종 로그: `completedPasses=28`, `dueBacklog=0`, `retryWait=0`, `claimed=0`, `residualClaims=0`, `openRuns=0`, `terminalFailureCount=0`, `case_backfill_worker_finished` 실패 0, HTTP `requestsFailed` 0, `geminiCalls=0`, `publicCatalogWrites=0`. (일시 재시도 38회는 모두 성공.)
- 참고: 최초 관측용 1-pass 실행이 셸 도구 300초 제한으로 중단되어 stale claim 1건과 고아 pass 119를 남겼고, 위 R1 보완 drain이 이를 회수·소진했다. 이 중단 자체가 보완 대상 결함을 재현한 증거다.

## 5. M2 완료 증거 (읽기 전용, 실제 DB)

`pnpm backfill:corpus status -- --snapshot=d6c7b404-...`:

```
snapshotStatus=closed discoveredTotal=287 claimed=0 retryWait=0 failed=0
needsNormalize=280 needsReverify=0 needsRepublish=0 terminalTotal=0
manifestHash=7971b3b988a338896bfc156f56ca9bbb81fe113e9db0eafd8f4cab4e36df3446
```

`pnpm diagnose:backfill-recovery -- --snapshot=d6c7b404-...` (exit 0):

```
observedItemCount=287 discoveredCount=287 itemClaimCount=0 activeItemClaimCount=0 expiredItemClaimCount=0
runCount=149 runningRunCount=0 queuedRunCount=0 mismatches=[] claimFindings=[] runFindings=[]
```

`pnpm verify:bverfg-shadow-canary -- --snapshot=d6c7b404-...` (경계 확인, normalize 미실행이므로 status=blocked):

```
blocking=["private_shadow_items_incomplete"]
itemCount=287 resolvedOfficialUrlCount=287 verifiedCount=7
activeClaimCount=0 retryWaitCount=0 terminalFailureCount=0
publishedItemCount=0 articleLinkedCount=0 catalogPublicationCount=0 aiPayloadCount=0 geminiCalls=0
```

해석:

- fetch 대상 287건 전부가 fetch artifact를 가진 상태가 되었다: `needsNormalize=280` + 기존 `verified=7` = 287, `terminal`/`retry`/`claim`/`failure` 0.
- 진행 중 pass·고아 pass가 0이므로 fetch 단계가 완전히 끝났다.
- `publishedItemCount=0`, `articleLinkedCount=0`, `catalogPublicationCount=0`, `aiPayloadCount=0`, `geminiCalls=0`로 공개·Catalog·AI 경계가 유지됐다.
- canary의 유일한 blocker는 다음 단계(R3)인 normalize/verify/reconcile 미실행에 따른 `private_shadow_items_incomplete`이며, 이는 의도된 상태다. waiver로 완료 처리하지 않는다.

## 6. run / attempt 기준선 변화

| 항목 | M2 이전 | M2 이후 |
|---|---|---|
| `source_backfill_runs` 총계 | 123 | 149 |
| fetch pass | 118 (114 succeeded, 2 failed, 1 queued, 1 running) | 144 (전부 terminal; 고아 pass 28·119 소진, pass 118 회수 재실행, 신규 pass 25건 할당) |
| 비종결 pass | 2 (28 queued, 118 running) | 0 |
| 잔여/만료 claim | 1 (만료) | 0 |
| fetch artifact 연결 | 230 | 287 |

(로그상 R1 이전 실패 pass의 산출물은 append-only로 보존됐고, M2 재개도 기존 artifact를 수정·삭제하지 않았다.)

## 7. 실행하지 않은 것 / 남은 단계

- normalize → verify → reconcile(R3)은 실행하지 않았다. `needsNormalize=280`은 다음 단계 입력이다.
- canary PASS, article/Catalog publication, AI payload 생성은 범위 밖이다.
- push/deploy, migration 적용, coordinator DB 수정은 하지 않았다.
- 이 환경에서는 disposable PostgreSQL 기반 통합 테스트를 실행하지 않았고, M1 CI release gate가 이를 skip 0으로 검증한다.

## 8. 근거

- 진단: `lib/backfill/recovery-diagnostics.ts`, `scripts/backfill-recovery-diagnose.ts`
- R1 보완: `lib/backfill/bverfg-fetch-drain.ts`, `lib/backfill/repository.ts`, `scripts/backfill-corpus.ts`, `scripts/drain-bverfg-fetch.ts`
- 테스트: `tests/bverfg-fetch-drain.test.ts`, `tests/constitutional-case-backfill-germany-gate5.test.ts`
- 스키마: `supabase/migrations/20260903120000_constitutional_case_backfill_gate1.sql`, `20260712090000_admin_command_control_plane.sql`
- 기준선: `docs/worldcons-backfill-recovery-baseline-20260915.md`
