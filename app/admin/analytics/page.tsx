import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, BarChart3, Bot, CalendarDays, Database, Hash, LogOut, Search, TrendingUp } from "lucide-react";
import { AdminTabs } from "@/components/admin-tabs";
import { getAnalyticsDashboardData, type AnalyticsDashboardData, type DimensionStat } from "@/lib/db/analytics";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatPercent(value: number) {
  return `${formatNumber(value)}%`;
}

function formatDateTime(input?: string | null) {
  if (!input) return "없음";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function withParams(path: string, params: { secret?: string | null; days?: number }) {
  const searchParams = new URLSearchParams();
  if (params.secret) searchParams.set("secret", params.secret);
  if (params.days) searchParams.set("days", String(params.days));
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

function rangeFromParam(value?: string | null) {
  const days = Number(value ?? 30);
  return Number.isFinite(days) && [7, 30, 90, 180].includes(days) ? days : 30;
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-ink/64">{title}</span>
        <span className="inline-flex size-9 items-center justify-center rounded-md border border-rule bg-parchment text-court">
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <div className="text-3xl font-semibold tracking-normal text-ink">{value}</div>
      <p className="mt-2 text-sm leading-5 text-ink/62">{detail}</p>
    </section>
  );
}

function EmptyState({ text = "아직 집계할 데이터가 없습니다." }: { text?: string }) {
  return <div className="rounded-md border border-dashed border-rule bg-parchment/35 px-4 py-8 text-center text-sm text-ink/58">{text}</div>;
}

function DimensionList({ title, data }: { title: string; data: DimensionStat[] }) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-normal text-ink">{title}</h2>
        <BarChart3 className="size-5 text-ink/45" aria-hidden="true" />
      </div>
      {data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-2">
          {data.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-3 rounded-md border border-rule bg-parchment/40 px-3 py-2 text-sm">
              <span className="break-all font-medium text-ink/72">{item.key}</span>
              <span className="font-semibold text-ink">{formatNumber(item.count)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PopularArticlesTable({ data }: { data: AnalyticsDashboardData["popularArticles"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">콘텐츠 관심도</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">인기 자료</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">자료</th>
                <th className="px-4 py-3">국가</th>
                <th className="px-4 py-3">수집원</th>
                <th className="px-4 py-3">조회</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((article) => (
                <tr key={article.slug}>
                  <td className="max-w-xl px-4 py-3">
                    <Link href={`/articles/${article.slug}`} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
                      {article.title}
                    </Link>
                    <div className="mt-1 text-xs text-ink/45">{article.slug}</div>
                  </td>
                  <td className="px-4 py-3">{article.jurisdiction ?? "-"}</td>
                  <td className="px-4 py-3">{article.sourceKey ?? "-"}</td>
                  <td className="px-4 py-3 font-semibold">{formatNumber(article.views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SearchTable({
  title,
  data,
  zeroOnly = false,
}: {
  title: string;
  data: AnalyticsDashboardData["searchQueries"];
  zeroOnly?: boolean;
}) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">{zeroOnly ? "콘텐츠 공백" : "검색 이용"}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">{title}</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState text={zeroOnly ? "최근 무결과 검색이 없습니다." : "최근 검색어가 없습니다."} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">검색어</th>
                <th className="px-4 py-3">검색</th>
                <th className="px-4 py-3">0건</th>
                <th className="px-4 py-3">평균 결과</th>
                <th className="px-4 py-3">방식</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((item) => (
                <tr key={item.query}>
                  <td className="px-4 py-3 font-semibold text-ink">{item.query}</td>
                  <td className="px-4 py-3">{formatNumber(item.count)}</td>
                  <td className={item.zeroResultCount > 0 ? "px-4 py-3 font-semibold text-court" : "px-4 py-3"}>{formatNumber(item.zeroResultCount)}</td>
                  <td className="px-4 py-3">{formatNumber(item.averageResults)}</td>
                  <td className="px-4 py-3">{item.modes.join(", ") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TagTable({ data }: { data: AnalyticsDashboardData["tagInteractions"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">태그 이용</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">태그 클릭·조회</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">태그</th>
                <th className="px-4 py-3">클릭</th>
                <th className="px-4 py-3">페이지 조회</th>
                <th className="px-4 py-3">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((tag) => (
                <tr key={tag.slug}>
                  <td className="px-4 py-3">
                    <Link href={`/tags/${tag.slug}`} className="focus-ring inline-flex items-center gap-2 rounded-sm font-semibold text-ink hover:text-court">
                      <Hash className="size-4" aria-hidden="true" />
                      {tag.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{formatNumber(tag.clicks)}</td>
                  <td className="px-4 py-3">{formatNumber(tag.views)}</td>
                  <td className="px-4 py-3 font-semibold">{formatNumber(tag.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TimelineTable({
  title,
  data,
}: {
  title: string;
  data: AnalyticsDashboardData["dailyTimeline"];
}) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">기간별 집계</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">{title}</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState text="아직 기간별 이벤트가 없습니다." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">기간</th>
                <th className="px-4 py-3">전체</th>
                <th className="px-4 py-3">페이지</th>
                <th className="px-4 py-3">자료</th>
                <th className="px-4 py-3">검색</th>
                <th className="px-4 py-3">0건</th>
                <th className="px-4 py-3">태그</th>
                <th className="px-4 py-3">관리자</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((item) => (
                <tr key={item.key}>
                  <td className="px-4 py-3 font-semibold text-ink">{item.label}</td>
                  <td className="px-4 py-3">{formatNumber(item.total)}</td>
                  <td className="px-4 py-3">{formatNumber(item.pageViews)}</td>
                  <td className="px-4 py-3">{formatNumber(item.articleViews)}</td>
                  <td className="px-4 py-3">{formatNumber(item.searches)}</td>
                  <td className={item.zeroResultSearches > 0 ? "px-4 py-3 font-semibold text-court" : "px-4 py-3"}>{formatNumber(item.zeroResultSearches)}</td>
                  <td className="px-4 py-3">{formatNumber(item.tagEvents)}</td>
                  <td className="px-4 py-3">{formatNumber(item.adminActions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AccessLogTable({ data }: { data: AnalyticsDashboardData["accessLogs"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">접속 로그</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">최근 이벤트</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState text="최근 접속 로그가 없습니다." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">시각</th>
                <th className="px-4 py-3">유형</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">내용</th>
                <th className="px-4 py-3">경로</th>
                <th className="px-4 py-3">지역/유입</th>
                <th className="px-4 py-3">환경</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((item) => (
                <tr key={`${item.occurredAt}:${item.eventType}:${item.path}:${item.label}`}>
                  <td className="whitespace-nowrap px-4 py-3">{formatDateTime(item.occurredAt)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border border-rule bg-parchment px-2 py-1 text-xs font-semibold text-ink/64">{item.eventType}</span>
                    {item.isBot ? <div className="mt-1 text-xs font-semibold text-court">bot</div> : null}
                  </td>
                  <td className="max-w-44 break-all px-4 py-3">
                    <div className="font-semibold text-ink">{item.clientIp ?? "-"}</div>
                    {item.clientIpHash ? <div className="mt-1 text-xs text-ink/40">{item.clientIpHash.slice(0, 12)}</div> : null}
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <div className="font-semibold text-ink">{item.label}</div>
                    {typeof item.resultCount === "number" ? <div className="mt-1 text-xs text-ink/45">결과 {formatNumber(item.resultCount)}건</div> : null}
                  </td>
                  <td className="max-w-xs break-all px-4 py-3 text-ink/64">{item.path ?? "-"}</td>
                  <td className="px-4 py-3">
                    <div>{item.location ?? "-"}</div>
                    <div className="mt-1 text-xs text-ink/45">{item.referrerHost ?? "-"}</div>
                  </td>
                  <td className="max-w-sm px-4 py-3">
                    <div>{item.deviceType ?? "-"}</div>
                    <div className="mt-1 text-xs text-ink/45">{item.userAgentFamily ?? "-"}</div>
                    {item.userAgent ? <div className="mt-1 line-clamp-2 text-xs text-ink/40">{item.userAgent}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CollectionHealthTable({ data }: { data: AnalyticsDashboardData["collectionHealth"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">수집 품질</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">수집 성공률</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState text="최근 수집 실행 기록이 없습니다." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">수집원</th>
                <th className="px-4 py-3">실행</th>
                <th className="px-4 py-3">완료/실패</th>
                <th className="px-4 py-3">발견</th>
                <th className="px-4 py-3">수집</th>
                <th className="px-4 py-3">실패 항목</th>
                <th className="px-4 py-3">fetch rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((source) => (
                <tr key={source.sourceKey}>
                  <td className="px-4 py-3 font-semibold">{source.sourceKey}</td>
                  <td className="px-4 py-3">{formatNumber(source.runs)}</td>
                  <td className="px-4 py-3">
                    {formatNumber(source.completedRuns)} / <span className={source.failedRuns > 0 ? "font-semibold text-court" : undefined}>{formatNumber(source.failedRuns)}</span>
                  </td>
                  <td className="px-4 py-3">{formatNumber(source.discovered)}</td>
                  <td className="px-4 py-3">{formatNumber(source.fetched)}</td>
                  <td className="px-4 py-3">{formatNumber(source.failedItems)}</td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-32 items-center gap-3">
                      <div className="h-2 flex-1 rounded-full bg-rule">
                        <div className="h-2 rounded-full bg-mint" style={{ width: `${source.fetchRate}%` }} />
                      </div>
                      <span className="w-12 text-right text-xs font-semibold text-ink/64">{formatPercent(source.fetchRate)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelHealthTable({ data }: { data: AnalyticsDashboardData["modelHealth"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">요약 품질</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">모델별 성공·실패</h2>
      </div>
      {data.length === 0 ? (
        <div className="p-5">
          <EmptyState text="요약 모델 통계가 없습니다." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold uppercase text-ink/60">
                <th className="px-4 py-3">제공자</th>
                <th className="px-4 py-3">모델</th>
                <th className="px-4 py-3">성공</th>
                <th className="px-4 py-3">실패</th>
                <th className="px-4 py-3">실패율</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.map((model) => (
                <tr key={`${model.provider}:${model.model}`}>
                  <td className="px-4 py-3">{model.provider}</td>
                  <td className="px-4 py-3 font-semibold">{model.model}</td>
                  <td className="px-4 py-3">{formatNumber(model.successes)}</td>
                  <td className={model.failures > 0 ? "px-4 py-3 font-semibold text-court" : "px-4 py-3"}>{formatNumber(model.failures)}</td>
                  <td className="px-4 py-3">{formatPercent(model.failureRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecommendationPanel({ items }: { items: string[] }) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">추천 점검</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">다음 개선 후보</h2>
        </div>
        <TrendingUp className="size-5 text-court" aria-hidden="true" />
      </div>
      <ul className="grid gap-2">
        {items.map((item) => (
          <li key={item} className="rounded-md border border-rule bg-parchment/40 px-3 py-2 text-sm leading-6 text-ink/72">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function AdminAnalyticsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const secret = getSearchParam(params, "secret");
  const authorized = await isAuthorizedPageRequest(secret);

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent(secret ? `/admin/analytics?secret=${secret}` : "/admin/analytics")}`);
  }

  const days = rangeFromParam(getSearchParam(params, "days"));
  const dashboard = await getAnalyticsDashboardData({ days });

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">이용 통계</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            공개 자료 이용, 검색 공백, 태그 관심도, 수집 성공률, 요약 모델 품질을 함께 확인합니다.
          </p>
        </div>
        <form action="/api/admin/logout" method="post">
          <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
            <LogOut className="size-4" aria-hidden="true" />
            로그아웃
          </button>
        </form>
      </div>

      <AdminTabs active="analytics" secret={secret} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <span>데이터 기준: {dashboard.hasDatabase ? (dashboard.schemaReady ? "Supabase site_events" : "Supabase, migration 필요") : "Mock 데이터"}</span>
        <span>갱신 시각: {formatDateTime(dashboard.generatedAt)}</span>
        <div className="flex flex-wrap gap-1">
          {[7, 30, 90, 180].map((range) => (
            <Link
              key={range}
              href={withParams("/admin/analytics", { secret, days: range })}
              className={`focus-ring rounded-md px-3 py-1.5 font-semibold ${dashboard.days === range ? "bg-ink text-white" : "bg-parchment text-ink/66 hover:bg-rule"}`}
            >
              {range}일
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="전체 이벤트" value={formatNumber(dashboard.totals.totalEvents)} detail={`${dashboard.days}일 동안 저장된 접속·이용 로그`} icon={CalendarDays} />
        <MetricCard title="페이지 조회" value={formatNumber(dashboard.totals.pageViews + dashboard.totals.articleViews + dashboard.totals.tagViews + dashboard.totals.sourceViews)} detail={`${formatNumber(dashboard.totals.articleViews)}회는 공개 자료 상세 조회`} icon={Database} />
        <MetricCard title="검색" value={formatNumber(dashboard.totals.searches)} detail={`${formatNumber(dashboard.totals.zeroResultSearches)}회는 결과 0건`} icon={Search} />
        <MetricCard title="태그 클릭" value={formatNumber(dashboard.totals.tagClicks)} detail={`${formatNumber(dashboard.totals.adminActions)}회 관리자 작업`} icon={Hash} />
      </div>

      <div className="mt-6 grid gap-6">
        <RecommendationPanel items={dashboard.recommendations} />
        <div className="grid gap-6 xl:grid-cols-2">
          <TimelineTable title="일별 집계" data={dashboard.dailyTimeline} />
          <TimelineTable title="월별 집계" data={dashboard.monthlyTimeline} />
        </div>
        <AccessLogTable data={dashboard.accessLogs} />
        <PopularArticlesTable data={dashboard.popularArticles} />
        <div className="grid gap-6 xl:grid-cols-2">
          <SearchTable title="검색어 순위" data={dashboard.searchQueries} />
          <SearchTable title="검색 결과 0건" data={dashboard.zeroResultQueries} zeroOnly />
        </div>
        <TagTable data={dashboard.tagInteractions} />
        <div className="grid gap-6 xl:grid-cols-2">
          <CollectionHealthTable data={dashboard.collectionHealth} />
          <ModelHealthTable data={dashboard.modelHealth} />
        </div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <DimensionList title="국가별 조회" data={dashboard.jurisdictionViews} />
          <DimensionList title="기관별 조회" data={dashboard.sourceViews} />
          <DimensionList title="접속 IP" data={dashboard.clientIps} />
          <DimensionList title="접속 국가" data={dashboard.clientCountries} />
        </div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <DimensionList title="유입 호스트" data={dashboard.referrers} />
          <DimensionList title="디바이스" data={dashboard.devices} />
          <DimensionList title="브라우저" data={dashboard.userAgents} />
          <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-normal text-ink">관리자 작업 종류</h2>
              <Bot className="size-5 text-ink/45" aria-hidden="true" />
            </div>
            {dashboard.adminActions.length === 0 ? (
              <EmptyState text="최근 관리자 작업 이벤트가 없습니다." />
            ) : (
              <div className="grid gap-2">
                {dashboard.adminActions.map((item) => (
                  <div key={item.action} className="flex items-center justify-between gap-3 rounded-md border border-rule bg-parchment/40 px-3 py-2 text-sm">
                    <span className="font-medium text-ink/72">{item.action}</span>
                    <span className="font-semibold text-ink">{formatNumber(item.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
