# WorldCons 6단계 개선 계획

작성일: 2026-08-26

## 목표

WorldCons의 수집 안정성·공개 projection·SEO/UI 기반은 유지하면서, 검색 correctness와 retrieval 품질을 우선 개선하고 외부 Search Worker/cclrag2 계약을 일치시킨 뒤 운영 보안과 legacy 경로를 정리한다.

## 원칙

- 수집원의 robots.txt 및 공식 원문 우선 정책을 훼손하지 않는다.
- `public_article_projection_p3` 공개 경계를 유지한다.
- 검색 결과의 정확성(correctness)을 ranking 고도화보다 먼저 확정한다.
- 각 단계는 독립적으로 검증·커밋한다.
- 기존 cclmetasearch/cclrag2 계약과 production 공개 URL의 하위 호환성을 유지한다.

## 1단계 — 검색 pagination correctness

상태: 완료 (2026-08-26)

### 범위

- Semantic 검색에서 원 요청의 `page`가 후보 ID 재조회에 다시 적용되는 이중 pagination을 제거한다.
- 후보 ID 조회는 항상 첫 페이지부터 수행하고 최종 ranking 이후 pagination을 한 번만 적용한다.
- Semantic 후보가 100건을 넘는 경우에도 현재 최대 후보 범위 내에서 ID 순서를 보존해 조회할 수 있도록 bounded batch 조회를 사용한다.
- Hybrid 검색도 full-text/semantic 후보를 누적 window로 먼저 조회한 뒤 merge 후 최종 pagination을 한 번만 적용한다.
- page 1/2/3에서 결과 중복·누락이 생기지 않는 순수 pagination 회귀 테스트를 추가한다.

### 완료 기준

- semantic/hybrid pagination helper 회귀 테스트 PASS
- 기존 cclrag2 검색 테스트 PASS
- Search Worker 회귀 테스트 PASS
- `pnpm check`, lint, production build PASS

### 완료 결과

- 후보 ID 재조회는 항상 `page=1`부터 수행하도록 수정했다.
- 최대 100건 단위 bounded batch로 semantic 후보 ID를 순서 보존 조회하도록 수정했다.
- Hybrid는 요청 페이지를 full-text 조회에 직접 적용하지 않고 누적 candidate window를 먼저 확보한 뒤 최종 pagination을 한 번만 수행하도록 수정했다.
- candidate window는 다음 페이지 존재 판정을 위해 요청 페이지보다 한 페이지 앞까지 확보하되 현재 100건 상한을 유지한다. 이 상한 자체의 deep-pagination 개선은 4단계 범위로 남긴다.
- bounded candidate 결과는 전체 corpus의 정확한 total이 아니므로 `totalIsExact=false`로 명시한다.
- page 1/2/3 연속성, 후보 조회 page reset, bounded window 증가 규칙에 대한 회귀 테스트를 추가했다.

## 2단계 — 실제 Hybrid ranking

상태: 완료 (2026-08-26)

### 범위

- 현재 full-text 우선 concat 구조를 실제 rank fusion으로 교체한다.
- exact 사건번호/정확 제목을 강한 우선순위로 유지한다.
- FTS rank와 vector rank를 RRF 또는 동등한 안정적 fusion 방식으로 결합한다.
- recency는 법적 관련성을 훼손하지 않는 약한 tie-breaker로만 사용한다.
- 한국어 개념 질의와 외국어 판례 retrieval fixture를 추가한다.

### 완료 결과

- Hybrid 후보 결합을 단순 concat에서 reciprocal rank fusion(RRF, k=60)으로 교체했다.
- exact 사건번호는 기존 exact-case preflight가 계속 절대 우선하며, normalized exact title은 RRF 점수보다 먼저 정렬한다.
- 동일 문서가 FTS와 semantic 양쪽에서 높은 순위를 얻으면 양쪽 reciprocal rank가 합산되어 상위로 승격된다.
- 동일 RRF 점수에서만 `originalPublishedAt`을 최신순 tie-breaker로 사용해 법적 관련성보다 최신성이 앞서지 않도록 했다.
- `public_fulltext_ranked_ids_v1` service-role 전용 RPC를 추가해 P3 공개 projection에서 `ts_rank_cd` 기반 FTS 순위를 제공한다. RPC 미적용/실패, tag/legacy 특수 경로에서는 기존 full-text 검색으로 fail-soft한다.
- 한국어 개념 질의가 semantic으로 발견한 외국 판례를 낮은 FTS 결과보다 앞에 배치할 수 있는 fixture, exact title 우선, 양 검색 합의 승격, recency tie-breaker 테스트를 추가했다.
- `test:cclrag2` 14/14, `test:cclmetasearch` 9/9, Search Worker 7/7, `pnpm check`, lint, production build를 모두 통과했다.

## 3단계 — Cloudflare Search Worker 검색 계약 통일

상태: 완료 (2026-08-26)

### 범위

- Worker가 수신하는 `fulltext|semantic|hybrid` mode를 실제 retrieval에 반영한다.
- `worldcons_provider_search_v3` 등 명시적 mode-aware RPC를 도입한다.
- requested/effective mode 및 degraded 상태를 일관되게 표현한다.
- Next.js 검색과 Worker 검색이 동일한 핵심 ranking 정책을 사용하도록 정렬한다.

### 완료 결과

- Search Worker를 `worldcons_provider_search_v3`로 전환하고 `p_mode`와 optional query embedding을 실제 RPC에 전달하도록 수정했다.
- `fulltext`는 `ts_rank_cd`, `semantic`은 pgvector cosine similarity, `hybrid`는 RRF(`k=60`)를 사용하도록 DB retrieval을 분리했다.
- Hybrid의 exact normalized title 우선 및 relevance 이후 recency tie-break 규칙을 Next.js 검색과 맞췄다.
- BVerfG 사건번호/Neubauer/Klimabeschluss exact-case preflight는 embedding 호출 전에 처리해 불필요한 semantic 비용과 잘못된 degraded 판정을 제거했다.
- Worker는 semantic/hybrid 질의에서 OpenAI embedding을 생성하며, 키 미설정·호출 실패·빈 질의는 full-text로 fail-soft하고 `requestedMode`, `effectiveMode`, `mode`, `degraded`, `degradationReason`으로 실제 실행 상태를 반환한다.
- HTTP Provider Contract는 기존 `2.0`을 유지해 소비자 하위 호환성을 보존하고, 내부 DB 검색 계약만 V3로 올렸다.
- 공개 projection만 읽는 service-role 전용 V3 RPC와 migration 회귀 테스트를 추가했다.

## 4단계 — 사건번호 검색 통합과 검색 확장성

상태: 대기

- 독일·미국·프랑스·스페인 사건번호를 공통 canonical normalization 규칙으로 통일한다.
- 검색 시 반복 regexp 계산 대신 저장/인덱싱 가능한 canonical case key를 검토한다.
- Next FTS의 100 candidate 제한과 deep pagination 한계를 DB-native ranking/pagination 중심으로 개선한다.
- `total`, `hasMore`, `totalIsExact` 의미를 Next/Worker에서 통일한다.

## 5단계 — 운영 안정성과 보안

상태: 대기

- 인메모리 rate limit을 서버리스 분산 환경에서 유효한 저장소 기반으로 교체한다.
- CSP Report-Only 위반을 정리한 뒤 enforcement 전환을 준비한다.
- `unsafe-eval` 제거 및 script source 축소 가능성을 검증한다.
- 공개 read path의 service-role 의존성을 최소화한다.

## 6단계 — Legacy/P2/P3 수렴과 최종 검증

상태: 대기

- production parity를 확인한 뒤 obsolete legacy read/write, shadow flag, compatibility 경로를 제거한다.
- publication P3를 최종 authoritative public path로 수렴한다.
- 전체 unit/integration/SEO/ingestion/MasterDash/Worker 테스트와 production smoke를 수행한다.

## 단계별 커밋 기준

1. `fix: correct semantic and hybrid pagination`
2. `feat: implement ranked hybrid retrieval`
3. `feat: align worker search modes with retrieval`
4. `feat: unify exact case search and deep pagination`
5. `security: harden distributed api protection`
6. `refactor: retire legacy publication paths`
