# Spain HJ 2024 `SENTENCIA` source policy 검토 — 2026-09-03

## 판정

`BLOCKED (운영 정책 미승인)`.

Spain 2024 `SENTENCIA` vertical slice의 코드·schema·비공개 실행 계획은 준비됐지만, 현재 관측으로는 immutable `source_corpus_policies` row를 만들 수 없다. 공식 HJ의 공개 범위와 판결문 제공 사실은 확인됐으나 `robots.txt`는 404이고 Tribunal Constitucional의 법적 고지 경로는 403이라 저장소 런북의 fail-closed 조건을 충족하지 못한다.

따라서 이번 검토에서는 운영 DB INSERT, snapshot 생성, exhaustive inventory, fetch, 실행 flag 변경을 하지 않았다.

## 검토 범위

- source key: `es-tribunal-constitucional`
- 기관: Tribunal Constitucional de España
- canary 범위: 2024-01-01~2024-12-31의 `SENTENCIA`
- discovery 후보: 공식 HJ 연도·유형 검색과 페이지네이션
- authority host 후보: `hj.tribunalconstitucional.es`
- 검토 시각: 2026-09-03 20:40 KST 전후

## 확인된 공식 근거

1. [HJ 헌법판례 검색](https://hj.tribunalconstitucional.es/HJ/es/Busqueda/Index)은 1980년 이후 Tribunal Constitucional의 doctrine을 찾는 검색기라고 설명하며 `Sentencia`, `Auto`, `Declaración` 유형 필터를 제공한다. 원문 전체·이유·주문·기술정보와 BOE 원문 PDF 및 OpenXML 접근도 안내한다.
2. [Spain 지식재산권법 통합본 제13조](https://www.boe.es/eli/es/rdlg/1996/04/12/1/con)는 사법기관 결정이 지식재산권의 대상이 아니라고 규정한다. 이는 중요한 공개·재사용 근거지만, HJ 서비스의 자동 접근 조건과 개인정보 처리까지 자동 승인하는 근거로 확대 해석하지 않는다.
3. [Tribunal Constitucional 2015년 7월 23일 개인정보 비식별화 합의](https://www.boe.es/buscar/pdf/2015/BOE-A-2015-8372-consolidado.pdf)는 공개 결정에서 적용 대상자의 신원을 이니셜로 대체하고 추가 식별정보를 생략하도록 정한다. HJ 텍스트를 별도 서비스에서 재공개할 때에도 원천의 비식별화 상태를 훼손하지 않는 별도 검증이 필요하다.
4. [공공부문 정보 재사용법](https://www.boe.es/eli/es/l/2007/11/16/37/con)은 재사용 조건의 예로 내용 비변조, 의미 비왜곡, 출처 및 최종 갱신일 표시를 둔다. 다만 Tribunal Constitucional의 사법 기능에 이 일반 체계가 어떤 방식으로 적용되는지는 이번 기술 검토만으로 확정하지 않는다.
5. [Tribunal Constitucional의 정보 요청 안내](https://www.tribunalconstitucional.es/es/transparencia/informacion-publica/Paginas/04_InformacionSolicitada.aspx)는 판결 식별·이용조건과 개인정보 삭제가 빈번한 문의라고 밝히며, 투명성법상 정보 접근은 행정법 적용 활동에 한정된다고 설명한다. 따라서 명시적 이용조건 확인 없이 일반 공공데이터 라이선스로 간주하지 않는다.

## 닫히지 않은 차단 항목

| 항목 | 관측 | 판정 |
|---|---|---|
| robots | `GET https://hj.tribunalconstitucional.es/robots.txt` → HTTP 404 | 저장소 런북상 해석·승인 필요 |
| 이용조건 | `GET https://www.tribunalconstitucional.es/es/Paginas/aviso-legal.aspx` → HTTP 403 | 적용 조건과 자동수집 허용 범위 미확인 |
| 원문 재공개 | 저작권법 제13조 근거는 확인 | HJ 서비스 조건·개인정보·정정 반영 계약은 별도 승인 필요 |
| 요청 제한 | HJ가 공개한 명시적 crawl delay 또는 동시성 한도를 찾지 못함 | 보수값 제안은 가능하나 운영자 승인 필요 |
| 런타임 강제 | DB 정책에는 지연·동시성 필드가 있으나 worker가 아직 이를 네트워크 호출에 강제하지 않음 | 코드 보완 전 실행 금지 |
| 공식 모집단 수 | exhaustive inventory를 실행하지 않음 | 정책 승인 뒤 manifest와 공식 페이지네이션으로 증명 |

## 승인 후 사용할 보수적 초안

아래 값은 INSERT 가능한 승인본이 아니라 검토 시작점이다.

```text
source_key                 es-tribunal-constitucional
scope                      2024 SENTENCIA only
discovery_method           official_hj_search_pagination
authority_hosts            [hj.tribunalconstitucional.es]
default_text_access_policy metadata_only (이용조건 확인 전 상향 금지)
allow_raw_snapshot          false
normalize_replay_policy    bounded_evidence
min_request_delay_ms       3000
max_concurrency            1
coverage_assurance         authoritative_enumerated
```

bounded replay 후보는 `sourceKey`, `url`, `canonicalUrl`, `title`, `publishedAt`, `contentType`, 정규화에 필요한 최소 `text`, `metadata.resolutionType`, `metadata.decisionDate`, `metadata.sourceRecordId`, `metadata.sourceEtag`, `metadata.sourceLastModifiedAt`이다. `text` 보관은 이용조건·개인정보 승인이 끝날 때까지 확정하지 않는다.

승인본에는 관측 가능한 robots 원문 또는 404 해석에 대한 명시적 승인 근거, 적용 이용조건 URL과 hash, 정확한 텍스트 보관·egress 정책, 검토자, 검토 시각, `review_due_at`이 반드시 들어가야 한다.

## 실행 전 필수 조치

1. Tribunal Constitucional 또는 책임 운영자가 HJ 판결 데이터의 자동수집·저장·재공개 조건을 확인한다.
2. robots 404를 허용으로 해석할지 명시적으로 승인하고 그 근거를 evidence에 보존한다.
3. source 요청 지연과 동시성 제한을 분산 worker에서도 실제 강제하도록 구현하고 PostgreSQL 경쟁 테스트를 통과한다.
4. 그 뒤에만 새 immutable policy version을 INSERT한다. migration seed 또는 기존 row UPDATE는 금지한다.
5. policy version을 지정해 Spain 2024 discover를 한 번 실행하고, 닫힌 manifest·건수·digest를 저장한 뒤 fetch로 진행한다.

## 현재 검증된 비실행 계획

`pnpm backfill:corpus plan --year=2024`는 2024 `SENTENCIA`, private shadow, 공개 Catalog 비활성, Gemini 0회, discover→fetch→normalize→verify→reconcile 순서를 반환했다. 이 출력의 `executionEnabled=true`는 코드가 2024 scope를 지원한다는 뜻이며 source policy가 승인됐다는 뜻이 아니다. 실제 discover는 승인된 `--policy-version` 없이는 시작하지 않는다.
