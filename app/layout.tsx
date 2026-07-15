import type { Metadata } from "next";
import localFont from "next/font/local";
import { Suspense } from "react";
import { BackToTopButton } from "@/components/back-to-top-button";
import { FixedChromeToggle } from "@/components/fixed-chrome-toggle";
import { NavigationProgress } from "@/components/navigation-progress";
import { PublicSiteHeader } from "@/components/public-site-header";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import "./globals.css";

const nanumSquareNeo = localFont({
  src: [
    {
      path: "./fonts/nanum-square-neo-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/nanum-square-neo-bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-nanum-square-neo",
  display: "swap",
  preload: false,
  fallback: ["Arial", "sans-serif"],
});

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
    <html lang="ko" className={`chrome-fixed ${nanumSquareNeo.variable}`}>
      <body className="min-h-screen antialiased">
        <PublicSiteHeader />
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
        <FixedChromeToggle />
        <BackToTopButton />
        <footer id="site-footer" className="border-t border-[#173f34] bg-[#f7f8f5]">
          <div className="mx-auto flex min-h-[110px] max-w-[1248px] flex-col justify-center gap-2 px-4 py-6 text-sm leading-6 text-[#5d6b66] sm:px-6 lg:px-10">
            <p className="archive-wordmark text-lg font-semibold text-[#123d32]">WORLD CONS</p>
            <p>2026 World Cons · AI 요약은 참고용입니다. 정확한 법적 판단이나 인용은 각 기관의 공식 원문을 확인하세요.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
