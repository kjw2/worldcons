# WorldCons 수집→번역→발행 1건 E2E 운영 감사 (2026-10-08)

## 범위와 검증 수준

- 운영 Cloudflare Workflow 인스턴스/설정과 `worldcons_core`, `worldcons_ingest`, `worldcons_search`의 조회만 수행.
- **Production에 가짜 판례를 INSERT하거나 외부 LLM을 호출하지 않음.** 1건의 공식 사이트 모의 HTTP 응답→수집 함수→모의 D1·R2를 실행하고, 별도 메모리 D1에서 번역·발행 함수를 각각 실행.
- 수집 결과가 실제 Production Queue와 Workflow에 **동일한 요청 ID로 자동 전송**되는지는 테스트한 것이 아니라 코드와 Cron 구성으로 구조를 확인.

## 현재 운영 연결 구조

1. `crawler-daily`: 매일 06:00 KST, Worker scheduled→Cloudflare Queue→`worldcons-async-v1`; 4개국 순차 실행.
2. `runNativeSourceCollection`: 공식 URL·robots·원문 길이 검증→R2 원문 저장→D1 `articles` upsert, `ingestion_runs`/`source_url_candidates` 기록. 적격 문서는 `cleaned/pending`에 남는다. 별도 번역 Workflow는 생성하지 않음.
3. `translation-drain`: 00:30, 06:30, 12:30, 18:30 KST, 실행당 최대 10건, 1 pass. 기존 백로그에도 같은 정책 적용.
4. 새 배포 버전의 번역 Workflow는 성공 건이 있으면 동일 인스턴스에서 publication drain과 search-projection-sync를 순서대로 실행한다.
5. 별도 publication Cron 00:50/06:50/12:50/18:50와 매 15분 watchdog이 미발행 복구 수단이다. 이전 00:50·06:50 Cron에서는 인스턴스 미생성이 확인되었다. 단, **Cron→queue 전달 누락의 확정 원인은 불명**.
6. Watchdog은 발행 대기 항목과 outbox를 복구하지만, 실패한 원문 수집 후보를 독립적으로 소비하는 로직은 확인되지 않는다.

## 운영 데이터 (10월 8일 06:00 KST crawler Workflow)

| 소스 | 발견 | 확보 | 신규 | 갱신 | 동일 | 미확보 | 실행 결과 |
|---|---:|---:|---:|---:|---:|---:|---|
| 독일 | 1 | 0 | 0 | 0 | 0 | 1 | Workflow complete, 수집 결과 degraded |
| 미국 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| 프랑스 | 3 | 3 | 0 | 1 | 2 | 0 | complete |
| 스페인 | 20 | 19 | 0 | 0 | 8 | 1 | Workflow complete, 수집 결과 partial |

스페인에서 확보 19건과 상세 카운터 8건의 차이는 구버전에서 `preserved`·`duplicate`를 반환 값에 별도 집계하지 않은 관측 누락. 이 보고 작업에서 두 카운터를 추가했다.

`source_url_candidates` 재시도 대상: 독일 공식 URL 404 9건, 미국 PDF 추출 부재 2건, 스페인 공식 JSON 본문 미확보 1건.
번역 대기 독일 1,047건, 번역 오류 0, 발행 대기 0, 검색/FTS 1,327/1,327, 캐시 outbox 미전달 0.
현 상한 10건×4번/일=최대 40건/일이므로 기존 1,047건만 소진하는 데 신규 유입이 없다 해도 26일 이상 소요될 수 있다.

## 1건 페이크 테스트 판정

1. 실제 `runNativeSourceCollection`에 프랑스 공식 페이지 형태의 HTML/원문 모의 응답을 한 번 전달: **발견1, 확보1, INSERT1, R2(mock) 저장1, 오류0**.
2. 요청 ID 재실행: `replayed=true`, 추가 기사 0.
3. 이 시점: `articles.status=cleaned`, `translation_status=pending`, P3 publication 없음. **수집 요청만으로 즉시 번역/발행이 시작되지 않음**.
4. 별도 메모리 D1에서 같은 조건의 가짜 수집완료 레코드에 번역 스케줄 실행: `summarized1` 성공, 공개 0 유지.
5. 발행 스케줄 실행: `published1` 성공, outbox pending1. 실제 Production 수동 Workflow 10건 카나리에서 번역10→발행10→검색추가10은 앞서 성공했지만, 격리된 이번 1건 시험은 search D1 전체까지 관통하는 실전 테스트는 아님.
6. 독일 official 404를 주입한 기존 테스트: 수집 후보는 retrying, outcome degraded, 기사 0으로 유지. 워크플로 상태는 completed가 가능.

## 확인된 문제 및 개선방안

- **P0: 즉시 트리거 부재** — 수집 INSERT 성공 뒤 D1 durable outbox에 `articleId+contentHash`를 원자적으로 기록하고, Queue가 idempotent 1건 Workflow를 시작하도록 설계. Cron은 백로그 수습용으로 유지. 실패 시 DB에 사건을 보관해야 유실 방지.
- **P0: 수집 실패의 녹색 Workflow 상태** — `outcome`·`preservedCount`·`duplicateCount`·`discoveryUnavailableCode`·`failures`를 출력에 포함(로컬 수정·테스트 완료). `outcome != success`를 관측·경고하고 영속 retrying 후보 소비자 구현.
- **P0: 독일 공식 링크 실패** — 공식 후보 URL 404(9건)를 상태/발행일 기준 재검증, 공식 authority URL만 허용. 제3자 OpenLegalData로 출처 판정을 대체하지 않음.
- **P1: PDF·JSON 본문 관문** — 미국 2건 PDF extraction 부재, 스페인 1건 JSON 원문 미확보. 원문 미검증 문서는 정상적으로 비공개 유지; 공식 소스 재시도 및 추출 어댑터 보강.
- **P1: 번역 적체** — 1,047건, 최대 40건/일. 비용/쿼터 확인 뒤 배치 상한 조정·신규 문서 우선 신속 처리·백로그 전용 별도 작업.
- **P1: 발행/검색 관측** — 각 article에 `crawlRunId→articleId→translation→publicationVersion→search checksum` 상관관계 ID 및 지연 경보. 검색 sync 실패 시 재동기화 전용 복구 조건 추가.
- **P2: 불필요한 projection** — crawler-daily는 신규 발행 0건이어도 전체 검색 동기화를 실행함. 변경된 발행 버전만 증분 반영하도록 최적화.

## 이번 점검 중 수정 (로컬 코드만)

- native crawler 테스트 fake D1에서 `INSERT articles` 필드 인덱스 오류 보정.
- 미국 slip opinion 학년도 계산과 revision 기준 시각을 `options.now`로 통일하여 재현 가능한 가짜 수집 테스트 확보.
- 수집 결과에 `outcome`, `preservedCount`, `duplicateCount`, 실패 코드 등을 추가하여 성공/부분성공/저하 구별.
- 신규 1건 fake 수집 테스트 및 후속 번역→발행 독립 단계 테스트 추가.
- 대상 테스트 46/46, 전체 TS 타입검사 및 M8 dry-run 통과.

**주의**: 이 로컬 변경 사항은 현재 Production에 배포되거나 GitHub에 push되지 않았다. 배포한 이전 `worldcons-ingest`는 2026-10-08 기준 버전 `1512577d-6455-4496-a16d-5ff490ddf459`이다.
