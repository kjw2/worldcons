# Catalog 권위 원문과 기존 번역 간 공개 자격 정합화 — 2026-10-08

대상: 독일 연방헌법재판소 2021-03-24 기후결정 `1 BvR 2656/18`.

- Article ID: `552950ac-de82-41f5-ae88-411efc5ae9b2`
- 기존 번역·P3 published revision: `ab74a7d6-1cc8-5fc7-a522-97226a91f7dc`
- 현재 Catalog authoritative_source: `cbd5c14b-6278-5f1b-ac03-947589f06ef5`
- Catalog 원본 SHA-256: `fd9f89a17986392b38fc2a77015b00ca5a5e5a55ec570c844ad9db4a25606ba9`
- 원문 정책: `enrichment_status=source_only`, `text_access_policy=metadata_only`, `authority_status=verified`

## 결정 및 근거

구형 정규화 본문 321,089자와 현재 권위 원문 329,222자는 표본 내용이 크게 겹치지만 서로 동일하지 않다.
기존 한국어 AI 요약을 권위 원문에 재연결하는 것은 출처 해시와 완전성을 검증할 수 없어 금지한다.
현 정책은 source-only/metadata-only로, 새로운 전체 요약·본문 공개를 승인한 상태가 아니다.

공개 검색 Gate 2는 이미 `enrichment_full` + 현재 Catalog anchor ID + source content hash 일치만 인정했으나,
목록·상세·원문 API·사이트맵과 국가별 건수는 P3 published/legacy 상태만 보고 있었다.
본 변경은 이 읽기 경로의 자격 판정을 일치시키고, P5 공개 데이터 일치 지표도 해제되지 않은 예외만 반영한다.

## Production 수정 및 검증

2026-10-08, `worldcons_core.articles.catalog_ai_stale_v4`를 **해당 Article ID 한 건에 한해**
기존 P3 legacy publication, Catalog published authoritative self-anchor, `source_only`, `metadata_only`, `verified`
조건이 모두 맞을 때만 1로 변경했다. 반환 ID를 대조했고 D1 `meta.changes=1`이었다.
기존 immutable P3 버전·Catalog anchor·AI 요약 내용·발행 이력은 변경하거나 삭제하지 않았다.

일관성 검증: 국가별 공개 1,327건 (독일 382), 검색·FTS 1,327건, 상세·원문 API 404,
사이트맵·RSS 대상 문서 비노출, Production Watchdog `publication.parity` 경고 해소.

## 추후 정식 재가공 조건

원문 사용 정책 및 Gemini 재가공 허용 근거를 다시 검토한 뒤,
**새 권위 anchor와 동일한 source content hash를 담은 immutable `enrichment_full` 버전**을 생성하고
기존 `articlePublicationService.transition`을 통해 P3 발행을 전환해야 한다.
재가공이 실패하면 기존 번역을 새 원본인 것처럼 보여주지 않는다.
Catalog metadata-only를 일괄 해제하거나 옛 번역 hash를 새 원본 hash로 위조해서는 안 된다.
