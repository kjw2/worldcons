import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, LogOut } from "lucide-react";
import { AdminLlmSettingsPanel } from "@/components/admin-llm-settings-panel";
import { AdminTabs } from "@/components/admin-tabs";
import { getAdminLlmSettingsView } from "@/lib/ai/llm-settings";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminLlmPage() {
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/llm")}`);
  }

  const settings = await getAdminLlmSettingsView();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">LLM 관리</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            자동요약 provider, 모델, 서버 키 상태를 관리합니다. 저장된 키 값은 다시 표시하지 않습니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
            공개 화면
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <form action="/api/admin/logout" method="post">
            <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
              <LogOut className="size-4" aria-hidden="true" />
              로그아웃
            </button>
          </form>
        </div>
      </div>

      <AdminTabs active="llm" />
      <AdminLlmSettingsPanel initialSettings={settings} />
    </main>
  );
}

