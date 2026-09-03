import type { ReactNode } from "react";
import type { PublicSourceAttribution } from "@/lib/case-catalog/source-attribution";

function AttributionItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-archive-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm leading-6 text-archive-text">{children}</dd>
    </div>
  );
}

export function ArticleSourceAttribution({ attribution }: { attribution: PublicSourceAttribution }) {
  return (
    <section className="border-y border-archive-line-strong bg-archive-surface-soft px-1 py-5 sm:px-4" aria-labelledby="official-data-attribution-heading">
      <h2 id="official-data-attribution-heading" className="archive-rule-title text-base font-semibold text-archive-heading">
        공식 데이터 출처와 이용조건
      </h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <AttributionItem label="제공기관">{attribution.providerLabel}</AttributionItem>
        <AttributionItem label="공식 생산기관">{attribution.authorityLabel}</AttributionItem>
        <AttributionItem label="DILA 자료 ID">{attribution.dilaId}</AttributionItem>
        <AttributionItem label="결정번호">{attribution.decisionNumber}</AttributionItem>
        {attribution.ecli ? <AttributionItem label="ECLI">{attribution.ecli}</AttributionItem> : null}
        <AttributionItem label="자료 파일 기준시각">
          <time dateTime={attribution.stockTimestamp}>{attribution.stockTimestamp}</time>
        </AttributionItem>
      </dl>
      <p className="mt-4 break-all text-sm leading-6 text-archive-text">
        자료 파일: <a href={attribution.stockUrl} target="_blank" rel="noreferrer" className="focus-ring rounded-sm font-semibold text-archive-accent underline decoration-archive-line-strong underline-offset-4">{attribution.stockFilename}</a>
      </p>
      <p className="mt-2 text-sm leading-6 text-archive-text">
        라이선스: <a href={attribution.licenseUrl} target="_blank" rel="noreferrer" className="focus-ring rounded-sm font-semibold text-archive-accent underline decoration-archive-line-strong underline-offset-4">{attribution.licenseLabel}</a>
      </p>
      <p className="mt-4 text-sm leading-6 text-archive-muted">{attribution.notice}</p>
    </section>
  );
}
