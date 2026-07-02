import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BackToTopButton } from "@/components/back-to-top-button";
import { FixedChromeToggle } from "@/components/fixed-chrome-toggle";
import { NavigationProgress } from "@/components/navigation-progress";
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

const navItems = [
  { href: "/", label: "최신" },
  { href: "/list", label: "리스트" },
  { href: "/tags", label: "태그" },
  { href: "/sources", label: "기관" },
  { href: "/glossary", label: "용어" },
  { href: "/guide", label: "안내" },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className="chrome-fixed">
      <body className="min-h-screen antialiased">
        <header id="site-header" className="border-b border-line bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
            <Link href="/" className="focus-ring flex items-center gap-3 rounded-lg">
              <span>
                <span className="block text-lg font-semibold tracking-normal text-ink">헌법판례요약시스템</span>
                <span className="block text-sm text-ink-muted">세계 헌법재판 큐레이션</span>
              </span>
            </Link>
            <div className="flex min-w-0 items-center justify-between gap-2 sm:justify-end">
              <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm text-ink-muted sm:flex-none">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    className="focus-ring whitespace-nowrap rounded-lg px-3 py-2 font-medium transition hover:bg-surface-muted hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </div>
        </header>
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
        <FixedChromeToggle />
        <BackToTopButton />
        <footer id="site-footer" className="h-[85px] border-t border-line bg-white">
          <div className="mx-auto flex h-full max-w-7xl flex-col items-center justify-center gap-3 px-4 text-center text-sm leading-5 text-ink-muted sm:px-6 lg:px-8">
            <p>2026 World Cons</p>
            <p>AI 요약은 참고용입니다. 정확한 법적 판단이나 인용은 각 기관의 공식 원문을 확인하세요.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
