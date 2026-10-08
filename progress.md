# Progress

## 2026-10-08 staged-ingest per-stage observability: oldest pending age (local code only)

Selected as the next highest-priority unfinished local reliability item after M6/M7, from the documented remaining M6/M7 pre-production gate: *"Implement audited, permissioned dead-letter redrive and observability reporting (per-stage counts, **oldest pending** and oldest lease)"* (`docs/worldcons-staged-ingest-m6-m7-local-verification-20261008.md:90-91`). The dead-letter redrive and per-stage counts/oldest-lease were already complete (commit `3b819ac`, `lib/cloudflare/ingest-stages/redrive.ts`); the missing bounded piece was the oldest **pending** job (queue-depth stall age). No previously completed item (dead-letter redrive, France source allowlist canary, stale regression stabilization) was redone.

- `lib/cloudflare/ingest-stages/redrive.ts`: `diagnoseIngestStageJobs` now also runs a single-stage, `LIMIT 1`, `created_at ASC` indexed read of the oldest `status='pending'` job and returns `oldestPendingJobId`/`oldestPendingCreatedAt`. This is the queue-depth stall signal: a `pending` row is unowned work waiting to be dispatched, independent of any failed/in-flight lease, and stays `pending` across a bounded retry (`failIngestStageJob` clears the fence on retry; a redrive clears it too). No scan is unbounded and no other stage can bleed in.
- `app/api/admin/ingest/dead-letter/route.ts`: the authenticated GET diagnosis now surfaces `oldestPendingJobId`/`oldestPendingCreatedAt` alongside the existing counts/oldest-lease fields. No new route, no auth or gate change.
- `tests/ingest-stage-redrive.test.ts` (+2, now 9 cases): oldest-pending selection picks the earliest `created_at` pending job and excludes leased/terminal/other-stage rows; a redrive moves a dead-letter job back to pending and the oldest-pending signal then points at it. 51/51 `test:ingest-stages`.
- Unchanged: France canary limits, feature gates/allowlist, P3/publication/source-provenance gates, M8 scheduler settings, lease/fencing/outbox/idempotency contracts. No remote DB write, deploy, commit, push or paid LLM call.
- Verified: `pnpm test:ingest-stages` 51/51, `pnpm typecheck`, `pnpm check`, `pnpm lint`, `test:m8` 40/40, `m8:types:check`, `m8:typecheck`, `m8:dry-run`, `git diff --check`.

## 2026-10-08 residual regression stabilization after production staged-ingest canary (local code only)

Resolved the eight pre-existing residual failing suites identified in the previous run. One real code fix and the rest stale tests/fixtures that had not been updated to the current production-only Cloudflare/D1 authority. No Supabase/Vercel/legacy Catalog/source-only exposure was re-enabled; P3/publication/source-provenance/privacy gates, staged-ingest France canary limits and M8 scheduler settings are unchanged.

- `test:m12` (real bug): `scripts/ops-watchdog.ts` hardcoded the retired `worldcons.soltera.dev` host in the GitHub-issue body. Now derives the base URL from `getAppBaseUrl()` (the canonical `worldcons.cclib.workers.dev` / `APP_BASE_URL`). 5/5.
- `test:rpc-ledger`: the curated M4.6 ledger still carried 10 `.rpc(` call sites removed by the Cloudflare cutover (`purge_site_events`, `worldcons_consume_rate_limit_v1`, `admin_record_compatibility_observation_p5`, the two `admin_*_source_url_candidate_retry_p1`, `claim_admin_job`, `append_admin_job_event`, `ops_workflow_heartbeat_v1`, `article_embedding_write_v1`, `article_embedding_readiness_v1`). Removed the now-orphan rows/constants and updated the scan-count assertions to the live scan (69 functions / 63 call sites / 21 files / 6 script-adjacent). Validation `ok` with 0 unmapped/orphan. 16/16.
- `test:d1-shadow-all` (9 failures): stale shadow fixtures. `admin-ops` fixtures now carry the `translation_status` column the D1 adapter expands; `article-read` fake synthesizes the published-P3 gate row the current authority requires; `article-read` backpressure test now compares against a real single-read control; `reference-read` fake resolves the authored `listJurisdictionArticleCounts` join; `admin-analytics`/`admin-ops` selection tests now assert legacy Supabase config never becomes an authority. 138/138.
- `test:admin-analytics-reads`: replaced the five Supabase-selection/delegation tests with the D1-only fail-closed contract (Supabase env alone never selects an adapter; observations record `fallback`). 17/17.
- `test:search-repository`: the exported `rankedSearchPage`/`exactCaseSearch` wrappers now run against an injected `worldcons_search`/`worldcons_core` D1 binding; the retired Supabase-selection and catalog-cursor tests were rewritten to the D1-only / hard-disabled public-catalog contract. 19/19.
- `test:article-reads`: the V4 detail/list relation test now asserts `public_article_detail_v4` stays retired and the P3 projection is always selected. 22/22.
- `test:p2`: the compatibility-boundary assertion now accepts the admin-path `articleLifecycleService` (D1-native) seam in addition to the ingest shadow seam; the raw-P2-write prohibition is unchanged. 15/15 (+1 postgres skip).
- `cloudflare-runtime-boundary`: the admin routes are queue/scheduler-only after the cutover; tests now assert no Node executor imports reappear and the job-drain route returns the `cloudflare_scheduler` contract. 4/4.
- Verified: `pnpm check`, `pnpm typecheck`, `pnpm lint` (0 errors), `test:m8` 40/40, `m8:types:check`, `m8:typecheck`, `m8:dry-run`, `build:vinext`, main Worker dry-run (`dist/server/wrangler.json`), `test:m12`, `test:rpc-ledger`, `test:d1-shadow-all`, `test:admin-analytics-reads`, `test:search-repository`, `test:article-reads`, `test:p2`, `cloudflare-runtime-boundary`, `test:admin-ops-reads`, `test:reference-reads`, `test:d1-case-catalog`, `test:catalog`, `test:public-regression`, `test:m11` 89/89, `test:m13` 61/61, `test:p3`, `test:ingest-stages`, `test:native-crawler`. No deploy/commit/push/remote DB write/paid LLM call.

## 2026-10-08 operator dead-letter redrive + baseline check stabilization (local code only)

- Implemented audited, operator-safe dead-letter diagnosis/redrive for the staged pipeline:
  - `d1/worldcons_ingest/0004_ingest_stage_redrive.sql`: additive append-only redrive transition ledger.
  - `lib/cloudflare/ingest-stages/redrive.ts`: stage-bounded diagnosis (status counts + oldest lease) and a fenced, reasoned, rate-limited, ledger-audited `redriveIngestStageDeadLetter`. A redrive only returns a job to `pending`; it never completes/publishes and never bypasses a blocked/publication gate.
  - `app/api/admin/ingest/dead-letter/route.ts`: authenticated operator route; no public/unauthenticated redrive route.
  - `tests/ingest-stage-redrive.test.ts` 7/7: 404/429, repeated retries, denied invalid redrive, double-redrive, cross-stage, nonterminal conflict, transition ledger.
- Stabilized the four prior baseline failures verified against the current D1 authority:
  - `test:p3`: bulk path assertion updated to the D1 `RETURNING id` write (`.select("id")`/`persisted?.id` retired); mutation-surface assertion accepts the D1 native writer.
  - `test:d1-case-catalog`: stale fake now includes the P3 enrichment_full/anchor rows the real gate2 predicate reads.
  - `test:reference-reads`: Supabase-env selection test updated to assert Supabase is never re-selected (D1-only authority).
  - `pnpm check`: article-detail assertion updated to the runtime-D1 `force-dynamic` contract.
- Fixed the pre-existing `native-crawler.ts` prefer-const lint error (base commit).
- Verified: typecheck, `pnpm check`, M8 types/typecheck/dry-run, `test:ingest-stages` 49/49, `test:p3` 8/8, `test:d1-case-catalog` 13/13, `test:reference-reads` 10/10, `test:m8` 40/40, `test:m11` 89/89, `test:m13` 61/61, `test:d1-migrate` 18/18. No deploy/commit/push/remote DB write.
- Residual (pre-existing on base, not caused by this change): test:m12 (ops-watchdog soltera URL), test:d1-shadow-all, test:rpc-ledger, test:admin-analytics-reads, test:search-repository, test:article-reads, test:p2, cloudflare-runtime-boundary.

## 2026-10-08 staged pipeline M6 / M7 local reliability (partial)

### 2026-10-08 production deployment and bounded activation

- Pushed 392d850 to main. Deployed worldcons and worldcons-ingest.
- Added seven production stage queues and seven DLQs; applied additive remote ingest/core 0003 migrations.
- Production canary configuration: all seven stages allowed, France as sole scheduled bootstrap source,
  one candidate per daily bootstrap, per-stage dispatch limit one per 15-minute tick. M8 remains active.
- Canary tests 42/42, M8 tests 40/40, Worker typecheck, generated types check and deployment dry-run passed.
- Not a full-volume cutover; baseline release checks and manual DLQ redrive remain outstanding.
- Details: docs/worldcons-staged-ingest-production-canary-20261008.md.

- M6 implemented: transactional D1 batch for parent-success + next-stage job
  registration + stage events; stale/expired leases cannot complete;
  exhausted crashed leases become dead_letter on bounded scan; daily discovery
  and per-record crawl seed a new identity on each UTC day. Physical Queue
  message IDs use the SHA-256 of the full job key to avoid 100-char collisions.
- Fake full-chain test plus crash-injected handoff, stale-fence and budget
  tests: pnpm test:ingest-stages 41/41. M8 40/40, native-crawler 10/10,
  ingest-workflow 16/16, root and Worker TS checks, Wrangler types check and
  dry-run all pass.
- Still blocked: four unrelated baseline release checks
  (test:p3, test:d1-case-catalog, test:reference-reads, pnpm check).
  Permissioned DLQ redrive and remote production verification not done.
- No commit, push, remote DB write, queue creation or deployment. Staged
  feature flags remain disabled. See
  docs/worldcons-staged-ingest-m6-m7-local-verification-20261008.md.

프로젝트 전수 조사 기준으로 발견한 미구현, 부분 구현, 미연결, 오류 가능성, 개선 사항을 모두 처리했다. 이후 긴급 수집 파이프라인 수정 기준으로 공개 가능성 정책을 재정의했고, seed/blocked/timeout/robots_disallowed 데이터가 요약 또는 홈 노출되지 않도록 추가 보강했다. 2026-05-10 재감사에서 빌드/린트 멈춤, 빌드 시점 DB 고정, article diagnostics 오염, 문서상 미완성 표현을 해소했다. 2026-05-16 재전수 조사에서 검색 API 500, Crawlee robots 준수 미연결, lint 루트 스캔 지연, 상세 페이지 캐시 잔존, QPC360 canonical 중복 가능성, JSON-LD script escape 누락, Gemini route false exhaustion, 공개 자료 수동 재요약 UX, DB 기반 이용 통계 화면, 접속 정보 수집, 기본 rate limit까지 완료했다. 2026-05-24 재전수 조사에서 자동 수집/요약 무인운영, 7일 범위 재수집, 기존 원문 리프레시, 미국/독일/프랑스 수집원별 주의사항, 태그 갱신 CLI 종료 오류까지 완료했다. 2026-10-08 단계별 수집 파이프라인 M0~M2(durable stage job schema, stable contract, request validation, indexed dispatcher claim+enqueue/outbox, cross-D1 bridge, stage queue consumer scaffolding)를 로컬 구현·검증했다.

## 2026-10-08 Staged Ingestion Pipeline M0-M2 (local code only)

| ID | Priority | Area | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| SP-01 | P0 | Durable stage schema | stages discovery→crawl→normalize→translate→public-judgment→publish→search를 durable DB source-of-truth로 | `d1/worldcons_ingest/0003_ingest_stage_jobs.sql`에 `ingest_stage_jobs`, `ingest_stage_job_events`, `ingest_stage_dispatch_outbox`, `ingest_core_bridge_outbox` 추가 | Done | 100% |
| SP-02 | P0 | Cross-D1 bridge | 물리적으로 다른 D1 간 transaction 불가 → idempotent/safe bridge | `d1/worldcons_core/0003_ingest_core_bridge_ledger.sql`의 `unique(bridge_key)` ledger + `applyIngestCoreBridgeOnCore` 재적용 no-op | Done | 100% |
| SP-03 | P0 | Stable contract | idempotency key(articleId,stage,sourceVersion,contentHash), ID-only Queue body, request validation | `lib/cloudflare/ingest-stages/contracts.ts` + `flags.ts`(기본 OFF, Production-only, allowlist fail-closed) | Done | 100% |
| SP-04 | P0 | Dispatcher claim | 단일 dispatcher가 단계별 pending/expired-lease만 per-status index/bounded LIMIT으로 claim | `repository.ts` indexed claim + conditional UPDATE fencing, `dispatcher.ts` pass | Done | 100% |
| SP-05 | P0 | Durable outbox | D1→Queue 비원자 enqueue를 outbox로 보존/replay | `outbox.ts` + `reconcileIngestStageDispatch` | Done | 100% |
| SP-06 | P1 | Queue consumers | 단계별 queue bindings + consumer entrypoint scaffolding | `workers/async-pipeline/wrangler.jsonc` 7 stage queue + `ingest-stage-consumer.ts` + Worker `queue` 분기 | Done | 100% |
| SP-07 | P1 | Unit tests | 계약/claim/outbox/bridge/dispatcher/consumer 검증 | `tests/ingest-stage-pipeline.test.ts` 18/18 pass | Done | 100% |

Verification: `tsc --noEmit` pass, `pnpm m8:typecheck` pass, `pnpm m8:types:check` pass, `pnpm m8:dry-run` pass(stage queue 7개 bound), `pnpm test:ingest-stages` 18/18, 기존 `test:m8`, `test:native-crawler`, D1 schema/migrate/apply/provision, `d1-convert/import`, `search-projection-sync`, `summary-drain` 회귀 pass. 기존 M8 consumer/Queue/Cron/데이터/권위는 미변경. `pnpm check`/`pnpm lint` 실패는 base commit에 이미 존재하는 `native-crawler.ts` prefer-const 및 article detail ISR 검사로 이번 변경과 무관함을 stash 비교로 확인.

## 2026-10-08 Staged Ingestion Pipeline M3-M5 (local code only)

M0-M2 감사 결과 발견한 안전성 결함을 수정하고, 실제 단계별 비즈니스 핸들러(Discovery→Crawl→Normalize)와 scheduler/outbox 연결을 구현했다. Feature flag는 기본 OFF 유지, 배포/원격 DB 쓰기/실결제 AI 호출 없음.

| ID | Priority | Area | 발견/요구 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| SM-01 | P0 | Fencing token | claim된 job의 Queue 메시지에 fencing token 부재 → stale worker가 완료 가능 | `IngestStageQueueMessage`에 `fencingToken` 추가·검증, dispatcher가 claim token을 payload에 실어 보냄 | Done | 100% |
| SM-02 | P0 | False-complete | dispatcher가 outbox가 dispatched라는 이유만으로 job을 완료 처리 | dispatcher는 절대 job을 `succeeded`로 만들지 않음. outbox가 현재 fence로 dispatched면 skip, 이전 fence면 re-arm 후 재전송. consumer만 durable completion 수행 | Done | 100% |
| SM-03 | P0 | Lease ownership | consumer가 handler/job 부재·stale token 시 live pending job을 조용히 ack | consumer가 `leased` + 정확한 token일 때만 완료. pending/미소유는 retry, terminal은 ack, token 불일치는 ack(stale), handler 부재는 `handler_missing`으로 명시적 dead_letter | Done | 100% |
| SM-04 | P0 | Next-job fail-closed | 다음 단계 핸들러 미배선인데도 next job을 생성 | `completeStageAndRegisterNext(registerNext)` 추가, consumer는 handle이 있는 다음 단계만 등록. `translate`/`public-judgment`는 무핸들러 → 명시적 block | Done | 100% |
| SM-05 | P0 | Real handlers | 더미 ack/no-op 파이프라인 | `ingest-stage-handlers.ts`: discovery는 공식 listing parser로 후보 fan-out, crawl은 단일 레코드 targeted fetch(전체 국가 크롤 아님), normalize는 audited `persistNativeStageRecord` 경로로 정확히 1건 정규화. metadata_only/unverified origin 자동공개 불가 | Done | 100% |
| SM-06 | P0 | Scheduler wiring | dispatcher scheduled entry/outbox reconciliation 미연결 | `runIngestStageScheduled`(기존 `*/15` cron) + `runIngestStageDiscoveryBootstrap`(기존 `0 21` crawler cron). 신규 cron 미추가(M8 cron 계약 유지), gate OFF면 no-op | Done | 100% |
| SM-07 | P0 | Reconcile queue routing | reconcile가 항상 단일 queue를 사용해 stage 오배송 가능 | `reconcileIngestStageDispatch`가 payload stage별 `queueFor(stage)`로 정확한 물리 queue 선택 | Done | 100% |
| SM-08 | P1 | Targeted crawl | 국가 전체 크롤러를 단일 레코드에 재사용 | `discoverNativeStageCandidates`/`crawlNativeStageCandidate`/`persistNativeStageRecord`를 native-crawler에서 export, crawl handler는 정확히 1개 후보만 fetch. 404/429/5xx/timeout은 bounded retry, robots 불허는 explicit block | Done | 100% |
| SM-09 | P1 | Fake E2E tests | 단계별 isolated fake E2E 필요 | `tests/ingest-stage-handlers.test.ts` 9/9: discovery→crawl→normalize 실제 서비스 연결, duplicate-delivery, handler-missing, lease-expiry/fencing, outbox retry, bootstrap no-network | Done | 100% |
| SM-10 | P2 | Publish/Search adapters | publish/search 핸들러는 실제 adapter 주입 시에만 배선 | `createIngestStageHandlers({publication,search})` 옵션. Worker는 미주입 → fail-closed. 번역/공개 판단은 미배선(의도적) | Partial | 40% |

Verification: `pnpm exec tsc --noEmit` pass, `pnpm m8:typecheck` pass, `pnpm m8:types:check` pass(재생성), `pnpm m8:dry-run` pass(stage queue 7개 bound), `pnpm test:ingest-stages` 27/27(기존 18 + 신규 9), `pnpm test:native-crawler` 10/10, `pnpm test:m8` 40/40, `pnpm test:ingest-workflow` 16/16, D1 schema/migrate/convert/import 회귀 pass. `pnpm exec eslint` 신규 파일 경고 0(잔여 `native-crawler.ts` prefer-const/미사용 경고는 base commit에 이미 존재).

Blocked/Partial: (1) `translate`/`public-judgment` 실제 핸들러는 미배선 — 기존 P3 publication/translation 서비스와의 정확한 per-article 통합 및 실 LLM 없이 검증 가능한 계약 확정 후 진행 필요, 현재는 명시적 dead_letter로 fail-closed. (2) `publish`/`search` 핸들러는 adapter 인터페이스만 제공(Worker 미주입). 이는 무결성 보호를 위한 의도적 fail-closed이며 거짓 완료가 아님. (3) 배포/원격 DB/실 AI 호출은 요구대로 수행하지 않음.

## 2026-10-08 Staged Ingestion Pipeline M4-M5 (translate → public-judgment → publish → search, local code only)

M3까지의 discovery→crawl→normalize 위에 translate→public-judgment→publish→search 단계를 실제 per-article 서비스로 연결했다. Feature flag는 기본 OFF 유지, 원격 DB 쓰기/실 LLM 호출/배포/푸시 없음. 모든 완료 판정은 durable effect 재확인 기반이며, 어느 단계도 거짓 succeeded를 만들지 않는다.

| ID | Priority | Area | 발견/요구 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| SM4-01 | P0 | Canonical identity | normalize가 sourceVersion/hash만 바꾸고 canonical core articleId를 하류로 전달하지 않아 translate 이후가 `native:` 후보 ID를 참조할 수 있음 | `IngestStageHandlerOutcome.nextArticleId` + dispatcher `completeStageAndRegisterNext`/consumer 배선. normalize가 audited persist가 돌려준 verified core UUID를 채택하고, advance 이벤트에 `resolvedArticleId`/`fromArticleId` provenance 기록. persist가 id를 못 풀면 explicit block | Done | 100% |
| SM4-02 | P0 | Translate durable effect | 성공 API 응답만으로는 부족 | worker 서비스 `runSummaryArticle({articleId})` per-item 호출 후 core DB에서 status='summarized'/summary_json/korean_title/translated + verified provenance(content_hash) 재확인. 429/timeout/5xx는 bounded retry, source_only/metadata_only/robots/미검증/비가역 실패는 blocked | Done | 100% |
| SM4-03 | P0 | Public gate | P3/CaseCatalog 권위·공개 gate 우회 금지, partial publication 금지 | `evaluatePublicJudgment`가 summarized+summary+korean title+translation+publishable/verified source text+review state+catalog.sourceOnly를 fail-closed로 검사하고, Case Catalog published head 존재 시 anchor `source_content_hash`==enrichment_full `enrichment_source_content_hash` gate2 조건까지 재사용. 불일치/누락은 dead_letter block | Done | 100% |
| SM4-04 | P0 | Per-article publish | `runD1PublicationDrain(limit 1)`은 전역 all-pending batch라 다른 판례 side effect 위험 | `runD1PublishArticle({articleId})` 추출: 공유 `P3_PUBLICATION_ELIGIBLE_PREDICATE` + 동일 `articlePublicationService.transition`으로 정확히 1건만 published 전이. versionId/state/revision 확정 검증, idempotent(이미 published면 idempotent success), 타 판례 무영향 | Done | 100% |
| SM4-05 | P0 | Per-article search | full `runNativeSearchProjectionSync`는 전체 D1 read | `syncSearchProjectionForArticle`가 동일 gate2 predicate/build/incremental plan/page verify 재사용, 정확히 1 articleId의 search_documents/search_fts를 원자 갱신. eligible 1건/제외 시 0건 무결성 assert, 변경 없으면 no-op. 구현은 `lib/cloudflare/search-projection/d1-sync.ts`로 이동(공유) | Done | 100% |
| SM4-06 | P0 | Worker 배선 | worker가 publish/search adapter 미주입이었음 | `WorldconsOpsService`에 `runPublishArticle`/`runProjectArticle` 추가, `workers/async-pipeline/src/index.ts`가 `WORLDCONS_APP_SERVICE`로 translate/publish/search per-item adapter 주입. public-judgment는 core DB 로컬 gate. 미배선 단계는 여전히 fail-closed | Done | 100% |
| SM4-07 | P1 | Tests | 실제 per-item 서비스 fake SQLite D1/R2 + mock LLM 검증 | `tests/ingest-stage-handlers.test.ts` J~P: 7단계 전 구간 1-case, durable effect 누락 block, metadata_only/미검증 거부, Catalog anchor hash mismatch 차단, ineligible publish block, per-article isolation, duplicate publish idempotent. `tests/ingest-stage-article-services.test.ts`: `runD1PublishArticle` 1건 격리/멱등/ineligible, `syncSearchProjectionForArticle` 1건 projection/멱등/withdraw 제거. 총 37/37 | Done | 100% |
| SM4-08 | P1 | Crash/lease/fencing | dispatcher/consumer fencing·lease·outbox·bridge crash window 유지 검증 | M3 계약 유지: dispatcher는 job을 succeeded로 만들지 않고, consumer만 정확한 fence에서 durable completion. outbox reconcile/next-articleId 재사용 | Done | 100% |

Verification: `pnpm exec tsc --noEmit` pass, `pnpm m8:typecheck` pass, `pnpm m8:types:check` up to date(재생성), `pnpm m8:dry-run` pass(stage queue 7개 + WORLDCONS_APP_SERVICE bound), `pnpm test:ingest-stages` 37/37(J~P 7 추가), `pnpm test:m8` 40/40, `pnpm test:native-crawler` 10/10, `pnpm test:ingest-workflow` 16/16, `summary-drain-d1` 8/8, `m9-search-service`/`m8-async-pipeline` 34/34, `search-projection-sync` 2/2, `test:d1-schema` 19, `test:d1-convert` 10, `test:d1-migrate` 18, `test:d1-provision` 20, `test:d1-apply-schema` 15, `test:d1-search-projection` 15 pass. 신규/변경 파일 eslint error 0(잔여 `native-crawler.ts` prefer-const/미사용 경고는 base HEAD에 이미 존재).

Blocked/Partial: (1) 실 LLM/원격 DB/배포/푸시는 요구대로 미수행 — 실 Gemini·프로덕션 D1/R2 없이 fake service binding + fake SQLite로만 검증. (2) translate는 worker 서비스 응답의 `result.status`를 신뢰하되 반드시 core 재확인으로 이중 검증하며, 실 LLM quota 상황의 실제 retry 타이밍은 배포 환경에서만 관측 가능. (3) `pnpm test:p3`의 `article-publication-p3.test.ts` 1건, `test:d1-case-catalog`, `test:reference-reads`의 실패는 base commit(`git stash` 비교)에 이미 존재하며 이번 변경과 무관함을 확인.

## 2026-05-24 Full Audit Remediation

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| I0-01 | P0 | Automation | 관리자 페이지 수동 실행에 의존하면 수집 후 요약까지 공개 흐름이 끊길 수 있음 | GitHub Actions 일일 수집을 `INGEST_RANGE_DAYS=7`, `INGEST_REFRESH_EXISTING=true`로 고정하고 수집 직후 `summarize-pending`, `refresh-tag-counts`까지 이어지는 무인운영 흐름으로 연결 | Done | 100% |
| I0-02 | P0 | Cron API | `/api/admin/cron/ingest` 기본값이 최신 변경 원문을 다시 확인하지 않으면 자동 cron과 GitHub Actions 동작이 갈라질 수 있음 | cron ingest 기본 range를 7일로 두고 기존 canonical URL도 hash 비교 후 갱신하도록 `refreshExisting` 기본 동작을 맞춤 | Done | 100% |
| I0-03 | P0 | Existing article refresh | 이미 저장된 URL은 중복으로 간주되어 프랑스처럼 소제목/본문 구조가 바뀐 원문이 DB에 반영되지 않을 수 있음 | 기존 article의 `source_content_hash`를 현재 공식 원문 hash와 비교하고 변경 시 원문, cleaned text, metadata를 갱신한 뒤 요약/태그를 비워 재요약 큐로 되돌림 | Done | 100% |
| I0-04 | P0 | France sync | 최신 30일 프랑스 결정 일부가 누락되거나 공식 원문 변경분이 오래된 요약으로 남을 수 있음 | 프랑스 30일 재수집/리프레시를 수행해 신규 3건과 변경 5건을 반영, 총 9건 모두 공식 원문 hash 일치 및 summarized/publishable 상태로 정리 | Done | 100% |
| I0-05 | P0 | France reliability | Conseil/QPC360 접근이 느리거나 타임아웃이 나면 최신 수집이 불안정함 | 프랑스 Crawlee 기본 timeout, retry, same-domain delay, concurrency를 별도 env로 조정 가능하게 하고 7일 dry-run에서 16/16 요청 성공 확인 | Done | 100% |
| I0-06 | P0 | United States scope | 미국 수집에서 명령, 보도자료, 기타 비헌법 의견이 공개 큐에 섞이면 서비스 범위가 흐려짐 | SCOTUS discovery를 공식 slip opinion 목록으로 제한하고, 의견 본문은 헌법 관련성 필터를 통과한 경우에만 저장/요약하도록 보강 | Done | 100% |
| I0-07 | P0 | Germany source split | BVerfG는 목록 탐색과 원문 상세 사이트가 달라 공식 검색 URL/robots 정책을 잘못 쓰면 수집이 실패하거나 차단될 수 있음 | 목록 후보 기준은 `dejure.org` 공개 인덱스로 두고, Open Legal Data API는 항상 가능한 보조 후보로만 취급하며, 원문은 공식 `bundesverfassungsgericht.de` 상세 URL에서 다시 fetch하도록 분리 | Done | 100% |
| I1-01 | P1 | Tag refresh CLI | `pnpm refresh-tag-counts`가 성공 JSON 출력 후 Windows Node `uv async` assertion으로 비정상 종료할 수 있음 | 성공 경로의 강제 `process.exit(0)` 제거, catch는 `process.exitCode=1`로 전환해 열린 Supabase handle 정리를 런타임에 맡김 | Done | 100% |
| I1-02 | P1 | Check CLI | `pnpm check`도 async spider 검증 뒤 강제 종료를 사용해 동일 계열 종료 안정성 위험이 있음 | `scripts/check.ts` 성공 강제 종료를 제거하고 오류 경로만 exit code를 설정하도록 변경 | Done | 100% |
| I1-03 | P1 | Audit hygiene | `TODO`, `미구현`, `추후`, `placeholder`, `mock` 등 검색 결과에 의도된 개발 fallback/입력 placeholder/과거 progress 기록이 섞여 실제 미완성 항목과 구분이 필요함 | 활성 실행 경로 기준으로 blocking unfinished keyword scan을 재실행했고 남은 항목은 README의 의도된 fallback 설명, UI placeholder, 관리자 추천 문구, 과거 완료 기록으로 분류 | Done | 100% |

## 2026-05-24 Full Audit Verification

| Check | Result |
| --- | --- |
| Active blocking unfinished keyword scan over app/components/lib/scripts/workers/README.md/supabase | Pass, 0 matches after excluding intentional placeholder/mock/fallback wording and historical progress records |
| `pnpm refresh-tag-counts` | Pass, database RPC strategy, updatedTags 2666, exit code 0 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` | Pass |
| `pnpm crawl:worker -- --source=us-scotus --limit=20 --range-days=7 --dry-run --no-playwright` | Pass, official slip opinion listing found 3 latest opinions in range |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=20 --range-days=7 --dry-run --no-playwright` | Pass, 14 discovered before range, 3 in 7-day range, 16/16 crawler requests succeeded |
| `pnpm crawl:worker -- --source=de-bverfg --limit=20 --range-days=7 --dry-run --no-playwright` | Pass, Open Legal Data listing returned 0 BVerfG decisions in range with explicit diagnostic |
| France 30-day DB/source reconciliation | Pass, 9/9 current official normalized text hashes match DB and all 9 are summarized + publishable |
| United States 30-day DB/source reconciliation | Pass, 7 rows in range, all summarized + publishable, 7-day refresh found 3 unchanged latest opinions |
| Germany 30-day DB/source reconciliation | Pass, no current 30-day BVerfG decisions found by the configured listing source |
| GitHub Actions automation | Pass, daily workflow now collects each country with a 7-day range, refreshes existing records, summarizes pending rows, and refreshes tag counts |

## 2026-05-16 Full Audit Remediation

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| H0-01 | P0 | Search runtime | `/api/search?q=헌법&mode=hybrid` 및 fulltext가 DB statement timeout으로 500을 반환할 수 있음 | 검색어가 있을 때 대용량 원문 행을 직접 가져오지 않고 `search_vector` GIN 인덱스로 article id를 먼저 좁힌 뒤 상세 행을 조회하도록 변경, 오류 시 빈 결과로 graceful fallback | Done | 100% |
| H0-02 | P0 | Crawler robots | DE/FR Crawlee 경로가 자체 fetch 단계에서 `robots.txt` 확인과 `Crawl-delay` 반영을 직접 수행하지 않아 문서화된 수집 원칙과 어긋날 수 있음 | Crawlee start/detail 요청 전에 `checkRobotsAllowed`를 실행하고 disallow는 queue에서 제외, allowed 진단 기록 및 robots crawl-delay를 `sameDomainDelaySecs`에 반영 | Done | 100% |
| H0-03 | P0 | Gemini routing | `All Gemini routes are exhausted or cooling down`이 실제 무료 한도 소진이 아닌 로컬 추정 RPD, 오래된 Gemini 3 Pro Preview endpoint, 404/모델 미지원 cooldown 때문에 발생할 수 있음 | 기본 route를 `gemini-3.1-flash-lite`/`gemini-3.1-pro-preview` 기준으로 정리, 로컬 RPD 사전 차단을 opt-in으로 변경, 404/모델 미지원과 quota 오류를 분리하고 오류 메시지에 로컬 route 제외 사유 표시 | Done | 100% |
| H0-04 | P0 | Gemini model updates | 향후 Gemini 모델명 또는 모델 자체가 바뀌면 하드코딩된 후보 목록이 다시 stale해질 수 있음 | Gemini `models.list` catalog를 TTL 캐시로 자동 조회하고 `generateContent` 지원 텍스트 모델만 route 후보에 반영, 미래 세대 Flash-Lite/Pro 모델을 task별 우선순위로 자동 정렬 | Done | 100% |
| H1-01 | P1 | Lint/Typecheck reliability | `eslint .` 루트 스캔과 stale `tsconfig.tsbuildinfo`가 Windows 검증 세션에서 장시간 멈춤을 유발할 수 있음 | lint 대상을 실제 소스/설정 파일로 명시하고 TypeScript incremental cache를 비활성화해 검증 명령을 결정적으로 종료 | Done | 100% |
| H1-02 | P1 | Runtime data freshness | article detail page만 `revalidate=300`으로 남아 상세 데이터가 목록/API보다 늦게 갱신될 수 있음 | `/articles/[slug]`를 `force-dynamic` + `revalidate=0`으로 맞춰 요청 시점 DB 데이터를 표시 | Done | 100% |
| H1-03 | P1 | Canonical dedup | QPC360 detail URL의 `searchParams` 문맥 쿼리가 canonical URL에 남아 같은 결정문이 다른 canonical로 저장될 수 있음 | canonical URL 정규화에서 `searchParams`를 제거하고 자체 검사에 회귀 테스트 추가 | Done | 100% |
| H1-04 | P1 | SEO/security | JSON-LD script에 원문 제목/요약이 그대로 들어가면 `</script>`류 문자열이 script boundary를 깨뜨릴 수 있음 | JSON-LD 직렬화 값을 `<`, `>`, `&`, U+2028, U+2029 escape 처리하는 helper로 교체하고 검사 추가 | Done | 100% |
| H1-05 | P1 | Admin UX | 관리자 대시보드 하단의 수집 실행 기록 표가 길어 첫 화면이 과도하게 늘어남 | 수집 실행 기록을 `/admin/ingestion-runs` 전용 화면으로 분리하고 대시보드/실행 기록 상단 탭을 추가, 대시보드 하단 기록 표 제거. 탭은 stale client chunk 예외를 피하도록 일반 anchor navigation으로 고정 | Done | 100% |
| H1-06 | P1 | Admin review UX | 주의가 필요한 자료의 `검토 필요` 뱃지가 클릭되지 않고, 검토 시 확인할 원문/metadata/오류 근거가 한 화면에 부족함 | 주의 목록의 제목/상태 뱃지/검토 버튼을 관리자 상세로 연결하고, 관리자 모드 기사 상세에 수집 사유, 공개 가능 여부, 본문 확보 여부, robots 상태, 오류 metadata, 수집 metadata, 추출 본문 패널 추가 | Done | 100% |
| H1-07 | P1 | Admin review workflow | 검토 화면이 근거만 보여주고 어떤 검토가 필요한지, 검토 후 요약/공개/비공개 결정 절차를 실행하지 못함 | 상태별 검토 유형, 확인 항목, 권장 다음 절차를 표시하고 `/api/admin/review`로 `요약 승인 후 실행`, `재요약 실행`, `검토 완료 후 공개`, `비공개 종결`, `수집원 재시도` 결정 버튼 추가 | Done | 100% |
| H1-08 | P1 | Summary state recovery | 과거 Gemini route 오류 중 `summarizing`으로 바뀐 뒤 완료/실패로 정리되지 않은 3건이 관리자 상태 분포에 계속 `요약중`으로 남음 | 30분 이상 오래된 `summarizing` 자료를 중단된 요약 작업으로 판정해 `failed_summary` 재시도 대상으로 자동 복구하고, 관리자 주의 목록에 stale summarizing을 노출하도록 보강. 현재 DB 3건 복구 완료 | Done | 100% |
| H1-09 | P1 | Admin review resummary UX | 이미 공개된 자료에도 `검토 완료 후 공개` 버튼이 남아 공개 처리와 요약 품질 재검토 동선이 섞임 | 공개 자료에서는 공개 버튼을 숨기고 현재 모델 표시, 모델 preset/직접 입력, `선택 모델로 재요약` 버튼을 추가. 선택 모델은 OpenAI/Gemini 요약 경로와 Gemini route explicit model 옵션까지 연결 | Done | 100% |
| H1-10 | P1 | Admin analytics | 외부 분석 도구 없이 관리자 화면에서 서비스 운영·이용 통계를 직접 확인할 수 없음 | `site_events` 이벤트 테이블, 서버/클라이언트 이벤트 기록, `/admin/analytics` 탭을 추가. 접속 로그, IP/IP hash/User-Agent/지역 헤더, KST 기준 일별·월별 집계, 인기 자료, 검색어 순위, 무결과 검색, 태그 클릭/조회, 국가/기관별 조회, 유입/디바이스, 수집 성공률, 요약 모델별 성공·실패, 관리자 작업, 추천 점검 항목 표시 | Done | 100% |
| H1-11 | P1 | Access control | 접속 컴퓨터별 rate limit을 나중에 적용해야 하므로 접속 로그와 실행 차단 정책의 연결 지점이 필요함 | IP 추출/hash 로직을 공용화하고 공개 조회 API, 이용 통계 이벤트 수집, 관리자 로그인에 IP/fallback 식별자 기준 메모리 rate limit을 적용. 제한값은 환경변수로 조정 가능하며 429 응답에 retry/limit header 제공 | Done | 100% |
| H2-01 | P2 | Crawler cleanup | FR/DE Crawlee list seed에 404 또는 문서상 회피 대상인 검색 URL이 남아 불필요한 요청과 진단 오염이 발생 | France `/decision` 404 및 QPC360 search list URL 제거, BVerfG 대소문자 오류 list URL 제거 | Done | 100% |
| H2-02 | P2 | Audit hygiene | 활성 소스/README/supabase 기준 미완성 키워드와 prompt reference 문서의 과거 개선 문구를 구분해야 함 | 활성 구현 경로만 기준으로 unfinished keyword scan을 재실행해 0건 확인, 과거 prompt 문서는 실행 backlog가 아닌 archive reference로 분류 | Done | 100% |

## 2026-05-16 Full Audit Verification

| Check | Result |
| --- | --- |
| Active unfinished keyword scan over app/components/lib/scripts/workers/README/supabase/config | Pass, 0 matches |
| `pnpm exec tsc --noEmit --pretty false` | Pass |
| `pnpm lint` | Pass, explicit source/config target completes without root-scan timeout |
| `pnpm check` | Pass |
| `pnpm build` | Pass |
| Admin UI split | Pass, `/admin` no longer renders ingestion history table and `/admin/ingestion-runs` owns the detailed run table |
| Browser click `/admin` tab to `/admin/ingestion-runs` | Pass, title `수집 실행 기록`, active tab `실행 기록`, client page error 0 |
| `pnpm audit --prod --audit-level moderate` | Pass, no known vulnerabilities |
| Live robots check | Pass, Conseil/QPC360 and BVerfG allowed paths checked; BVerfG `Crawl-delay: 30` detected |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=cheerio --dry-run --no-playwright` | Pass, robots diagnostics recorded, removed search/404 start URLs absent, 1 verified item |
| `pnpm crawl:worker -- --source=de-bverfg --limit=1 --strategy=cheerio --dry-run --no-playwright` | Pass, robots diagnostics recorded, crawl-delay reflected, removed 404 start URL absent |
| Runtime `/api/articles?pageSize=5` | Pass, HTTP 200, total 693, 5 items |
| Runtime `/api/search?q=헌법&pageSize=5&mode=hybrid` | Pass, HTTP 200, total 50, 5 items |
| Runtime `/api/search?q=헌법&pageSize=5&mode=fulltext` | Pass, HTTP 200 |
| Runtime `/` | Pass, HTTP 200 |
| Runtime `/articles/[firstSlug]` | Pass, HTTP 200, JSON-LD script present |
| Runtime `/sitemap.xml` | Pass, HTTP 200 |
| Runtime `/api/admin/ingestion-runs` without auth | Pass, HTTP 401 |
| Gemini official model status check | Pass, Google docs show `gemini-3.1-flash-lite` stable, `gemini-3.1-pro-preview` current preview, and Gemini 3 Pro Preview shut down on 2026-03-09 |
| Gemini router smoke | Pass, default models start with `gemini-3.1-flash-lite`, 9 local routes available, stale `gemini-3-pro-preview` absent |
| Gemini dynamic catalog regression | Pass, synthetic future catalog routes `gemini-4-flash-lite` first for summary and `gemini-4-pro-preview` first for reasoning while excluding image/embedding models |
| Local server refresh | Pass, rebuilt app restarted on `http://127.0.0.1:3001`, `/` and `/admin/login` return HTTP 200 |
| Admin review link smoke | Pass, `/admin` renders review links and first attention article opens with 관리자 검토 모드, 검토 근거, 수집 metadata |
| Admin review workflow smoke | Pass, first attention detail renders 검토 유형, 권장 다음 절차, 검토 결정, action button; unauthorized review API returns 401; authorized missing review target returns `not_found` |
| Stale summarizing recovery | Pass, recovered 3 stale `summarizing` rows to `failed_summary`; current status counts `summarized=704`, `failed_summary=3`, `summarizing=0` |
| Public admin review resummary smoke | Pass, public summarized article renders 관리자 검토 모드, 공개 자료 재요약, 현재 모델, 선택 모델로 재요약; `검토 완료 후 공개` button count 0 |
| Public admin review browser smoke | Pass, Playwright page load has Application error 0 and console/page errors 0 |
| Admin review resummary API guard | Pass, authorized `resummarize-with-model` without model returns skipped with 모델 선택 안내 and does not call LLM |
| Admin analytics route | Pass, `/admin/analytics` added as a separate admin tab with DB-backed usage and operations statistics |
| Admin analytics browser smoke | Pass, `/admin/analytics` renders 이용 통계/접속 로그 with Application error false and console/page error 0 |
| Access info migration | Pass, `site_events`에 IP/IP hash/User-Agent/Accept-Language/지역/bot 컬럼과 index 적용, smoke insert로 저장 확인 |
| Runtime rate limit smoke | Pass, test server with low limits returned public API `200,200,429`, analytics event `204,429`, admin login `401,429` |

## 2026-05-10 Full Audit Remediation

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| F0-01 | P0 | Build/Lint | `pnpm lint`와 `pnpm build`가 Windows/Node 세션에서 생성물 추적 중 멈출 수 있음 | ESLint ignore와 Next output tracing exclude에 `.cache`, `.crawlee-storage`, cache/report/tsbuildinfo 산출물 제외 추가 | Done | 100% |
| F0-02 | P0 | Data visibility | 홈/목록/API/sitemap이 빌드 시점 DB 읽기에 묶이면 신규 수집 데이터가 안 보이거나 build가 지연될 수 있음 | DB 의존 page, API route, sitemap을 `force-dynamic` + `revalidate=0`으로 명시해 요청 시점 데이터 표시로 전환 | Done | 100% |
| F0-03 | P0 | Article metadata | 수집 실행 단위 diagnostics가 개별 article metadata에 누적되어 다른 판례 URL이 섞일 수 있음 | fetch별 diagnostics collector를 분리하고 실행 전체 diagnostics에는 별도 병합하도록 수정, 기존 DB 105행에서 무관 diagnostics 1,915개 제거 | Done | 100% |
| F0-04 | P0 | Runtime data | 사용자가 제기한 “데이터가 표시되지 않음” 가능성 확인 필요 | 로컬 `next start` API/홈/sitemap/search smoke로 공개 데이터 105건, 홈페이지 실제 제목 표시, 빈 상태 미표시 확인 | Done | 100% |
| F1-01 | P1 | Collection CLI | 기간 수집 스크립트가 package script에 연결되지 않아 운영자가 명령을 찾기 어려움 | `collect:range` script 추가 | Done | 100% |
| F1-02 | P1 | Cleanup | README/mock 문구에 `임시`, `추후` 등 미완성처럼 보이는 표현 잔존 | seed fallback과 개발용 대체 요약 문구를 의도된 운영/개발 fallback 설명으로 정리 | Done | 100% |
| F1-03 | P1 | Data quality | 2026 수집 데이터의 중복, 공개 가능성, 요약 상태 재확인 필요 | 2026-01-01 이후 DB 107건 집계, 공개/요약 105건, 비공개 SCOTUS 2건은 헌법 관련성 미충족 `needs_review`로 의도적 제외, canonical 중복 0건 확인 | Done | 100% |
| F2-01 | P2 | Security | 최신 prod dependency 취약점 재확인 필요 | `pnpm audit --prod --audit-level moderate` 재실행, known vulnerability 0건 확인 | Done | 100% |

## 2026-05-10 Collection/Data Snapshot

| Source | Country | Total Rows | Public/Summarized | Needs Review | Raw Bytes | Cleaned Bytes | Duplicate Canonical URLs | Date Range |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `us-scotus` | United States | 27 | 25 | 2 | 1,935,927 | 1,935,927 | 0 | 2026-01-08 to 2026-04-28 |
| `de-bverfg` | Germany | 47 | 47 | 0 | 323,781 | 323,781 | 0 | 2026-01-08 to 2026-04-17 |
| `fr-conseil-constitutionnel` | France | 33 | 33 | 0 | 540,435 | 540,435 | 0 | 2026-01-30 to 2026-05-07 |
| Total | US/DE/FR | 107 | 105 | 2 | 2,800,143 | 2,800,143 | 0 | 2026-01-08 to 2026-05-07 |

## 2026-05-10 Full Audit Verification

| Check | Result |
| --- | --- |
| `rg` unfinished keyword scan over app/components/lib/scripts/workers/README | Pass, 0 matches |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` | Pass |
| `pnpm audit --prod --audit-level moderate` | Pass, no known vulnerabilities |
| `pnpm summarize-pending -- --limit=100` | Pass, summarized 0, failed 0, skipped 0 |
| `pnpm refresh-tag-counts -- --delete-orphans` | Pass, client aggregate, updatedTags 565 |
| DB diagnostics cleanup | Pass, scanned 107 rows, updated 105 rows, removed 1,915 off-topic attempts, contaminated rows after cleanup 0 |
| Runtime `/api/articles?pageSize=5` | Pass, total 105, 5 items, first source `fr-conseil-constitutionnel` |
| Runtime `/api/articles?pageSize=100&source=de-bverfg` | Pass, 47 items, 2026-01-08 to 2026-04-17 |
| Runtime `/api/sources` | Pass, 3 sources |
| Runtime `/api/tags?sort=count` | Pass, 565 tags |
| Runtime `/api/search?q=헌법소원&pageSize=5&mode=fulltext` | Pass, total 46, 5 items |
| Runtime `/` | Pass, HTTP 200, article title rendered, empty state absent |
| Runtime `/sitemap.xml` | Pass, HTTP 200, 100 article URLs and 565 tag URLs |

## 2026-05-10 2025 Range Collection

| Source | Country | Rows Collected | Publishable Source Text | Summarized | Summary Retry Pending | Needs Review | Raw Bytes | Cleaned Bytes | Duplicate Canonical URLs | Date Range |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `us-scotus` | United States | 66 | 62 | 54 | 8 | 4 | 5,368,134 | 5,368,134 | 0 | 2025-01-14 to 2025-12-07 |
| `de-bverfg` | Germany | 223 | 223 | 222 | 1 | 0 | 2,851,506 | 2,851,506 | 0 | 2025-01-13 to 2025-12-30 |
| `fr-conseil-constitutionnel` | France | 309 | 309 | 38 | 271 | 0 | 2,962,949 | 2,962,949 | 0 | 2025-01-10 to 2025-12-30 |
| Total | US/DE/FR | 598 | 594 | 314 | 280 | 4 | 11,182,589 | 11,182,589 | 0 | 2025-01-10 to 2025-12-30 |

Collection policy: source collection was sequential, Playwright disabled, retry disabled for range jobs, duplicate canonical URLs excluded, SCOTUS used official slip opinion listings for terms 24/25, BVerfG avoided `/SiteGlobals/` and respected official `Crawl-delay: 30`, France used official sitemap URLs and avoided `/recherche/`.

Summary note: source collection is complete. AI summarization stopped after Gemini quota/cooldown errors; remaining `failed_summary` rows are retryable by `pnpm summarize-pending` when quota is available.

## 2026-05-09 Full Audit Remediation

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| A0-01 | P0 | Admin auth | production에서 `CRON_SECRET`이 비어 있으면 `Authorization: Bearer undefined`로 관리자 API/페이지 인증이 통과할 수 있음 | secret이 존재할 때만 bearer/query secret 비교, production misconfig는 항상 거부하도록 인증 경계 수정 | Done | 100% |
| A0-02 | P0 | Public article access | 목록은 publishable만 노출하지만 `/articles/[slug]`와 `/api/articles/[slug]`는 slug 직접 접근 시 non-publishable row를 보여줄 수 있음 | 상세 조회 기본값을 summarized + `collection.publishable=true`로 제한하고 내부 옵션으로만 unpublished 허용 | Done | 100% |
| A0-03 | P0 | France crawler seed policy | 프랑스 Crawlee seed fallback이 seed URL을 article row로 만들 수 있어 “seed는 후보만 저장” 정책과 불일치 | QPC360 seed를 `source_url_candidates` 후보로만 저장하고 seed article fallback 비활성화 | Done | 100% |
| A1-01 | P1 | Dependency security | `pnpm audit --prod`에서 `file-type` 2건, `postcss` 1건 moderate 취약점 발견 | package override와 lockfile 갱신으로 `file-type >=21.3.2`, `postcss >=8.5.10` 고정 | Done | 100% |
| A1-02 | P1 | SEO config | `APP_BASE_URL` 미설정 production에서 sitemap/robots/canonical URL이 localhost로 생성될 수 있음 | `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL` fallback과 trailing slash normalization 추가 | Done | 100% |
| A1-03 | P1 | Admin API input | 관리자 ingest/runs limit 값이 음수, NaN, 과대값일 때 불필요한 부하나 예측 불가 동작 가능 | 관리자 숫자 입력을 정수 범위로 clamp하는 공용 helper 추가 및 API 적용 | Done | 100% |
| A1-04 | P1 | Crawler dry-run | `crawl:worker -- --dry-run --strategy=seed`가 seed 후보를 실제 DB에 저장할 수 있음 | `SourceDiscoveryOptions.dryRun` 추가, dry-run 후보 저장은 diagnostics만 남기고 DB write 금지 | Done | 100% |

## 2026-05-09 Full Audit Verification

| Check | Result |
| --- | --- |
| `pnpm check` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm audit --prod --audit-level moderate` | Pass, no known vulnerabilities |
| `pnpm build` | Pass |

## 2026-05-09 BVerfG 2026 Continued Collection Progress

| ID | Priority | Area | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| G1-01 | P0 | BVerfG 2026 continued collection | 독일 2026년 결정을 계속 수집 | BVerfG 검색 페이지는 사용하지 않고, `dejure.org`를 기준 목록 인덱스로 삼아 사건번호를 확인하며 Open Legal Data는 가능한 보조 후보로만 참고한 뒤 공식 `/SharedDocs/Entscheidungen/...` 상세 URL만 수집 | Done | 100% |
| G1-02 | P0 | Rechtsprechung im Internet | 사용자가 제시한 `rechtsprechung-im-internet.de` 수집 가능성 확인 | `robots.txt`가 일반 User-agent에 `Disallow: /`를 선언하고 `DG_JUSTICE_CRAWLER` 전용 sitemap만 노출하므로 직접 수집원으로 사용하지 않음 | Done | 100% |
| G1-03 | P0 | Bad URL guard | 추정 공식 URL이 404일 때 row 삽입 방지 | `sourceUrlVerified=false` 또는 `HTTP Status ...` 제목인 BVerfG 결과는 삽입 전 제외하도록 range collector 보강 | Done | 100% |
| G1-04 | P0 | Data cleanup | 잘못 들어간 404 후보 제거 | `rk20260427_2bvr067126.html` needs_review row 삭제 | Done | 100% |
| G1-05 | P0 | Summary completion | 신규 독일 본문 요약 완료 | 독일 2026 범위 47건 전부 `summarized` 및 `publishable=true` 확인 | Done | 100% |
| G1-06 | P1 | Tag refresh reliability | Supabase `refresh_tag_counts` RPC 대기 문제 회피 | tag count 갱신을 client-side aggregate 방식으로 전환하고 summarize batch 마지막에 1회 갱신하도록 변경 | Done | 100% |
| G1-07 | P1 | CLI exit reliability | check/summary/tag CLI가 열린 handle로 매달리지 않음 | `check`는 spider 검증 timeout 방어, tag refresh/summarize CLI 종료 안정화 | Done | 100% |

## 2026-05-09 BVerfG 2026 Continued Verification

| Check | Result |
| --- | --- |
| `rechtsprechung-im-internet.de/robots.txt` | 일반 User-agent `Disallow: /`, 직접 수집 미사용 |
| `pnpm exec tsx scripts/collect-range.ts --sources=de-bverfg --from=2026-01-01 --to=2026-05-09 --bverfg-use-dejure-index --bverfg-dejure-pages=2` | Pass, discovered 62, attempted 57, inserted 43, duplicate 11, out-of-range 3, failed 0 |
| 404 cleanup | 1건 삭제, 최종 bad candidate 0건 |
| DB BVerfG rows `2026-01-01..2026-05-09` | 47건, raw 323,781 bytes, cleaned 323,781 bytes |
| DB BVerfG publishable/summarized | 47/47 publishable, 47/47 summarized |
| DB date range | 2026-01-08부터 2026-04-17까지 |
| `pnpm summarize-pending -- --limit=100` | Pass, summarized 0, failed 0, skipped 0 |
| `pnpm refresh-tag-counts -- --delete-orphans` | Pass, client aggregate, updatedTags 565 |
| Runtime smoke `http://127.0.0.1:3001/api/articles?pageSize=100&source=de-bverfg` | Pass, 47 items |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass on 2026-05-10 after generated storage/cache ignores |
| `pnpm build` | Pass on 2026-05-10 after generated storage/cache excludes and dynamic DB routes |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=seed --dry-run --no-playwright` | Pass, discovered 0 article rows, `SOURCE_URL_CANDIDATES_DRY_RUN` |
| `pnpm crawler:run -- --source=fr-conseil-constitutionnel --limit=500 --strategy=seed --debug` | Pass, limit clamped and seed candidates only |
| Runtime smoke `http://127.0.0.1:3001` | `/`, `/api/articles`, `/api/search`, `/api/sources`, `/robots.txt`, `/sitemap.xml` 200; `/api/admin/ingestion-runs` 401 |

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | P0 | AI summary | LLM completion이 없을 때 DB에 개발용 mock summary가 저장될 수 있음 | `ALLOW_MOCK_SUMMARY=true`일 때만 mock 저장, mock metadata 명시, 실제 실패는 `failed_summary` 유지 | Done | 100% |
| P0-02 | P0 | Search | `/api/search?mode=semantic|hybrid`가 mode를 반환만 하고 실제 분기하지 않음 | API와 `/search` UI 모두 fulltext/semantic/hybrid 분기 연결, 실패 시 graceful fallback | Done | 100% |
| P0-03 | P0 | Search | 검색 대상이 요약 JSON, 태그, 국가/기관, 조문까지 충분히 포함되지 않음 | 제목, 요약 JSON, 원문, URL, 국가, 기관, 태그명/정규명/유형까지 검색 대상 확장 | Done | 100% |
| P0-04 | P0 | API | `/api/sources`, `/api/sources/[sourceKey]`, `/api/admin/ingestion-runs` 미구현 | 세 API 추가, admin runs는 bearer와 `?secret=` 인증 적용 | Done | 100% |
| P0-05 | P0 | Ingest | 독일/프랑스 어댑터가 현재 공식 사이트 구조 또는 차단 상황에서 0건이 되기 쉬움 | fetch retry/header/Playwright fallback, 공식 URL 패턴 보강, QPC360 경로, BVerfG numbered fallback, DE/FR 날짜 파싱 추가 | Done | 100% |
| P0-06 | P0 | Ingest | 수집 파이프라인이 DB `sources.is_active`를 반영하지 않음 | Supabase 연결 시 active source만 기본 실행 | Done | 100% |
| P0-07 | P0 | Dedup | 중복 제거가 canonical URL 중심이라 title/date/hash 중복 방지가 약함 | source별 content hash와 title/date 중복 확인 추가 | Done | 100% |
| P0-08 | P0 | Detail UI | 상세 페이지에 보존 원문 스냅샷, risk flag, 요약 상태 정보가 부족함 | 상태, 읽기 시간, 검수 신호, 보존 원문 스냅샷 표시 | Done | 100% |
| P1-01 | P1 | Admin | 관리자 페이지 인증이 브라우저 쿼리 secret을 지원하지 않음 | admin 페이지 `?secret=` 허용 및 내부 링크 secret 유지 | Done | 100% |
| P1-02 | P1 | Cron/Admin | cron/admin ingest가 요약 limit/태그 갱신 옵션이 제한적 | `CRON_SUMMARY_LIMIT`, admin body의 `summarize`, `summarizeLimit`, `refreshTags` 지원 | Done | 100% |
| P1-03 | P1 | Embedding | embedding abstraction이 OpenAI 전용이고 검색용 query embedding helper가 없음 | `createTextEmbedding` 추가, semantic search 연결, embedding 부재 시 요약 실패하지 않도록 처리 | Done | 100% |
| P1-04 | P1 | Date parsing | 독일/프랑스 날짜 문자열 파싱 지원이 부족함 | `dd.MM.yyyy`, French/German long month date 파싱 추가 | Done | 100% |
| P1-05 | P1 | Filters | UI/API 필터에 원문 언어 필터가 없음 | 목록, 검색, `/api/articles`, `/api/search`에 language 필터 연결 | Done | 100% |
| P1-06 | P1 | Pagination | 목록/검색 페이지에 페이지 이동 UI가 없음 | 공용 pagination 컴포넌트 추가 및 쿼리 유지 | Done | 100% |
| P1-07 | P1 | Glossary | DB migration에 용어사전 초기 seed가 없어 DB 환경에서 빈 페이지가 됨 | 핵심 용어 seed migration 추가 및 현재 DB upsert 적용 | Done | 100% |
| P1-08 | P1 | SEO | sources/glossary/list pages 일부 metadata가 기본값에 의존 | sources, source detail, tags, glossary metadata/canonical 보강 | Done | 100% |
| P1-09 | P1 | Sitemap | sitemap article limit이 100으로 제한됨 | article sitemap 상한 1000으로 확대 | Done | 100% |
| P2-01 | P2 | Docs | README가 mock summary 동작, Gemini, 브랜드명, API 범위와 일부 불일치 | README 전면 최신화 | Done | 100% |
| P2-02 | P2 | Tests | `pnpm check`가 새 날짜/필터/Gemini/mock metadata 동작을 검증하지 않음 | check coverage 확장 | Done | 100% |
| P2-03 | P2 | Tag maintenance | orphan tag 정리 옵션이 없음 | `refresh-tag-counts -- --delete-orphans` 추가 및 실행 | Done | 100% |
| P2-04 | P2 | Cleanup | placeholder 검색 함수와 문서 불일치가 남아 있음 | 실제 semantic/hybrid 함수로 교체, README placeholder 설명 제거 | Done | 100% |

## Verification

| Check | Result |
| --- | --- |
| `pnpm check` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |
| DB summary smoke | 총 15건, 미국 5건, 독일 5건, 프랑스 5건, summarized 0건, publishable 0건, 홈 노출 0건 |
| DB glossary seed | 4건 |
| Runtime smoke | `/`, `/api/search`, `/api/sources`, `/api/admin/ingestion-runs` 200 |

## Crawler/Scraper Layer Progress

| ID | Priority | Requirement | Status | Progress |
| --- | --- | --- | --- | --- |
| C0-01 | P0 | 공통 crawler 타입과 `CrawlRequest`/`CrawlResponse`/diagnostics 인터페이스 | Done | 100% |
| C0-02 | P0 | HTTP client timeout, retry, headers, redirect, status diagnostics | Done | 100% |
| C0-03 | P0 | Playwright fallback client와 concurrency guard | Done | 100% |
| C0-04 | P0 | link/readable text/metadata extractor | Done | 100% |
| C0-05 | P0 | robots.txt 확인과 disallow 시 robots_disallowed/비공개 경로 | Done | 100% |
| C0-06 | P0 | sitemap fallback과 source별 keyword filtering | Done | 100% |
| C0-07 | P0 | BVerfG RSS/fetch/Playwright/sitemap/seed 단계형 discovery | Done | 100% |
| C0-08 | P0 | Conseil/QPC360 RSS/fetch/Playwright/sitemap/seed 단계형 discovery | Done | 100% |
| C0-09 | P0 | seed fallback metadata warning과 collection confidence 저장 | Done | 100% |
| C0-10 | P0 | ingestion_runs.metadata diagnostics 저장 | Done | 100% |
| C1-01 | P1 | `pnpm ingest -- --debug --strategy=...` CLI 옵션 | Done | 100% |
| C1-02 | P1 | `pnpm crawl:diagnose` 진단 명령 | Done | 100% |
| C1-03 | P1 | `/admin/ingestion-runs` diagnostics 표시 | Done | 100% |
| C1-04 | P1 | 상세 페이지 collection strategy/confidence 표시 | Done | 100% |
| C1-05 | P1 | README crawler troubleshooting 섹션 | Done | 100% |
| C1-06 | P1 | Gemini task routing이 `provisions` 문자열을 vision 작업으로 오분류할 수 있음 | Done | 100% |
| C1-07 | P1 | `needs_review` 저신뢰 수집본이 요약 재시도 후 `summarized`로 바뀔 수 있음 | Done | 100% |
| C1-08 | P1 | 메인 화면을 국가 그룹이 아닌 시간순 10건 단위 목록으로 고정 | Done | 100% |

## Crawler Verification

| Check | Result |
| --- | --- |
| `pnpm crawl:diagnose -- --source=de-bverfg` | Pass |
| `pnpm crawl:diagnose -- --source=fr-conseil-constitutionnel` | Pass |
| `pnpm crawl:diagnose -- --source=us-scotus` | Pass |
| `pnpm ingest -- --source=us-scotus --limit=5 --debug` | Pass |
| `pnpm ingest -- --source=de-bverfg --limit=5 --debug` | Pass, timeout diagnostics와 seed fallback 기록 |
| `pnpm ingest -- --source=fr-conseil-constitutionnel --limit=5 --debug` | Pass, timeout/403 diagnostics와 seed fallback 기록 |
| Data reset and reprocess | Pass, 미국 5건/독일 5건/프랑스 5건 총 15건 |
| Gemini summary processing | Emergency policy applied, source_text 미확보/seed/blocked/timeout/robots_disallowed 데이터는 요약 대상에서 제외 |
| Main listing query | Pass, `pageSize=10`, `original_published_at desc nulls last` 시간순 |
| Article collection metadata | 15/15 articles have `collection.strategy` |

## Emergency Crawler Pipeline Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| E0-01 | P0 | `needs_review`, `failed_fetch`, `failed_summary`, `seed`, `robots_disallowed`, `metadata_only`, `blocked`, `timeout`을 정상 기사로 취급하지 않음 | `canSummarizeArticle`, `isPublishableListItem`, `deriveCollectionStatus`, `finalizeCollectionMetadata` 추가 | Done | 100% |
| E0-02 | P0 | publishable 조건을 공식 URL, 원문 확보, robots 준수, 충분한 cleaned_text, seed 제외, summarized 상태로 제한 | ingest insert, summarize pending, 목록 query, semantic search 필터에 `collection.publishable=true` 적용 | Done | 100% |
| E0-03 | P0 | 새 상태 `metadata_only`, `robots_disallowed`, `blocked`, `timeout` 추가 | DB 타입, migration, UI status label, ingestion diagnostics count 반영 | Done | 100% |
| E0-04 | P0 | seed fallback은 후보 저장만 하고 요약/홈 노출 금지 | seed URL은 `source_url_candidates` 재시도 후보로 저장하고 article row 생성/요약/홈 노출을 금지 | Done | 100% |
| E0-05 | P0 | SCOTUS PDF robots disallow는 fetch/summary 금지 | SCOTUS listing은 official PDF URL만 보존하고 robots disallow collection metadata와 비공개 상태 기록 | Done | 100% |
| E0-06 | P0 | Admin diagnostics에서 실패 원인과 counts 표시 | ingestion status panel에 publishable, metadata, robots, blocked, timeout, seed counts 추가 | Done | 100% |
| E0-07 | P1 | crawler worker 명령 체계 추가 | `crawler:run`, `crawler:diagnose`, `crawler:bverfg`, `crawler:conseil`, `crawler:qpc360`, `crawler:scotus` 추가 | Done | 100% |
| E0-08 | P1 | Supabase migration 준비 | `20260509000000_publishable_collection_policy.sql` 추가, initial/search migrations도 공개 가능 조건으로 보강 | Done | 100% |

## Emergency Pipeline Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass, publishable/seed summarization guard 포함 |
| `pnpm build` | Pass |
| `pnpm crawler:diagnose -- --source=us-scotus --limit=1 --strategy=auto` | Pass, official listing 후보는 `metadata_only_candidate`, `publishable=false` |
| Current DB article rows | 총 15건, 미국 5건/독일 5건/프랑스 5건 |
| Current DB publishable rows | 0건 |
| Current DB summarized rows | 0건 |
| Current home listing query | `pageSize=10`, `total=0` |
| SCOTUS current collection status | 5건 robots disallowed, summary cleared |
| BVerfG current collection status | 5건 timeout + seed fallback, summary cleared |
| Conseil current collection status | 5건 blocked + seed fallback, summary cleared |
| Remote DB status compatibility | Supabase direct migration은 현재 실행 환경의 IPv6 DB 접속 제한으로 미적용, 실제 row status는 legacy `needs_review`로 유지하고 fine-grained status는 metadata에 보존 |

## BVerfG Timeout Diagnostics Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| B0-01 | P0 | timeout phase를 DNS/TCP/TLS/header/body/Playwright 등으로 분리 | `lib/crawler/network-diagnostics.ts` 추가, `crawler:diagnose -- --source=de-bverfg --debug`에 phase별 출력 연결 | Done | 100% |
| B0-02 | P0 | IPv4 우선 실행 지원 | `applyIpv4FirstForSource`, `BVERFG_USE_IPV4_FIRST=true`, worker/ingest CLI 적용 | Done | 100% |
| B0-03 | P0 | BVerfG sitemap-first discover | BVerfG config `preferSitemap=true`, sitemap detail fetch 후 Playwright fallback, list parsing은 fallback | Done | 100% |
| B0-04 | P0 | 보수적 크롤링 기본값 | `BVERFG_CRAWL_DELAY_MS=3000`, `BVERFG_TIMEOUT_MS=60000`, `BVERFG_MAX_CONCURRENCY=1`, `BVERFG_RETRY_COUNT=2` 기본 적용 | Done | 100% |
| B0-05 | P0 | seed를 article이 아닌 재시도 후보로 저장 | `source_url_candidates` migration/helper 추가, BVerfG seed article fallback 비활성화 | Done | 100% |
| B0-06 | P1 | 관리자 diagnostics에 timeout/action 노출 | timeout phase, text length, recommended action 표시 추가 | Done | 100% |

## BVerfG Timeout Verification

| Check | Result |
| --- | --- |
| `pnpm crawler:diagnose -- --source=de-bverfg --debug` | Pass, 현재 환경 DNS IPv4 resolved, IPv6 DNS failed, IPv4 TCP connect timeout, robots/sitemap/detail 미확보 |
| `pnpm crawl:worker -- --source=de-bverfg --limit=1 --strategy=auto --dry-run --no-playwright` | Pass, discovered 0, seed article 생성 없음, seed는 `source_url_candidates` 후보 저장 시도 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |

## External Crawlee Layer Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| X0-01 | P0 | TypeScript 기반 Crawlee 도입 | `crawlee@3.16.0` 추가, `lib/crawlee/*` spider 계층 구성 | Done | 100% |
| X0-02 | P0 | CheerioCrawler와 PlaywrightCrawler 모두 사용 | 공통 runner에서 CheerioCrawler 기본 수집, PlaywrightCrawler 렌더링 fallback 구현 | Done | 100% |
| X0-03 | P0 | 독일 BVerfG 전용 spider | `lib/crawlee/bverfg-spider.ts` 추가, 결정 URL 필터/본문 selector/seed 판례 정의 | Done | 100% |
| X0-04 | P0 | 프랑스 Conseil constitutionnel/QPC360 전용 spider | `lib/crawlee/france-spider.ts` 추가, Conseil/QPC360 목록/결정 필터/seed 정의 | Done | 100% |
| X0-05 | P0 | RequestQueue, retry, rate limit, diagnostics, sitemap fallback | RequestQueue 기반 pass, max retries, same-domain delay, timeout, sitemap fallback diagnostics 저장 | Done | 100% |
| X0-06 | P0 | 기존 SourceAdapter wrapper 유지 | 독일/프랑스 SourceAdapter를 Crawlee spider 호출 wrapper와 raw cache로 교체 | Done | 100% |
| X0-07 | P0 | seed fallback 최후 수단 유지 | live discovery 실패 시 seed URL을 article row가 아닌 재시도 후보로 저장하는 최후 수단으로 유지 | Done | 100% |
| X0-08 | P0 | collection.strategy/confidence/diagnostics 저장 | raw metadata에 collection, confidence, diagnostics, crawlee transport 기록 | Done | 100% |
| X0-09 | P0 | crawler worker를 Next.js 요청 처리와 분리 | `pnpm crawl:worker` CLI 추가, Vercel inline crawling 기본 차단 | Done | 100% |
| X0-10 | P0 | Vercel 함수가 아닌 별도 worker/GitHub Actions/Cloud Run/Apify 설계 | `.github/workflows/crawlee-worker.yml` 추가, README 운영 지침 반영 | Done | 100% |

## External Crawlee Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` | Pass |
| `pnpm crawl:worker -- --source=de-bverfg --limit=1 --strategy=seed --dry-run --no-playwright` | Pass, BVerfG 공식 사이트 timeout diagnostics와 seed metadata fallback 기록 |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=seed --dry-run --no-playwright` | Pass, QPC360 403 diagnostics와 seed metadata fallback 기록 |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=playwright --dry-run --use-playwright` | Pass, 브라우저 미설치 환경에서 PlaywrightCrawler launch diagnostics 기록 |

## 2026-05-09 Data Quality Repair Progress

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| D0-01 | P0 | BVerfG URL filter | 독일 수집기가 `/DE/Aktuelles/GeplanteEntscheidungen`, `/DE/Entscheidungen/EntscheidungFinden` 같은 안내/목록 페이지를 결정문으로 오인 | BVerfG 후보 URL을 `/SharedDocs/Entscheidungen/(DE|EN)/YYYY/MM/*.html` 실제 결정문 패턴으로 제한하고 broad selector/sitemap keyword 제거 | Done | 100% |
| D0-02 | P0 | BVerfG latest ordering | 공식 최신 결정 `2026-04-17 2 BvQ 26/26` 대신 2015/2013 목록 페이지가 상위로 적재됨 | sitemap-first를 중단하고 공식 결정 검색 페이지를 우선 사용, seed도 2026년 4월 최신 공식 결정 5건으로 갱신 | Done | 100% |
| D0-03 | P0 | Date metadata | `2 BvR 1535` 같은 사건번호가 날짜로 오인되어 최신순 정렬과 발행일이 깨질 수 있음 | 공통 HTML metadata 날짜 추출을 실제 월명 목록 기반으로 제한하고 title/meta title 우선 추출로 수정 | Done | 100% |
| D0-04 | P0 | Dedup | 같은 날 같은 제목(`Beschluss vom 13. April 2026`)의 서로 다른 BVerfG 결정이 title+date dedup에 의해 누락됨 | 사건번호가 있으면 title+date+caseNumber 기준으로만 중복 처리하고, BVerfG generic title은 title+date 단독 dedup 제외 | Done | 100% |
| D0-05 | P0 | Publishability | 공식 원문이 짧은 결정문(예: 867자)이 `metadata_only`로 잘못 비공개 처리됨 | publishable/sourceTextAvailable 기준을 500자 이상으로 조정하고 fetch/Crawlee/summary guard에 동일 기준 적용 | Done | 100% |
| D0-06 | P0 | France URL filter | 프랑스 수집기에 `affaires-en-instances` 계류 안내 페이지가 결정문으로 섞임 | Conseil 후보를 `/decision/YYYY/*.htm(l)` 및 QPC360 `/YYYY-MM-DD/decision-*` 실제 결정문 경로로 제한 | Done | 100% |
| D0-07 | P0 | France metadata | Conseil 공식 결정 페이지의 숨은 검색 h1(`Rechercher sur le site`)과 오래된 footer 날짜가 제목/날짜로 추출될 수 있음 | `h1.title`, `og:title`, page title 우선순위를 적용해 결정 제목과 발행일을 안정적으로 추출 | Done | 100% |
| D0-08 | P0 | DB data | 기존 독일 5건과 프랑스 5건에 잘못된/구버전 row가 포함됨 | 독일/프랑스 article row 및 연결 태그 삭제 후 수정된 수집기로 각 5건 재수집, pending 10건 요약, 태그 카운트 갱신 | Done | 100% |

## 2026-05-09 Data Quality Repair Verification

| Check | Result |
| --- | --- |
| Official BVerfG verification | 공식 검색 페이지에서 `2026-04-17 2 BvQ 26/26` 확인, 수집 URL `qk20260417_2bvq002626.html` |
| `pnpm crawl:worker -- --source=de-bverfg --limit=5 --strategy=auto --dry-run --no-playwright` | Pass, 2026-04-17/16/13/13/10 공식 BVerfG 결정문 5건 |
| `pnpm crawler:run -- --source=de-bverfg --limit=5 --strategy=auto --debug --no-playwright` | Pass, fetched 5, skipped 0, `cleaned` 5, publishable 5 |
| Official France verification | Conseil `/decisions` 최신 결정 2026-05-07 2건, 2026-04-30 3건 확인 |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=5 --strategy=auto --dry-run --no-playwright` | Pass, `affaires-en-instances` 제외, 공식 Conseil 결정문 5건 |
| `pnpm crawler:run -- --source=fr-conseil-constitutionnel --limit=5 --strategy=auto --debug --no-playwright` | Pass, fetched 5, skipped 0, `cleaned` 5, publishable 5 |
| `pnpm summarize-pending -- --limit=10` | Pass, 독일 5건 + 프랑스 5건 요약 완료, failed 0 |
| `pnpm refresh-tag-counts -- --delete-orphans` | Pass |
| DB current rows | 총 15건, 미국 5건/독일 5건/프랑스 5건 |
| DB current visible rows | 15/15 `summarized` + `collection.publishable=true` |
| Runtime smoke `http://127.0.0.1:3001/api/articles?pageSize=20` | Pass, 15건 반환 |
| `pnpm check` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |

## 2026-05-09 BVerfG Detail-Only Collection Progress

| ID | Priority | Area | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| G0-01 | P0 | BVerfG robots compliance | `/SiteGlobals/Forms/Suche/Entscheidungssuche/...` 검색/목록 페이지를 수집하지 않음 | BVerfG spider의 `LIST_URLS`에서 `SiteGlobals` 검색 URL 제거 | Done | 100% |
| G0-02 | P0 | BVerfG detail collection | 검색 페이지 목록의 개별 결정문 상세 URL만 수집 | range collector가 내장 공식 상세 URL 및 `--bverfg-detail-url=...`로 받은 `/SharedDocs/Entscheidungen/...` URL만 수집하도록 수정 | Done | 100% |
| G0-03 | P0 | BVerfG latest detail | 최신 예시 `qk20260417_2bvq002626.html` 수집 확인 | 해당 URL은 DB에 이미 존재, `summarized` 및 `publishable=true` 상태 확인 | Done | 100% |
| G0-04 | P0 | External index safety | robots로 막힌 외부 API도 기본 사용하지 않음 | Open Legal Data `/api` discovery는 `--bverfg-use-external-index` 명시 시에만 시도하도록 비활성화 | Done | 100% |
| G0-05 | P1 | Direct URL extensibility | 향후 확보한 개별 공식 상세 URL을 안전하게 추가 수집 | `BVERFG_DETAIL_URLS` env 및 반복 가능한 `--bverfg-detail-url=...` 옵션 추가 | Done | 100% |

## 2026-05-09 BVerfG Detail-Only Verification

| Check | Result |
| --- | --- |
| Code search for `SiteGlobals/Forms/Suche/Entscheidung` | Pass, 수집 코드 내 검색 페이지 참조 없음 |
| `pnpm exec tsx scripts/collect-range.ts --sources=de-bverfg --from=2026-01-01 --to=2026-05-09 --bverfg-detail-url=https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/04/qk20260417_2bvq002626.html` | Pass, discovered 5, 신규 0, 기존 5, failed 0 |
| DB BVerfG rows `2026-01-01..2026-05-09` | 5건, raw 15,680 bytes, cleaned 15,680 bytes |
| DB BVerfG publishable/summarized | 5/5 publishable, 5/5 summarized |
| Latest BVerfG row | 2026-04-17 `qk20260417_2bvq002626.html` |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |

## 2026-05-09 Range Collection Progress

| ID | Priority | Area | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| R0-01 | P0 | Safe crawling | 2026-01-01부터 2026-05-09까지 미국/독일/프랑스 결정 수집, 사이트 부담 및 로봇 차단 회피 | `scripts/collect-range.ts` 추가, robots 사전 확인, 단일 동시성, Playwright 비활성화, 요청 간 지연, URL/본문 중복 제외 적용 | Done | 100% |
| R0-02 | P0 | United States | SCOTUS 2025 Term slip opinions 중 2026-01-01 이후 결정 수집 | 공식 slip opinions 목록에서 27건 발견, 기존 5건 제외, 신규 22건 적재 | Done | 100% |
| R0-03 | P0 | France | Conseil constitutionnel 2026년 결정 수집 | 공식 sitemap에서 `/decision/2026/` 결정 33건 발견, 기존 5건 제외, 신규 28건 적재 | Done | 100% |
| R0-04 | P0 | Germany | BVerfG 2026년 결정 수집 | 전체 결정 검색 경로 `/SiteGlobals/`는 robots.txt에서 disallow라 사용하지 않음. 차단 회피 조건을 우선해 기존 검증 완료된 공식 상세 URL 5건만 중복 확인 | Done | 100% |
| R0-05 | P0 | Dedup | 중복 자료 제외 | canonical URL 및 normalized content 기준으로 중복을 걸러 기존 15건은 재삽입하지 않고 신규 50건만 추가 | Done | 100% |
| R0-06 | P1 | Summary/tags | 신규 자료 요약 및 태그 반영 | pending 48건 요약 완료, 태그 카운트 갱신. 미국 2건은 헌법 관련성 검토 상태로 비노출 유지 | Done | 100% |

## 2026-05-09 Range Collection Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsx scripts/collect-range.ts --from=2026-01-01 --to=2026-05-09 --delay-ms=5000 --list-delay-ms=2500` | Pass, 미국 신규 22건/프랑스 신규 28건/독일 신규 0건, failed 0 |
| Collection safety | robots.txt 사전 확인, 동시성 1, 2.5s listing delay, 5s detail delay, Playwright 미사용 |
| BVerfG robots policy | `https://www.bundesverfassungsgericht.de/SiteGlobals/...` 전체 검색 경로는 robots disallow라 수집에 사용하지 않음 |
| `pnpm summarize-pending -- --limit=100` | Pass, summarized 48, failed 0 |
| `pnpm refresh-tag-counts -- --delete-orphans` | Pass |
| DB range rows `2026-01-01..2026-05-09` | 총 65건, 미국 27건/독일 5건/프랑스 33건 |
| DB range visible rows | 총 63건, 미국 25건/독일 5건/프랑스 33건 |
| DB range review rows | 미국 2건 `needs_review`, 그 외 0건 |
| DB collected bytes | raw 2,492,042 bytes, cleaned 2,492,042 bytes |
| `pnpm check` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |
