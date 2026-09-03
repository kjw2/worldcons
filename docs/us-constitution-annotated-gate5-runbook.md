# 미국 Constitution Annotated 후보 그래프 Gate 5 실행 계약

## 범위

이 단계는 Congress.gov Constitution Annotated의 Table of Cases 인용을 비공개 후보 그래프로 정규화한다. Table of Cases는 Constitution Annotated에서 인용된 사건 목록이며, 그 자체가 연방대법원 헌법판례 확정 목록은 아니다. 하급 연방법원과 주 법원 판례도 포함될 수 있으므로 모든 최초 상태는 `candidate`다.

후보 하나는 다음 근거를 보존한다.

- 사건 표시명과 인용
- 인용이 나타난 Constitution Annotated essay ID, 제목, 공식 URL
- reporter 형식에서 계산한 court classification hint
- 후보 생성 근거와 검토 우선순위

`U.S.` reporter 형식도 연방대법원 identity 후보라는 힌트일 뿐 자동 `verified` 근거가 아니다. 공개 적격 판정에는 공식 SCOTUS identity, 해당 Constitution Annotated essay의 헌법 문맥, U.S. Reports 또는 Supreme Court 공식 authority, 헌법적 holding 확인이 모두 필요하다.

## 네트워크와 입력 계약

공식 URL은 `https://constitution.congress.gov/resources/cases-cited/`다. 현재 자동 요청이 Cloudflare JavaScript challenge를 반환할 수 있다. challenge, 인식할 수 없는 HTML, 비어 있는 파싱 결과는 모두 source unavailable 오류로 처리하며 빈 inventory snapshot을 닫지 않는다. 방어를 우회하거나 비공식 mirror를 authority로 사용하지 않는다.

라이브 수집이 가능해지기 전에는 검토자가 공식 페이지에서 보존한 fixture/export만 parser 회귀 입력으로 사용할 수 있다. fixture에는 수집 시각, 공식 URL, payload hash, parser version을 함께 기록해야 한다. 실제 DOM 구조를 확인하지 않은 합성 fixture만으로 production snapshot을 생성해서는 안 된다.

## 상태와 승격 경계

```text
Table citation
  -> candidate
  -> official SCOTUS identity verified
  -> constitutional essay context verified
  -> official authority verified
  -> constitutional holding verified
  -> verified
```

하급 연방법원 또는 주 법원 identity가 확인되면 Track A SCOTUS 후보에서는 `rejected`로 닫고 원래 provenance는 보존한다. identity나 문맥이 불충분하면 `uncertain`이다. 선거구획정 landmark seed는 scheduling priority만 높이며 상태나 검증 필드를 바꾸지 않는다.

## 운영 안전장치

`CASE_CATALOG_US_CONAN_ENABLED=false`가 기본값이다. source policy, 실제 공식 fixture, durable candidate schema, authority resolution 경로가 별도 검토되기 전에는 이 값을 켜지 않는다.

이 단계에서는 다음 작업을 하지 않는다.

- `source_backfill_items`의 publish phase 실행
- Catalog authoritative source revision 생성
- `/articles` 공개
- P3 summary 생성
- Gemini 또는 embedding 호출

후보와 essay evidence를 저장하는 `us_conan_*_v1` DB 계층은 구현됐다. snapshot은 payload hash·parser·source policy에 결속되고 close 뒤 manifest가 불변이며, 후보·essay evidence·review는 append-only다. 같은 citation/essay의 불일치 재입력은 멱등 성공으로 숨기지 않고 충돌로 중단한다. `anon`, `authenticated`, `public`은 내부 테이블과 전환 RPC에 접근할 수 없다.

리뷰는 optimistic revision을 요구한다. DB trigger와 RPC 모두 `verified` 전환 전에 SCOTUS candidate classification, essay evidence, 공식 identity, 헌법 essay 문맥, 공식 authority URL, 헌법적 holding 네 gate를 검사한다. 현재 view는 리뷰가 없는 후보를 `candidate`로 계산한다.

parser 결과를 이 DB 원장에 연결하는 비공개 import service와 CLI까지 구현됐다. 후속 단계는 별도 `us-scotus` authority resolver가 공식 U.S. Reports/SCOTUS 원문에 결속한 뒤에만 기존 Catalog backfill pipeline으로 넘기는 것이다.

## 비공개 import CLI

기본 실행은 DB를 변경하지 않는 plan이다.

```text
pnpm import:us-conan-candidates --input=<reviewed-official-fixture.html> --observed-at=<ISO8601>
```

출력의 candidate 수, court classification, challenge 여부와 payload hash를 검토한다. 실제 import는 검토된 source policy와 두 잠금을 모두 요구한다.

```text
CASE_CATALOG_US_CONAN_ENABLED=true pnpm import:us-conan-candidates --input=<reviewed-official-fixture.html> --observed-at=<ISO8601> --policy-version=<reviewed-policy> --execute
```

`--priority-citations-file=<json-array>`는 검토된 citation의 scheduling priority만 높인다. 해당 파일은 상태나 verification evidence를 만들지 않는다. 동일 payload/parser/policy 재실행에서 snapshot이 이미 닫혀 있고 candidate count/hash가 유효하면 manifest 쓰기 없이 멱등 성공한다. 중간 실패로 snapshot이 열려 있으면 동일 candidate/evidence만 재사용하여 close를 다시 시도한다.

## 공식 U.S. Reports authority probe

GovInfo의 U.S. Reports는 `USREPORTS-{volume}-{initial page}` granule URL을 제공한다. resolver는 `U.S.` reporter citation을 이 예측 가능한 공식 details URL에 매핑한 뒤 robots 정책을 확인하고, GovInfo의 `dc.title`, 정확한 citation, 양 당사자 anchor, 같은 granule의 공식 PDF 링크를 모두 대조한다.

```text
pnpm verify:us-reports-authority --citation=<U.S. Reports citation> --case-name=<case name>
```

셸 quoting이 불편한 환경에서는 `{"citation":"...","caseName":"..."}` 형식의 검토 파일을 `--input=<probe.json>`으로 전달한다.

이 명령은 read-only다. 성공은 SCOTUS identity와 공식 authority granule을 확인했다는 뜻일 뿐 헌법 관련성 `verified`가 아니다. DB review를 쓰지 않고 `constitutionalRelevanceStatus=candidate`, `reviewWritten=false`, `geminiCalls=0`을 명시한다. Constitution Annotated essay 문맥과 헌법적 holding은 별도 리뷰 gate로 남는다. 404, robots 차단, redirect host/path 변경, citation/name/PDF 불일치는 fail-closed다.

resolver 결과를 저장할 때는 human/legal review row를 자동 생성하지 않는다. `us_conan_candidate_authority_artifacts_v1`에 resolver version, 정확한 citation, GovInfo details/PDF URL, payload hash, 관측 시각과 blocking reason을 append-only로 남긴다. 동일 결과의 재저장은 멱등이며, source candidate의 citation과 예측 가능한 granule URL이 어긋나면 DB RPC도 거부한다.

초기 선거구획정 priority set은 Baker, Wesberry, Reynolds, Shaw, Vieth 5건이다. 2026-09-03 GovInfo U.S. Reports granule로 citation과 authority URL을 확인했지만 모두 `priorityOnly=true`, `constitutionalRelevanceStatus=candidate`다. 이 목록은 완전한 선거구획정 판례 목록이 아니며, Rucho처럼 현재 resolver의 GovInfo bound-volume 범위 밖에 있는 사건은 별도 official-source resolver가 준비될 때 추가한다.
