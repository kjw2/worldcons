import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BackToTopButton } from "@/components/back-to-top-button";
import { FixedChromeToggle } from "@/components/fixed-chrome-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "헌법판례요약시스템",
    template: "%s | 헌법판례요약시스템",
  },
  description: "세계 헌법재판기관의 최신 뉴스와 판례를 한국어 요약으로 탐색하는 큐레이션 플랫폼",
};

const navItems = [
  { href: "/", label: "최신 소식" },
  { href: "/search", label: "검색" },
  { href: "/tags", label: "태그" },
  { href: "/sources", label: "소스" },
  { href: "/glossary", label: "용어" },
  { href: "/admin", label: "관리" },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className="chrome-fixed">
      <body className="min-h-screen antialiased">
        <header id="site-header" className="border-b border-rule/80 bg-white">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link href="/" className="focus-ring flex items-center gap-3 rounded-md">
                <Image
                  src="/logo_image.png"
                  alt="헌법판례요약시스템"
                  width={40}
                  height={39}
                  className="size-10 object-contain"
                  priority
                />
                <span>
                  <span className="block text-lg font-semibold tracking-normal">헌법판례요약시스템</span>
                  <span className="block text-sm text-ink/62">세계 헌법재판 큐레이션</span>
                </span>
              </Link>
              <nav className="flex flex-wrap items-center gap-1 text-sm text-ink/72">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="focus-ring rounded-md px-3 py-2 transition hover:bg-parchment hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </div>
        </header>
        {children}
        <FixedChromeToggle />
        <BackToTopButton />
        <footer id="site-footer" className="h-[85px] border-t border-rule/80 bg-white">
          <div className="mx-auto flex h-full max-w-7xl flex-col items-center justify-center gap-3 px-4 text-center text-sm leading-5 text-ink/62 sm:px-6 lg:px-8">
            <p>2026 CCLIB</p>
            <p>AI 요약은 참고용입니다. 정확한 법적 판단이나 인용은 각 기관의 공식 원문을 확인하세요.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
