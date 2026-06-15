import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ExternalLink } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { SurfaceCard, surfaceCardClassName } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listArticles, listSources } from "@/lib/db/queries";
import type { SourceRecord } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { articleDateLabel } from "@/lib/ui/article-date-label";
import { displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "안내",
  description: "World Cons의 목적, 이용방법, 수집현황, 수집·번역·요약 기준을 안내합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/guide` },
};

type SourceGuide = {
  primaryMaterial: string;
  collectionMethod: string;
  dateBasis: string;
  translationSummary: string;
  compliance: string;
};

type CollectionRow = {
  source: SourceRecord;
  guide: SourceGuide;
  publicCount: number;
};

const sourceOrder = ["de-bverfg", "us-scotus", "fr-conseil-constitutionnel", "es-tribunal-constitucional"];

const numberFormatter = new Intl.NumberFormat("ko-KR");
const guideHeadingDescriptionClassName = "max-w-none text-pretty";

const defaultSourceGuide: SourceGuide = {
  primaryMaterial: "공식 원문 자료",
  collectionMethod: "공식 사이트의 허용된 목록과 상세 원문을 기준으로 후보를 확인합니다.",
  dateBasis: "공식 원문의 기준일",
  translationSummary: "원문 텍스트를 보존한 뒤 한국어 제목, 한줄 요약, 핵심 요약, 태그를 생성합니다.",
  compliance: "robots.txt, 요청 간격, 중복 제거, 공개 가능성 검토를 지킵니다.",
};

const sourceGuides: Record<string, SourceGuide> = {
  "de-bverfg": {
    primaryMaterial: "독일 연방헌법재판소 공식 결정문",
    collectionMethod: "목록 후보는 dejure.org 공개 인덱스를 기준으로 확인하고, 허용된 공식 BVerfG 상세 원문만 가져옵니다. Open Legal Data는 가능한 보조 후보로만 봅니다.",
    dateBasis: "공식 상세 결정문의 선고·공개일",
    translationSummary: "독일어 원문을 정리한 뒤 한국어 제목, 요약, 쟁점 태그, 참조 조문 후보를 생성합니다.",
    compliance: "BVerfG robots.txt와 Crawl-delay를 우선합니다. 금지된 검색 경로는 요청하지 않습니다.",
  },
  "us-scotus": {
    primaryMaterial: "미국 연방대법원 Opinions of the Court",
    collectionMethod: "SCOTUS 공식 Opinions of the Court 목록과 원문 PDF/HTML을 확인하고 헌법 관련성이 있는 자료를 선별합니다.",
    dateBasis: "SCOTUS 공식 게시·선고일",
    translationSummary: "영어 원문을 기준으로 한국어 요약을 만들고, 수정헌법·절차 법리 등 참조 조문 후보를 함께 표시합니다.",
    compliance: "robots.txt를 확인하고 허용된 공식 의견 경로만 처리합니다. Orders, In-Chambers 자료는 일반 판례 수집에 섞지 않습니다.",
  },
  "fr-conseil-constitutionnel": {
    primaryMaterial: "프랑스 헌법위원회 decisions, QPC 자료",
    collectionMethod: "공식 sitemap과 허용된 결정문 상세 URL을 기준으로 수집합니다.",
    dateBasis: "Conseil constitutionnel 공식 결정일",
    translationSummary: "프랑스어 원문을 한국어로 요약하고, QPC·헌법 조항·쟁점 태그를 생성합니다.",
    compliance: "robots.txt에서 금지된 /recherche/ 검색 경로는 수집하지 않습니다.",
  },
  "es-tribunal-constitucional": {
    primaryMaterial: "스페인 헌법재판소 HJ resolutions",
    collectionMethod: "HJ 일반 Fechas Desde/Hasta 검색과 HJ JSON 상세를 기준으로 수집합니다.",
    dateBasis: "HJ FECHA_REGISTRO 결정일. BOE 날짜는 보조 메타데이터로만 저장합니다.",
    translationSummary: "스페인어 원문을 한국어로 요약하고, SENTENCIA는 판결, AUTO는 결정, DECLARACIÓN은 선언으로 표시합니다.",
    compliance: "공개 부적합 표시가 있는 자료는 공개와 자동 요약에서 제외하고 검토 대상으로 둡니다.",
  },
};

const scotusOpinionCategories = [
  {
    name: "Opinions of the Court",
    label: "본안 판결 / 법정 의견",
    status: "현재 수집",
    description:
      "대법원이 사건에 대한 판단과 이유를 공식 의견으로 밝히는 핵심 판례입니다. 미국 헌법 해석의 흐름을 파악할 때 가장 먼저 보아야 하는 자료입니다.",
  },
  {
    name: "Opinions Relating to Orders",
    label: "명령 관련 의견",
    status: "현재 제외",
    description:
      "상고허가 거부나 절차명령 등에 붙은 개별 대법관의 동의·반대 의견입니다. 쟁점 흐름을 읽는 보조 자료가 될 수 있지만, 일반 본안 판결과 성격이 다릅니다.",
  },
  {
    name: "In-Chambers Opinions",
    label: "개별 대법관 긴급 의견",
    status: "현재 제외",
    description:
      "긴급정지, 임시명령, 집행정지 같은 신청을 개별 대법관이 처리하면서 작성하는 의견입니다. 임시구제 성격이 강해 현재 일반 헌법판례 수집 대상에는 넣지 않습니다.",
  },
] as const;

function sourceGuideFor(sourceKey: string) {
  return sourceGuides[sourceKey] ?? defaultSourceGuide;
}

function orderSources(sources: SourceRecord[]) {
  return [...sources].sort((left, right) => {
    const leftIndex = sourceOrder.indexOf(left.sourceKey);
    const rightIndex = sourceOrder.indexOf(right.sourceKey);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    }
    return displaySourceLabel(left).localeCompare(displaySourceLabel(right), "ko");
  });
}

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

async function getCollectionRows(): Promise<CollectionRow[]> {
  const sources = orderSources(await listSources());
  const articleResults = await Promise.all(sources.map((source) => listArticles({ source: source.sourceKey, pageSize: 1, count: "exact" })));

  return sources.map((source, index) => ({
    source,
    guide: sourceGuideFor(source.sourceKey),
    publicCount: articleResults[index]?.pageInfo.total ?? 0,
  }));
}

export default async function GuidePage() {
  const rows = await getCollectionRows();
  const totalPublicCount = rows.reduce((sum, row) => sum + row.publicCount, 0);

  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/guide",
      resultCount: totalPublicCount,
      metadata: { sources: rows.length },
    },
    await headers(),
  );

  return (
    <PageShell className="space-y-10">
      <SectionHeading
        eyebrow="이용 가이드"
        title="World Cons 안내"
        description="World Cons는 주요 헌법재판기관의 공식 자료를 모아 한국어 요약으로 빠르게 훑어보고, 필요할 때 공식 원문으로 확인할 수 있게 만든 큐레이션 서비스입니다."
        descriptionClassName={guideHeadingDescriptionClassName}
      />

      <section className="grid gap-4 md:grid-cols-3" aria-labelledby="guide-purpose">
        <SurfaceCard className="p-5">
          <p className="text-sm font-semibold text-court">목적</p>
          <h2 id="guide-purpose" className="mt-2 text-xl font-semibold tracking-normal text-ink">
            공식 자료를 한국어로 먼저 파악
          </h2>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            여러 나라 헌법재판기관의 최신 자료를 한곳에서 확인하고, 원문을 읽기 전에 사건의 핵심 쟁점과 관련 조문을 빠르게 파악하도록 돕습니다.
          </p>
        </SurfaceCard>
        <SurfaceCard className="p-5">
          <p className="text-sm font-semibold text-court">원칙</p>
          <h2 className="mt-2 text-xl font-semibold tracking-normal text-ink">원문이 최종 기준</h2>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            AI 요약, 번역, 태그, 참조 조문은 참고용입니다. 법적 판단, 논문 인용, 실무 검토에는 반드시 각 기관의 공식 원문을 확인해야 합니다.
          </p>
        </SurfaceCard>
        <SurfaceCard className="p-5">
          <p className="text-sm font-semibold text-court">범위</p>
          <h2 className="mt-2 text-xl font-semibold tracking-normal text-ink">4개 국가 우선 운영</h2>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            현재는 독일, 미국, 프랑스, 스페인 헌법재판 관련 공식 자료 중 2025년과 2026년 자료를 중심으로 수집합니다. 앞으로 수집 연도와 대상 범위는 단계적으로 확대할 예정입니다.
            국가별 날짜 기준과 목록 수집 방식은 서로 다릅니다.
          </p>
        </SurfaceCard>
      </section>

      <section className="space-y-4">
        <SectionHeading
          eyebrow="이용방법"
          title="자료를 찾고 확인하는 순서"
          description="목록에서 빠르게 훑고, 상세 화면에서 요약 구조를 확인한 뒤, 중요한 사안은 공식 원문으로 다시 확인하는 흐름을 권장합니다."
          descriptionClassName={guideHeadingDescriptionClassName}
        />
        <ol className="grid gap-3 md:grid-cols-5">
          {[
            ["1", "최신", "새로 공개된 자료를 날짜순으로 확인합니다."],
            ["2", "필터", "국가, 기관, 기간, 유형, 언어, 태그로 좁힙니다."],
            ["3", "상세", "한줄 요약, 핵심 요약, 배경, 시사점, 참조 조문을 확인합니다."],
            ["4", "태그·용어", "관련 쟁점과 용어를 눌러 비슷한 자료를 이어 봅니다."],
            ["5", "원문", "공식 원문 링크와 보존된 원문 스냅샷으로 최종 확인합니다."],
          ].map(([step, title, description]) => (
            <li key={step} className={surfaceCardClassName("muted", "p-4")}>
              <span className="text-sm font-semibold text-court">{step}</span>
              <h3 className="mt-2 text-base font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-ink-muted">{description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4">
        <SectionHeading
          eyebrow="수집현황"
          title="공개 자료 현황"
          description="아래 건수는 일반 화면에 공개되는 summarized + publishable 자료 기준입니다. 현재는 2025년과 2026년 자료를 우선 수집했으며, 향후 과거 연도와 대상 범위를 단계적으로 확대할 예정입니다."
          descriptionClassName={guideHeadingDescriptionClassName}
        />
        <div className="overflow-x-auto rounded-lg border border-line bg-white shadow-card">
          <table className="min-w-full divide-y divide-line text-left text-sm">
            <thead className="bg-surface-muted/70 text-xs font-semibold uppercase tracking-normal text-ink-subtle">
              <tr>
                <th className="px-4 py-3">국가</th>
                <th className="px-4 py-3">기관</th>
                <th className="px-4 py-3">공개 자료</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.source.sourceKey} className="align-top">
                  <td className="px-4 py-3 font-medium text-ink">{displayJurisdictionLabel(row.source.jurisdiction)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/sources/${row.source.sourceKey}`} className="focus-ring rounded-md font-medium text-primary hover:text-court">
                      {displaySourceLabel(row.source)}
                    </Link>
                    <span className="mt-1 block text-xs text-ink-subtle">{row.source.sourceKey}</span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-ink">{formatNumber(row.publicCount)}건</td>
                </tr>
              ))}
              <tr className="bg-surface-muted/45 font-semibold text-ink">
                <td className="px-4 py-3" colSpan={2}>
                  합계
                </td>
                <td className="px-4 py-3">{formatNumber(totalPublicCount)}건</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading
          eyebrow="수집·번역·요약방법"
          title="사이트별 처리 기준"
          description="각 기관은 목록 제공 방식, 날짜 기준, robots 정책이 다르므로 하나의 방식으로 강제로 맞추지 않습니다."
          descriptionClassName={guideHeadingDescriptionClassName}
        />
        <div className="grid gap-4">
          {rows.map((row) => {
            const sourceHref = safeExternalUrl(row.source.baseUrl);
            return (
            <SurfaceCard key={row.source.sourceKey} className="p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-court">{displayJurisdictionLabel(row.source.jurisdiction)}</p>
                  <h3 className="mt-1 text-xl font-semibold tracking-normal text-ink">{displaySourceLabel(row.source)}</h3>
                  <p className="mt-1 text-sm text-ink-subtle">
                    원문 언어: {displaySourceLanguageLabel(row.source.language)} · 날짜 라벨: {articleDateLabel(row.source.sourceKey)}
                  </p>
                </div>
                {sourceHref ? (
                <a
                  href={sourceHref}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring inline-flex min-h-10 w-fit items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink"
                >
                  공식 사이트
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
                ) : null}
              </div>
              <dl className="mt-5 grid gap-4 md:grid-cols-2">
                <div>
                  <dt className="text-sm font-semibold text-ink">주 자료</dt>
                  <dd className="mt-1 text-sm leading-6 text-ink-muted">{row.guide.primaryMaterial}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold text-ink">날짜 기준</dt>
                  <dd className="mt-1 text-sm leading-6 text-ink-muted">{row.guide.dateBasis}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold text-ink">수집 방법</dt>
                  <dd className="mt-1 text-sm leading-6 text-ink-muted">{row.guide.collectionMethod}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold text-ink">번역·요약</dt>
                  <dd className="mt-1 text-sm leading-6 text-ink-muted">{row.guide.translationSummary}</dd>
                </div>
                <div className="md:col-span-2">
                  <dt className="text-sm font-semibold text-ink">수집 시 준수한 사항</dt>
                  <dd className="mt-1 text-sm leading-6 text-ink-muted">{row.guide.compliance}</dd>
                </div>
              </dl>
            </SurfaceCard>
          );
          })}
        </div>
      </section>

      <section className="space-y-4" aria-label="미국 SCOTUS 수집 범위">
        <SectionHeading
          eyebrow="미국 SCOTUS"
          title="Opinions of the Court만 수집하는 이유"
          description="SCOTUS 공개 자료에는 성격이 다른 의견들이 함께 존재합니다. World Cons는 현재 사용자가 일반적인 헌법판례로 기대하는 본안 판결 중심성을 유지하기 위해 Opinions of the Court만 정기 수집합니다."
          descriptionClassName={guideHeadingDescriptionClassName}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          {scotusOpinionCategories.map((category) => (
            <SurfaceCard key={category.name} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-court">{category.name}</p>
                  <h3 className="mt-2 text-xl font-semibold tracking-normal text-ink">
                    {category.label}
                  </h3>
                </div>
                <span className="shrink-0 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-muted">
                  {category.status}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-ink-muted">{category.description}</p>
            </SurfaceCard>
          ))}
        </div>
        <SurfaceCard className="p-5">
          <h3 className="text-lg font-semibold tracking-normal text-ink">현재 운영 기준</h3>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            Opinions Relating to Orders와 In-Chambers Opinions에도 헌법 쟁점이 언급될 수는 있습니다. 다만 구속력 있는 본안 판단과 보조적·임시적 의견이 한 목록에 섞이면
            공개 카드와 유형 필터가 판례의 성격을 과장하거나 혼동시킬 수 있습니다. 따라서 이 자료들은 향후 별도 보조 자료 분류를 만들 때 검토하고, 현재 수집·요약·공개
            흐름에는 Opinions of the Court만 포함합니다.
          </p>
        </SurfaceCard>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-labelledby="guide-notes">
        <SurfaceCard className="p-5">
          <p className="text-sm font-semibold text-court">공개 기준</p>
          <h2 id="guide-notes" className="mt-2 text-xl font-semibold tracking-normal text-ink">
            화면에 보이는 자료의 조건
          </h2>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-ink-muted">
            <li>원문 수집과 정리가 끝난 자료만 요약 대상으로 보냅니다.</li>
            <li>요약이 완료되고 공개 가능 상태인 자료만 일반 목록에 표시합니다.</li>
            <li>본문이 불완전하거나 공개 적합성 검토가 필요한 자료는 관리자 검토 대상으로 남깁니다.</li>
          </ul>
        </SurfaceCard>
        <SurfaceCard className="p-5">
          <p className="text-sm font-semibold text-court">문의 및 피드백</p>
          <h2 className="mt-2 text-xl font-semibold tracking-normal text-ink">오류를 발견했을 때</h2>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            요약 오류, 번역 오류, 잘못된 참조 조문, 원문 링크 문제를 알려주실 때는 자료 URL, 기관명, 문제가 된 문장, 기대하는 수정 방향을 함께 전달해 주세요.
          </p>
          <p className="mt-3 text-sm leading-7 text-ink-muted">
            중요한 법률 판단이나 인용에는 이 사이트의 요약이 아니라 각 기관의 공식 원문을 우선해 주세요.
          </p>
        </SurfaceCard>
      </section>
    </PageShell>
  );
}
