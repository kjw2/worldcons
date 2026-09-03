# 헌법판례 백필 Gate 1 운영 런북

상태: 구현 완료, 기본 비활성, 운영 마이그레이션·정책 등록·실데이터 실행 전

## 범위와 금지선

Gate 1은 스페인 헌법재판소 HJ의 2024년 `SENTENCIA`를 대상으로 불변 inventory와 비공개 fetch/normalize/verify 원장을 증명한다. Gate 1 단독 검증에서는 공개 Catalog, 기존 기사 publication pointer, ChatGPT 플러그인 검색 결과를 바꾸지 않으며 Gemini 호출은 0회다. Gate 2 migration과 `CASE_CATALOG_WRITE_ENABLED=true`가 함께 승인되기 전에는 `publish`를 실행하지 않는다.

Gate 5의 2020~2023 역사 범위 adapter는 같은 연도별 snapshot 계약으로 로컬 구현돼 있지만 기본 비활성이다. `CASE_CATALOG_SPAIN_HISTORY_ENABLED=true`가 없으면 CLI뿐 아니라 P1 worker가 직접 받은 historical snapshot도 run 생성 전에 거부한다. 2024 canary의 운영 완료 증거가 모이기 전에는 이 flag를 켜지 않는다.

공식 HJ는 1980년 이후 헌법재판소 doctrine 검색과 `Sentencia`, `Auto`, `Declaración` 유형을 제공한다. 이 설명은 수집 범위의 출발점일 뿐, robots·이용조건·텍스트 보관 허용을 자동 승인하지 않는다. 운영자는 실행 당일 근거를 다시 확인하고 immutable policy row로 별도 승인해야 한다.

## 1. 사전 검토

다음을 사람이 확인하고 승인 기록에 첨부한다.

- 공식 범위 URL: `https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index`
- inventory 방식: 공식 HJ 검색 페이지의 연도·결정유형 필터와 페이지네이션
- authority host: `hj.tribunalconstitucional.es`
- robots URL, 관측 시각, 원문 SHA-256
- 적용되는 이용조건 URL, 관측 시각, 공개·저장 근거
- 원문 전체 저장 여부와 bounded replay에 허용할 정확한 필드 경로
- 최소 요청 간격과 최대 동시 요청 수
- 검토자, 검토 시각, 다음 검토 기한

robots 또는 이용조건을 읽을 수 없거나 해석이 불명확하면 `source_corpus_policies`를 만들지 않는다. 기존 policy의 기한을 UPDATE로 연장하지 말고 재검토 후 `supersedes_policy_version`을 가진 새 버전을 INSERT한다.

Gate 1의 권장 replay allowlist는 진단 객체 전체가 아니라 normalize에 필요한 필드만 열거하는 방식이다. 예시는 `sourceKey`, `url`, `canonicalUrl`, `title`, `publishedAt`, `contentType`, `text`, `metadata.resolutionType`, `metadata.decisionDate`, `metadata.sourceRecordId`, `metadata.sourceEtag`, `metadata.sourceLastModifiedAt`이다. 실제 adapter 출력과 정책 근거를 대조한 뒤 확정한다.

## 2. 마이그레이션 검증

운영 반영 전에 disposable PostgreSQL에서 다음 순서를 실행한다.

```text
pnpm typecheck
pnpm check
pnpm lint
pnpm test:p1
BACKFILL_TEST_DATABASE_URL=<disposable-postgres-url> pnpm test:backfill
```

PostgreSQL 테스트의 skip은 승인 증거가 아니다. 깨끗한 스키마에 migration을 적용하고 service-role grant, anon/authenticated 접근 거부, 닫힌 manifest 수정 거부, stale fencing 거부, item lease 상한, attempt 실패 시 claim 회수, append-only artifact 변경 거부를 확인한다.

## 3. 비공개 실행

계획 출력은 데이터베이스 없이 확인할 수 있다.

```text
pnpm backfill:corpus plan
```

승인된 policy version을 등록한 뒤 discover pass를 제출한다.

```text
pnpm backfill:corpus discover --policy-version=<approved-version>
```

로컬에서 즉시 실행하려면 다음 환경 권한이 정확히 일치해야 한다.

```text
ADMIN_QUEUE_V3_WORKER_ENABLED=true
ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES=p1.case-backfill.discover
ADMIN_QUEUE_V3_WORKER_COHORTS=catalog-backfill
```

그 뒤 동일 명령에 `--execute`를 붙인다. fetch, normalize, verify, reconcile도 한 번에 한 phase만 allowlist에 넣어 반복한다. 각 pass 후 `pnpm backfill:corpus status --snapshot=<uuid>`를 저장한다.

## 4. 승인 기준

- 같은 inventory를 다시 만들었을 때 stable key 집합과 manifest hash가 일치한다.
- `processingCompletion`과 `corpusCoverage`를 혼동하지 않고 coverage assurance 근거가 보존된다.
- normalize pass 중 공식 사이트로 나가는 네트워크 호출이 없다.
- 모든 item lease가 소유 P1 attempt lease 이하이고 stale attempt의 쓰기가 거부된다.
- published item 재처리에서 resolution은 `published`로 유지되고 work state만 변한다.
- parser 출력 hash가 같은 no-op verify는 새 공개 revision 없이 artifact pointer만 정렬한다.
- reconcile 결과에 설명되지 않은 terminal failure, retry wait, claim, conformance 차이가 없다.
- 공개 surface와 Gemini 호출 수에 변화가 없다.

한 항목이라도 실패하면 다음 phase로 진행하지 않는다. Gate 2 publication과 source-anchor/P3 freshness는 구현됐지만 운영 migration·source policy·canary 승인은 여전히 별도다. 공개 전환 절차는 Gate 2 런북을 따른다.

## 5. 롤백

`ADMIN_QUEUE_V3_WORKER_ENABLED=false`로 신규 claim을 막고 실행 중인 attempt를 정상 중단 또는 lease expiry 처리한다. migration과 immutable evidence는 삭제하지 않는다. 공개 기능은 Gate 1에서 켜지지 않으므로 public rollback은 필요하지 않다. 재개할 때면 먼저 snapshot status와 P1 attempt/claim 원장을 대조한다.
