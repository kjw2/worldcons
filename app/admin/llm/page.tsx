import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { AdminLlmSettingsPanel } from "@/components/admin-llm-settings-panel";
import { getAdminLlmSettingsView } from "@/lib/ai/llm-settings";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminLlmPage() {
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/llm")}`);
  }

  const settings = await getAdminLlmSettingsView();
  const csrfToken = (await createAdminCsrfToken()) ?? "";

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">System</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">LLM 관리</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            자동요약 provider, 모델, 서버 키 상태를 관리합니다. 저장된 키 값은 다시 표시하지 않습니다.
          </p>
        </div>
        <Link href="/" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
          공개 화면
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <AdminLlmSettingsPanel initialSettings={settings} csrfToken={csrfToken} />
    </div>
  );
}
