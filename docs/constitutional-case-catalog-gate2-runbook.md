# 헌법판례 Catalog Gate 2 운영 런북

상태: 로컬 구현·production-shaped PostgreSQL 계약 검증 완료, 운영 migration·source policy 승인·Spain canary 전

## 범위와 안전선

Gate 2는 검증을 마친 backfill item을 Gemini 호출 없이 `authoritative_source` revision과 Catalog publication으로 원자 발행한다. Catalog는 최신 공식 source anchor만 가리키고, P3는 그 anchor와 source hash가 일치하는 `enrichment_full`만 공개한다.

운영 기본값은 모든 `CASE_CATALOG_*` flag가 `false`다. migration 적용만으로 공개 결과나 백필 worker 동작을 바꾸지 않는다. `catalog_ai_stale_v4`는 rollback으로 해제되는 기능이 아니라 데이터 정합성 불변식이므로, flag를 모두 꺼도 stale 또는 판정 불가 AI를 legacy 공개 경로에 다시 노출하지 않는다.

## 1. 적용 전 검증

Gate 1 migration 뒤 Gate 2 migration을 깨끗한 disposable PostgreSQL에 순서대로 적용한다.

```text
CATALOG_TEST_DATABASE_URL=<disposable-postgres-url> pnpm test:catalog
pnpm test:backfill
pnpm typecheck
pnpm check
pnpm lint
pnpm test:p3
pnpm test:public-regression
pnpm build
```

PostgreSQL 테스트 skip은 승인 증거가 아니다. 다음 항목을 실제 DB에서 확인한다.

- decision-unique 식별자는 충돌을 거부하고 docket은 복수 결정을 허용한다.
- `authoritative_source`는 self-anchor이며 Catalog만 가리킬 수 있다.
- P3 publication은 current Catalog anchor ID와 source hash가 모두 일치하는 `enrichment_full`만 허용한다.
- Catalog correction은 publication pointer 전환, stale marker, outbox 생성을 한 transaction에서 수행한다.
- withdraw는 기존 P3 publication version을 보존한다.
- fenced publish는 verified normalization만 받아 article, immutable revision, metadata, identifier, publication, item 상태를 원자 갱신한다.
- `anon`과 `authenticated`는 공개 view만 읽을 수 있고 내부 ledger·authority 함수에는 접근하지 못한다.
- 기존 mutable article은 Catalog shadow publication 때문에 덮어쓰지 않는다.

## 2. 운영 migration 전 점검

1. production DB 백업과 migration dry run 결과를 보존한다.
2. `source_corpus_policies`에 검토자가 승인한 immutable Spain policy가 있는지 확인한다.
3. `review_due_at`이 미래이고 robots·terms·text policy evidence hash가 모두 존재하는지 확인한다.
4. 기존 공개 P3 전체가 legacy freshness sidecar에 분류됐는지 count와 digest로 reconciliation한다.
5. `catalog_ai_stale_v4=true` article이 legacy 목록·상세·sitemap·집계에서 나오지 않는지 확인한다.
6. 배포 환경의 flag 조합을 `pnpm check`로 검증한다.

source policy를 migration seed로 만들지 않는다. 운영자가 실제 근거를 검토한 뒤 새 version row로 등록한다.

## 3. Flag 의존성과 활성화 순서

| 단계 | 필요한 값 | 외부 효과 |
|---|---|---|
| schema only | 전부 `false` | 없음 |
| shadow write | `CASE_CATALOG_WRITE_ENABLED=true` | Catalog row 생성, 공개 read는 기존 P3 유지 |
| public canary | `ADMIN_PUBLICATION_V4_READ_ENABLED=true`, `CASE_CATALOG_PUBLIC_ENABLED=true` | source-only fallback 상세 공개 |
| search | 위 값 + `CASE_CATALOG_SEARCH_ENABLED=true` | 통합 exact/lexical 검색 활성화 |
| plugin | 위 값 + `CASE_CATALOG_PLUGIN_ENABLED=true` | ChatGPT 플러그인이 통합 검색 사용 |
| semantic | search까지 활성 + `CASE_CATALOG_SEMANTIC_ENABLED=true` | 검증된 Gemini catalog embedding branch 사용 |

`public -> P3 read`, `search -> public`, `plugin -> search`, `semantic -> search` 의존성을 어기면 애플리케이션 검사가 실패해야 한다. Spain canary에서는 semantic과 Gemini enrichment를 켜지 않는다.

## 4. Spain 2024 SENTENCIA canary

1. 승인된 policy로 inventory를 discover하고 snapshot을 close한다.
2. fetch, normalize, verify를 각각 bounded pass로 실행한다.
3. reconciliation에서 설명되지 않은 failure, active claim, manifest 차이가 0인지 확인한다.
4. `CASE_CATALOG_WRITE_ENABLED=true`만 켜고 publish pass를 소량 실행한다.
5. DB에서 Catalog anchor가 authoritative self-anchor인지, 기존 P3/legacy article content가 변하지 않았는지 확인한다.
6. shadow 결과의 row count, identifier digest, source hash, outbox를 대조한다.
7. public canary flags를 켜고 `/articles/{slug}`가 공식 정보와 “요약 준비 중” 또는 “재처리 중” 상태를 정확히 표시하는지 확인한다.
8. 기존 current P3 article이 계속 full 표현으로 나오고 source correction 뒤에는 즉시 source-only로 fallback하는지 확인한다.
9. Gemini 호출 수가 0인지 확인한다.

한 항목이라도 실패하면 search와 plugin 단계로 진행하지 않는다.

## 5. 롤백

외부 노출부터 역순으로 끈다.

1. `CASE_CATALOG_PLUGIN_ENABLED=false`
2. `CASE_CATALOG_SEMANTIC_ENABLED=false`
3. `CASE_CATALOG_SEARCH_ENABLED=false`
4. `CASE_CATALOG_PUBLIC_ENABLED=false`
5. `CASE_CATALOG_WRITE_ENABLED=false`

진행 중 worker는 신규 claim을 중단하고 lease/fencing 계약에 따라 종료한다. migration, immutable revision, policy, artifact, event, outbox는 삭제하지 않는다. `catalog_ai_stale_v4`를 수동으로 되돌리지 않는다. source correction의 적법한 current full enrichment를 다시 발행하거나 검증된 migration 절차로만 false 전환한다.

## 6. Gate 2 완료 증거

- 운영 migration ID와 적용 시각
- source policy version, 검토자, `review_due_at`, evidence hash
- Spain snapshot ID와 manifest hash
- 처리 완료율과 `coverage_assurance`
- publication count와 identifier/source-hash digest
- source-only 및 current P3 브라우저 확인 결과
- stale correction fallback 확인 결과
- Gemini 호출 0회 증거
- rollback rehearsal 결과

이 증거가 모두 있어야 Gate 3 통합 검색·플러그인 canary로 진행한다.
