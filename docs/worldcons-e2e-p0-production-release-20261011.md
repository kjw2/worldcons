# WorldCons E2E P0 — 운영 배포 및 종료 gate 검증 (2026-10-11)

**판정: 구현 코드 커밋·푸시 및 Production 배포 완료, 전수 Search/FTS 대조와 FR L 복구 후검사 통과. 전체 P0는 미완료이며 종료하지 않는다.**

M1–M4의 코드와 M5 Core writer fencing 일부를 배포했다. 실제 FR/ES 신규 판례의 무인 `completed_verified`, M5 전체 경로 확장, Discovery coverage, 잔여 콘텐츠 승인 검토 및 48시간 관측은 아직 충족하지 않았다. 빈 outbox·완료 원장을 성공한 E2E 증거로 해석하지 않는다.

## 1. 검토·커밋·배포 범위

- 별도 작업 트리: `C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons`, branch `codex/e2e-p0-m1`.
- 기준 main: `a415860362877bafef579cab0c18133dcdb877d3`.
- 구현 통합: `5e98695d7dc1362c49c8f6ea4dcb7a437124c164`.
- 공개 Worker 최종 런타임 기준: `43371c8814e0c56dd65455d1cad4a9a17f48cbc5`.
- Async Worker 최종 런타임/설정 기준: `c6d55d5949e367a5e19f80c78d523b2a3d82a9c7`.
- 이후 감사 스크립트·보고서·증거 커밋은 런타임 변경을 포함하지 않는다. Git 최신 SHA와 실제 배포 런타임 SHA를 혼동하지 않는다.

| 리소스 | 실제 적용 | 근거 |
|---|---|---|
| Core D1 | additive `0004`–`0008` 적용, pending 0 | `migration-apply.json` |
| Search D1 | additive `0002` 적용, pending 0 | `migration-apply.json` |
| Search repair/DLQ | `worldcons-e2e-search-repair`, `worldcons-e2e-search-repair-dlq` 생성 및 연결 | provision 로그, 최종 Async version |
| 공개 Worker `worldcons` | version `0bf0e14d-b4d9-4370-9b1d-34b5098d5644`, 100% | `public-deployments-final.json` |
| Async Worker `worldcons-ingest` | version `cc6b16a3-0a33-4551-bd4c-ccf41cccf0a2`, 100% | `async-deployments-final.json` |

Core 기존 데이터/컬럼을 삭제하거나 baseline을 다시 적용하지 않았다. Core guard 15개, Search guard 3개를 확인했다. 이 guard는 generation을 가진 managed Article을 보호한다. 전체 기존 Article의 generation backfill이나 모든 publication adapter 확장을 완료했다는 뜻은 아니다.

FR/ES staged approval, repair dispatcher/consumer, verifier를 활성화했다. verifier 대상은 `https://worldcons.cclib.workers.dev/api/cclrag2`, 배포 ref는 최종 공개 version과 SHA를 가리킨다. Case Catalog와 기존 M8의 DE/US 설정은 유지한다.

Search repair cron은 1분마다 실행하며 기존 M8 fanout과 분리했다. 실제 cron tail에서 `outcome: ok`, 예약 유실·dead-letter·오류·attention 0을 확인했다. 55초 tail 종료는 관측 창 종료에 따른 CLI timeout이며 Worker 실패가 아니다. 기존 staged dispatch는 15분, 일일 Discovery bootstrap은 UTC 21시이다. 실제 신규 예약이 없는 상태의 관측임을 명시한다.

## 2. 검증 결과와 한계

| 검증 | 결과 |
|---|---|
| `pnpm verify:release` | exit 0; 총 1,623 tests, **1,616 pass / 0 fail / 7 skip** |
| skip | PostgreSQL 환경이 필요한 기존 suites. 성공 또는 Production 검증으로 계산하지 않음 |
| M5 Core writer 검증 | 실제 SQLite/workerd에서 무단 head/publication 변경 거부, batch rollback, 정식 withdrawal/outbox 검증 |
| FR L 추가 회귀 | ranked/vector/provider/M4 대상 93 tests 통과 |
| 최종 타입·Worker 타입 | exit 0 |
| 실제 Production build | `pnpm build:vinext` exit 0 및 최종 번들 L suffix 검사 |
| 새 read-only corpus 감사 | 실제 원격 D1 실행 exit 0 및 타입 검사 통과 |
| Async health / 공개 API | Async `/health` 200, 공개 `/api/cclrag2/sources` 200 |

release gate의 존재하지 않는 standalone M9 명령을 제거하고 실제 Cloudflare 배포 대상인 Vinext build를 검사하도록 수정했다. 기존 default Next/Turbopack build는 공유 node_modules junction의 외부 경로 때문에 실패했으며, 이를 Production build 성공으로 오기하지 않는다.

최초 FR L 수정 배포용 build가 편집과 겹쳐 이전 parser를 포함한 사실을 확인했다. 이후 편집이 끝난 상태에서 다시 build했고, 실제 번들의 `QPC|DC|L|AN|SEN` 및 SHA를 확인한 뒤 최종 version을 재배포했다. 실패/중간 build 로그를 최종 성공 근거로 사용하지 않는다.

`final-health.json`의 공개 `/api/cclrag2/health` 404는 존재하지 않는 진단 URL을 요청한 결과다. 공개 서비스의 정상 smoke는 `public-sources-smoke.json`과 실제 FR L 상세/검색 응답으로 확인했다.

## 3. Production 전수 corpus와 FR L

`scripts/audit-e2e-p0-production.ts`는 쓰기 SQL 없이 적격 P3를 50건씩 읽고, 실제 현재 projection builder로 문서·FTS를 재계산한다. 각 필드의 실제 저장값을 hash하므로 DB checksum 칼럼만 비교하지 않는다. 기존 Search 행을 고치거나 완료 원장을 만들지 않는다.

| 항목 | 실제 결과 |
|---|---:|
| 적격 P3 | 1,457 |
| Search documents / FTS | 1,457 / 1,457 |
| 누락 / 비적격 잔존 | 0 / 0 |
| 문서 / FTS 중복 | 0 / 0 |
| 재계산 문서 / FTS fingerprint mismatch | 0 / 0 |
| P3 publication version 참조 오류 | 0 |
| 감사 전후 Core 자격·publication·tag 입력 boundary | 동일 |
| Core–P3 mutable snapshot drift | **3** |
| Production generation / `completed_verified` | **0 / 0** |

이 결과는 서로 다른 D1의 관측 시점 대조이며 원자적 전역 snapshot, 48시간 안정성 또는 Discovery coverage를 보장하지 않는다. `corpus-audit.json`에 각 Article의 기대/실제 fingerprint와 불일치 집합, 처리 원장 상태 및 한계를 저장했다.

FR `2026-335 L` (`16b4fc11-d9cc-4e5b-b8e5-acf687ab760e`)는 Search/FTS 행이 이미 있었으나 별도 정확 검색 parser가 L suffix를 누락해 공개 검색 0건이 재현됐다. `lib/cloudflare/search-ranked/reference.ts`에 L을 포함하고 실제 회귀를 추가했다.

최종 운영 후검사는 기대 fingerprint, 실제 Search/FTS 1/1, freshness, 상세 identity·본문 4,000 codepoint·요약, 정확 사건번호 검색을 모두 통과했다. 기존 P3 version `0f1dabb2-2442-546e-a3ec-d2ed5d443cc5`, version/publication revision 2를 유지했다. 이 복구는 신규 generation의 `completed_verified` 증거가 아니다.

## 4. 잔여 콘텐츠 검토

공식 FR HTML 및 ES HJ JSON을 새로 읽어 세 건 모두 HTTP 200, URL·수집 시각·응답 SHA를 저장했다. Core/P3 비교 snapshot 및 변경점을 함께 보존했다. 기존 approval 상태나 요약을 억지로 바꾸지 않았다.

| Article | 실제 차이·gate | 남은 처리 |
|---|---|---|
| FR `2026-1223 QPC` / `0e25c3b4-3449-46b5-9270-fd0e37f9e4b7` | 본문 길이 48자 차이, 제목·요약 변경; 기존 refresh 사전 gate 적격 | 출처/의미/승인 검토 후 정식 개정 또는 미승인 draft와 검토 원장 연결 |
| ES `AUTO 43/2026` / `15560a96-c510-427c-aaf4-a5d57ef5bd50` | 본문 1자 차이, 제목·요약 변경; 사전 gate 적격 | 요약의 `대통령` 표현이 공식 문맥의 기관장 지칭과 맞는지 검토해야 함. 사전 gate 통과만으로 의미 승인 처리하지 않음 |
| ES `SENTENCIA 59/2026` / `d31eecc5-4e74-440f-ba6e-1561911bd68c` | 본문 동일, 제목·요약 변경; 기존 `collectionSafety.publishable=false`로 provenance conflict | 새 공식 JSON의 identity/full-text gate를 read-only로 통과하고 metadata 정정안을 준비. 의미 승인 및 optimistic metadata 변경·재조회·정식 개정은 아직 실행하지 않음 |

SENTENCIA 59 metadata 정정안은 `drift-provenance-recheck.json`에 있다. `coreUpdated`, `p3Updated`, `summaryApproved`는 모두 false이다. 이 문서를 사람이 승인한 증거로 사용하지 않는다. 새 출처 증거를 얻었다는 사실과 현재 DB의 충돌 해소를 구분한다.

## 5. M5 및 Discovery 미완료 항목

현재 구현은 managed Article의 legacy publish/refresh를 차단하고, 사람의 정확한 현재 version withdrawal을 같은 세대/outbox 계약으로 처리한다. Core의 오래된 무조건 UPSERT도 DB trigger가 차단한다. 그러나 새 콘텐츠에 대한 human approval proof adapter, 관리자 refresh/일반 publish 및 backfill 등의 성공 경로 전체 적용과 진입 경로별 완료 증거는 아직 없다. **M5 전체 완료로 판정하지 않는다.**

`applySearchProjectionPlan`, `runNativeSearchProjectionSync`, `syncSearchProjectionForArticle`은 managed Article의 guarded writer 계약을 적용한다. FTS virtual table에 trigger를 설치할 수 없으므로 역사적 직접 SQL/FTS-only operator까지 DB trigger가 보호한다고 주장하지 않는다. 구버전/raw 운영 writer 제한과 inventory 인증이 남는다.

Discovery는 `native-crawler.ts`의 FR 후보 slice, ES 검색 pagination/candidate limit 및 staged `primary.slice(0, limit)`가 남아 있다. 현재 bootstrap limit 1이다. 반복된 상위 후보가 다음 후보를 지연·누락시키는 위험을 해소할 durable 후보 coverage/checkpoint와 다수 후보·상위 반복·재시작 gate가 필요하다. 단순 limit 증가를 coverage 완료로 간주하지 않는다.

## 6. 종료 시각과 rollback

최종 실제 100% 적용 시각은 공개 Worker `2026-10-11T07:34:59.802831Z`, Async Worker `2026-10-11T07:35:47.515362Z`이다. 이 최종 조합을 기준으로 48시간만 채워지는 가장 이른 시각은 **2026-10-13 16:35:47 KST**이다. 이 시간 도달은 자동 P0 종료 조건이 아니다.

기준 문서 §7.2의 모든 gate가 별도로 필요하다: 실제 FR와 ES 신규 공개 가능 판례의 무인 Discovery→Search/API→`completed_verified`, M5 writer 미보호 0, 콘텐츠 승인 drift 0 또는 정식 검토 연결, Discovery coverage, 두 번의 일일 주기, retry/dead-letter/유실 예약/목표 지연 검증. 현재는 충족하지 않는다.

별도의 Codex 예약 자동 검증은 아직 설정하지 않았다. 애플리케이션 자체의 Production cron/Queue는 배포한 설정에 따라 실행된다. 채팅이 자동으로 깨어나 최종 판정한다고 약속하지 않는다.

롤백 시 신규 자동 승인/예약 범위를 축소하되 additive schema, 이미 commit된 outbox, generation 및 tombstone을 보존한다. 최종 공개 parser 이전 version으로 되돌리면 FR L 검색이 다시 실패한다. guard가 없는 과거 Worker 또는 FTS-only writer로 돌아가지 않는다. 필요 시 호환 read/repair 경로를 유지하거나 cohort 쓰기·노출을 중단한다. Time Travel bookmark는 복구 근거로 보존했지만 이 작업에서 데이터 rewind는 실행하지 않았다.

## 7. 증거 및 보존

모든 새 근거는 `artifacts/e2e-p0-release/`에 저장한다. `evidence-manifest.json`은 파일별 SHA-256을 고정하며 자기 자신은 hash 대상에서 제외한다. 최종 보고서의 파일명은 해당 디렉터리 기준이다. 과거 M1–M4의 local/fixture 보고서를 Production 결과로 다시 쓰지 않았다.

원래 `F:/dev/worldcons`의 다른 변경 두 파일 및 미커밋 incident 증거를 보존했다. 종료 전 원문 SHA는 그대로다.

- 계획: `f7df0023b813c0fb582aac633d83ed8b82c038e95093b82626fb5b5cff5defba`.
- incident JSON: `52a39acef9554b5975ae10bf91f96bbb7ac47ea52d75af718ea180f9b5d2cbb8`.

재검증: `node --import tsx scripts/audit-e2e-p0-production.ts` 및 `node --import tsx artifacts/e2e-p0-release/fr-l-postcheck.ts`. 두 도구 모두 Production read-only이며 P0 종료나 콘텐츠 승인을 생성하지 않는다.
