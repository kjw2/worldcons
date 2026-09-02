import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArticleHistoryRestoration } from "@/components/article-history-restoration";
import { BackToTopButton } from "@/components/back-to-top-button";
import { FixedChromeToggle } from "@/components/fixed-chrome-toggle";
import { NavigationProgress } from "@/components/navigation-progress";
import { PublicSiteHeader } from "@/components/public-site-header";
import { SITE_NAME } from "@/lib/site-brand";
import { getAppBaseUrl, siteVerificationMetadata } from "@/lib/seo/metadata";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(getAppBaseUrl()),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: "세계 헌법재판기관의 최신 뉴스와 판례를 한국어 요약으로 탐색하는 큐레이션 플랫폼",
  alternates: {
    types: {
      "application/rss+xml": `${getAppBaseUrl()}/rss.xml`,
    },
  },
  ...siteVerificationMetadata(),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className="chrome-fixed">
      <body className="min-h-screen antialiased">
        <ArticleHistoryRestoration />
        <PublicSiteHeader />
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
        <FixedChromeToggle />
        <BackToTopButton />
        <footer id="site-footer" className="border-t border-archive-line-strong bg-archive-surface-soft">
          <div className="mx-auto max-w-[1248px] px-4 py-8 text-sm leading-6 text-archive-text sm:px-6 lg:px-10">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-lg font-extrabold tracking-[-0.02em] text-archive-accent">{SITE_NAME}</p>
                <p className="mt-1 font-semibold text-archive-heading">세계 헌법판례 데이터베이스</p>
              </div>
              <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold" aria-label="하단 메뉴">
                <Link href="/guide" className="hover:text-archive-accent">이용안내</Link>
                <Link href="/guide/chatgpt-plugin" className="hover:text-archive-accent">ChatGPT 플러그인</Link>
                <Link href="/sources" className="hover:text-archive-accent">수록기관</Link>
                <a href="/rss.xml" className="hover:text-archive-accent">RSS</a>
              </nav>
            </div>
            <div className="mt-6 border-t border-archive-line pt-5 text-xs leading-6 text-archive-muted">
              <p>각국 헌법재판기관의 공개 자료를 기반으로 제공하며 번역·요약은 참고용입니다. 법적 판단이나 인용에는 반드시 해당 기관의 공식 원문을 확인하세요.</p>
              <p className="mt-1">© 2026 {SITE_NAME}</p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
