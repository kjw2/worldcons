import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import { CopyToClipboardButton } from "@/components/copy-to-clipboard-button";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { SITE_NAME } from "@/lib/site-brand";

const PLUGIN_ENDPOINT = "https://worldcons.vercel.app/api/mcp";
const OPENAI_APP_GUIDE = "https://developers.openai.com/plugins/deploy/connect-chatgpt";

export const metadata: Metadata = {
  title: "ChatGPT 플러그인",
  description: `${SITE_NAME}의 공개 헌법판례를 ChatGPT 대화에서 검색하고 공식 원문과 함께 확인하는 플러그인의 소개와 연결 방법입니다.`,
  alternates: { canonical: `${getAppBaseUrl()}/guide/chatgpt-plugin` },
};

const starterPrompts = [
  "최근 독일 연방헌법재판소 판례를 핵심 쟁점별로 찾아줘.",
  "게리맨더링과 관련된 미국·독일·프랑스·스페인 판례를 각 나라 법률용어까지 포함해 찾아줘.",
  "표현의 자유와 관련된 프랑스와 스페인 헌법판례를 비교해줘.",
  "이 판례의 한국어 요약과 법원 공식 원문 링크를 함께 보여줘.",
];

export default function ChatGptPluginGuidePage() {
  return (
    <PageShell className="public-archive-page max-w-[1040px] space-y-10 py-6 sm:py-8">
      <div className="border-b border-archive-line-strong pb-8">
        <h1 className="text-3xl font-extrabold tracking-[-0.02em] text-archive-ink sm:text-4xl">{SITE_NAME} ChatGPT 플러그인</h1>
        <p className="mt-4 max-w-3xl text-base leading-8 text-archive-text">
          공개된 세계 헌법판례를 ChatGPT 대화에서 검색하고, 공식 사건 정보와 허용된 원문 발췌를 확인한 뒤 법원 공식 원문으로 이어서 검증할 수 있습니다. 한국어 AI 요약은 준비되어 있고 최신 원문과 일치할 때만 함께 제공합니다.
        </p>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-archive-heading">
          <span>인증 불필요</span>
          <span>읽기 전용</span>
          <span>공식 원문 링크 제공</span>
        </div>
      </div>

      <section className="space-y-4" aria-labelledby="plugin-capabilities">
        <SectionHeading
          title="무엇을 할 수 있나요?"
          description="웹사이트에 공개된 자료만 대상으로 하며, 관리자 기능이나 수집 제어 기능은 제공하지 않습니다."
        />
        <dl id="plugin-capabilities" className="border-y border-archive-line-strong bg-white">
          {[
            ["다국어 대화형 검색", "사건명·사건번호뿐 아니라 한국어·영어·독일어·프랑스어·스페인어의 검토된 법률개념 별칭으로 관련 판례를 검색합니다."],
            ["판례 상태 확인", "공식 사건 정보를 먼저 제공하고, 한국어 AI 요약이 준비됐는지 또는 원문 갱신으로 재처리 중인지 구분해 표시합니다."],
            ["공식 자료 검증", "각 판례의 헌법판례요약시스템 주소와 법원 공식 원문 주소를 함께 제공합니다."],
          ].map(([title, description]) => (
            <div key={title} className="grid gap-2 border-b border-archive-line px-1 py-4 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:px-4">
              <dt className="font-bold text-archive-heading">{title}</dt>
              <dd className="text-sm leading-7 text-archive-text">{description}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-5" aria-labelledby="plugin-connect">
        <SectionHeading
          title="ChatGPT에 연결하는 방법"
          description="OpenAI 플러그인 디렉터리에는 게시하지 않습니다. 지원되는 ChatGPT 계정이나 워크스페이스에서 아래 주소를 직접 연결해 사용합니다."
        />
        <ol id="plugin-connect" className="border-y border-archive-line-strong bg-white">
          {[
            ["1", "개발자 모드 켜기", "ChatGPT에서 설정 → 보안 및 로그인으로 이동한 뒤 개발자 모드를 켭니다. 계정이나 워크스페이스 정책에 따라 이 메뉴가 보이지 않을 수 있습니다."],
            ["2", "플러그인 추가하기", "ChatGPT 플러그인 관리 화면을 열고 + 버튼(플러그인 추가)을 누릅니다."],
            ["3", "연결 정보 입력하기", "이름에는 ‘헌법판례요약시스템’을 입력하고, 연결 방식은 공개 주소를 선택한 뒤 아래 플러그인 연결 주소를 붙여넣습니다. 주소 끝의 /api/mcp까지 모두 입력해야 합니다."],
            ["4", "연결 만들고 도구 확인하기", "인증은 필요하지 않습니다. 연결 만들기를 누르고 검색·판례 조회 도구가 정상적으로 표시되는지 확인합니다."],
            ["5", "새 대화에서 사용하기", "새 채팅의 도구 또는 플러그인 메뉴에서 헌법판례요약시스템을 선택한 뒤 판례 검색을 요청합니다."],
          ].map(([step, title, description]) => (
            <li key={step} className="grid gap-3 border-b border-archive-line px-1 py-5 last:border-b-0 sm:grid-cols-[44px_minmax(0,1fr)] sm:px-4">
              <span className="flex size-9 items-center justify-center rounded-full bg-archive-accent text-sm font-extrabold text-white">{step}</span>
              <div>
                <h2 className="font-bold text-archive-heading">{title}</h2>
                <p className="mt-1 text-sm leading-7 text-archive-text">{description}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="border border-archive-line-strong bg-archive-surface-soft p-5">
          <p className="text-sm font-bold text-archive-heading">플러그인 연결 주소</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <code className="flex min-h-11 min-w-0 flex-1 items-center overflow-x-auto border border-archive-line bg-white px-4 py-3 text-sm text-archive-accent">
              {PLUGIN_ENDPOINT}
            </code>
            <CopyToClipboardButton value={PLUGIN_ENDPOINT} />
          </div>
          <p className="mt-3 text-xs leading-6 text-archive-muted">회원가입, 비밀번호, API 키, OAuth 연결은 필요하지 않습니다.</p>
        </div>
        <a
          href={OPENAI_APP_GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-2 text-sm font-bold text-archive-accent hover:text-archive-accent-hover"
        >
          ChatGPT 플러그인 연결 공식 안내 확인 <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </section>

      <section className="space-y-4" aria-labelledby="plugin-prompts">
        <SectionHeading
          title="이렇게 질문해 보세요"
          description="판례를 인용하거나 법률 판단에 활용할 때에는 답변에 포함된 법원 공식 원문을 반드시 다시 확인하세요."
        />
        <ul id="plugin-prompts" className="border-y border-archive-line-strong bg-white">
          {starterPrompts.map((prompt) => (
            <li key={prompt} className="border-b border-archive-line px-4 py-4 text-sm leading-7 text-archive-heading last:border-b-0">“{prompt}”</li>
          ))}
        </ul>
      </section>

      <section className="grid border-y border-archive-line-strong bg-white md:grid-cols-2" aria-labelledby="plugin-notes">
        <div className="border-b border-archive-line p-5 md:border-b-0 md:border-r">
          <h2 id="plugin-notes" className="font-bold text-archive-heading">자료와 개인정보</h2>
          <p className="mt-2 text-sm leading-7 text-archive-text">플러그인은 공개 판례만 읽습니다. 운영 로그에는 도구 이름, 처리 상태, 소요 시간 같은 진단 정보만 남기며 검색어와 판례 본문은 기록하지 않도록 구성했습니다.</p>
        </div>
        <div className="p-5">
          <h2 className="font-bold text-archive-heading">법률 정보 이용 시 주의</h2>
          <p className="mt-2 text-sm leading-7 text-archive-text">한국어 번역·요약·태그는 AI가 만든 참고 자료이며 법률 자문이나 공인 번역이 아닙니다. 정식 인용과 판단에는 관할 기관의 공식 문서를 기준으로 삼아야 합니다.</p>
        </div>
      </section>

      <div className="border-t border-archive-line-strong pt-6">
        <Link href="/guide" className="focus-ring inline-flex items-center gap-2 text-sm font-bold text-archive-accent hover:text-archive-accent-hover">
          전체 이용안내 보기 <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </PageShell>
  );
}
