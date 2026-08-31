import { notFound, redirect } from "next/navigation";
import { KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { isAuthorizedPageRequest, isMasterdashSsoOnly, safeAdminNextPath } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminLoginPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  if (isMasterdashSsoOnly()) {
    notFound();
  }

  const params = await resolveSearchParams(searchParams);
  const nextPath = safeAdminNextPath(getSearchParam(params, "next"));
  const alreadyAuthorized = await isAuthorizedPageRequest();

  if (alreadyAuthorized) {
    redirect(nextPath);
  }

  const error = getSearchParam(params, "error");
  const hasError = error === "1";
  const isRateLimited = error === "rate_limit";
  const loggedOut = getSearchParam(params, "loggedOut") === "1";

  return (
    <main className="mx-auto flex min-h-[calc(100vh-180px)] max-w-7xl items-center px-4 py-10 sm:px-6 lg:px-8">
      <section className="mx-auto grid w-full max-w-5xl overflow-hidden rounded-md border border-rule bg-white shadow-sm lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-rule bg-parchment p-8 lg:border-b-0 lg:border-r">
          <div className="inline-flex size-12 items-center justify-center rounded-md border border-court/20 bg-white text-court">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-normal text-ink">관리자 로그인</h1>
          <p className="mt-4 text-sm leading-6 text-ink/68">
            관리자 화면은 수집 실행, 요약 실행, 실패 자료 확인처럼 서비스 데이터에 영향을 주는 기능을 포함합니다.
            아이디와 비밀번호로 로그인한 뒤 사용할 수 있습니다.
          </p>
          <div className="mt-6 rounded-md border border-rule bg-white p-4 text-sm leading-6 text-ink/68">
            <p className="font-semibold text-ink">보안 안내</p>
            <p className="mt-1">허가된 관리자 계정만 로그인할 수 있습니다. 계정 정보는 서버 환경변수로 관리됩니다.</p>
            <p className="mt-4">반복 실패 시 접속 기준으로 일정 시간 로그인이 제한됩니다.</p>
          </div>
        </div>

        <div className="p-8">
          <div className="mb-6">
            <p className="text-sm font-semibold text-court">관리자 인증</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-normal text-ink">아이디와 비밀번호 입력</h2>
          </div>

          {isRateLimited ? (
            <div className="mb-4 rounded-md border border-court/25 bg-court/5 p-3 text-sm text-court">
              로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.
            </div>
          ) : hasError ? (
            <div className="mb-4 rounded-md border border-court/25 bg-court/5 p-3 text-sm text-court">
              아이디 또는 비밀번호가 맞지 않습니다.
            </div>
          ) : null}

          {loggedOut ? (
            <div className="mb-4 rounded-md border border-mint/25 bg-mint/5 p-3 text-sm text-mint">
              로그아웃되었습니다.
            </div>
          ) : null}

          <form action="/api/admin/login" method="post" className="grid gap-4">
            <input type="hidden" name="next" value={nextPath} />
            <label className="grid gap-2 text-sm font-semibold text-ink/72">
              아이디
              <span className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink/40" aria-hidden="true" />
                <input
                  name="username"
                  type="text"
                  autoComplete="username"
                  className="focus-ring h-11 w-full rounded-md border border-rule bg-white pl-10 pr-3 text-sm text-ink"
                  required
                />
              </span>
            </label>
            <label className="grid gap-2 text-sm font-semibold text-ink/72">
              비밀번호
              <span className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink/40" aria-hidden="true" />
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  className="focus-ring h-11 w-full rounded-md border border-rule bg-white pl-10 pr-3 text-sm text-ink"
                  required
                />
              </span>
            </label>
            <button type="submit" className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90">
              <LogIn className="size-4" aria-hidden="true" />
              로그인
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
