import { redirect } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { listGlossaryCandidates, languageLabels, jurisdictionFromLanguages } from "@/lib/glossary/candidates";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const tagTypeLabels: Record<string, string> = {
  court: "재판기관",
  country: "국가",
  law: "법령",
  article: "조문",
  right: "권리",
  party: "당사자",
  institution: "기관",
  topic: "쟁점",
  doctrine: "법리",
  procedure: "절차",
  case_type: "사건 유형",
};

export default async function AdminGlossaryCandidatesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const status = getSearchParam(params, "status");
  const authorized = await isAuthorizedPageRequest();
  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/glossary-candidates")}`);
  }

  const result = await listGlossaryCandidates({ limit: 80 });
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const candidates = result.candidates;

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">콘텐츠</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">용어 후보</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            공개 자료 태그에서 자주 등장하지만 용어사전에 아직 연결되지 않은 후보를 검토합니다.
          </p>
        </div>
        <form action="/api/admin/glossary-candidates" method="post">
          <input type="hidden" name="action" value="refresh" />
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
            <RefreshCw className="size-4" aria-hidden="true" />
            후보 갱신
          </button>
        </form>
      </div>

      {status ? (
        <div className="mb-5 rounded-md border border-rule bg-white px-4 py-3 text-sm font-semibold text-ink/72 shadow-sm">
          {status === "approved" ? "용어로 추가했습니다." : status === "ignored" ? "후보를 숨겼습니다." : status === "refreshed" ? "용어 후보를 갱신했습니다." : "요청 결과를 확인할 수 없습니다."}
        </div>
      ) : null}

      {candidates.length === 0 ? (
        <EmptyState title="검토할 용어 후보가 없습니다" description="태그 갱신 후 새 후보가 발견되면 이곳에 표시됩니다." />
      ) : (
        <div className="grid gap-4">
          {candidates.map((candidate) => {
            const defaultJurisdiction = jurisdictionFromLanguages(candidate.sourceLanguages) ?? "";
            return (
              <section key={candidate.id ?? candidate.tagSlug} className="rounded-md border border-rule bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-court">{tagTypeLabels[candidate.tagType] ?? "기타"}</p>
                    <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">{candidate.tagName}</h2>
                    <p className="mt-2 text-sm text-ink/60">
                      자료 {candidate.articleCount.toLocaleString("ko-KR")}건 · 출처 언어: {languageLabels(candidate.sourceLanguages)}
                    </p>
                  </div>
                  {candidate.id ? (
                    <form action="/api/admin/glossary-candidates" method="post">
                      <input type="hidden" name="action" value="ignore" />
                      <input type="hidden" name="csrfToken" value={csrfToken} />
                      <input type="hidden" name="candidateId" value={candidate.id} />
                      <button type="submit" className="focus-ring rounded-md border border-rule bg-white px-3 py-2 text-sm font-semibold text-ink/62 hover:bg-parchment">
                        숨기기
                      </button>
                    </form>
                  ) : null}
                </div>

                <form action="/api/admin/glossary-candidates" method="post" className="mt-4 grid gap-3 md:grid-cols-2">
                  <input type="hidden" name="action" value="approve" />
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  {candidate.id ? <input type="hidden" name="candidateId" value={candidate.id} /> : null}
                  <label className="grid gap-1 text-sm font-semibold text-ink/70">
                    주소 식별자
                    <input name="slug" defaultValue={candidate.suggestedSlug} required className="focus-ring h-10 rounded-md border border-rule px-3 font-normal text-ink" />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-ink/70">
                    원어/대표어
                    <input name="term" defaultValue={candidate.tagName} required className="focus-ring h-10 rounded-md border border-rule px-3 font-normal text-ink" />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-ink/70">
                    한국어명
                    <input name="koreanTerm" defaultValue={/[가-힣]/.test(candidate.tagName) ? candidate.tagName : ""} className="focus-ring h-10 rounded-md border border-rule px-3 font-normal text-ink" />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-ink/70">
                    관할
                    <select name="jurisdiction" defaultValue={defaultJurisdiction} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
                      <option value="">공통</option>
                      <option value="Germany">독일</option>
                      <option value="United States">미국</option>
                      <option value="France">프랑스</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-ink/70 md:col-span-2">
                    정의
                    <textarea name="definition" required rows={3} className="focus-ring rounded-md border border-rule px-3 py-2 font-normal leading-6 text-ink" placeholder="공개 용어사전에 표시할 정의를 입력하세요." />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-ink/70 md:col-span-2">
                    관련 태그
                    <input name="relatedTags" defaultValue={candidate.tagName} className="focus-ring h-10 rounded-md border border-rule px-3 font-normal text-ink" />
                  </label>
                  <div className="md:col-span-2">
                    <button type="submit" className="focus-ring inline-flex min-h-10 items-center rounded-md bg-court px-4 text-sm font-semibold text-white hover:bg-court/90">
                      용어로 추가
                    </button>
                  </div>
                </form>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
