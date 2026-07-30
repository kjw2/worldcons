import type { Metadata } from "next";
import { Suspense } from "react";
import { ArticleHistoryRestoration } from "@/components/article-history-restoration";
import { BackToTopButton } from "@/components/back-to-top-button";
import { FixedChromeToggle } from "@/components/fixed-chrome-toggle";
import { NavigationProgress } from "@/components/navigation-progress";
import { PublicSiteHeader } from "@/components/public-site-header";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "헌법판례요약시스템",
    template: "%s | 헌법판례요약시스템",
  },
  description: "세계 헌법재판기관의 최신 뉴스와 판례를 한국어 요약으로 탐색하는 큐레이션 플랫폼",
  alternates: {
    types: {
      "application/rss+xml": `${getAppBaseUrl()}/rss.xml`,
    },
  },
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
          <div className="mx-auto flex min-h-[110px] max-w-[1248px] flex-col justify-center gap-2 px-4 py-6 text-sm leading-6 text-archive-text sm:px-6 lg:px-10">
            <p className="archive-wordmark text-lg font-semibold text-archive-accent">WORLD CONS</p>
            <p>2026 World Cons · AI 요약은 참고용입니다. 정확한 법적 판단이나 인용은 각 기관의 공식 원문을 확인하세요.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
