"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils/classnames";

const primaryNavigation = [
  { href: "/v2/list", label: "전체 판례" },
  { href: "/v2/sources", label: "기관" },
  { href: "/v2/tags", label: "주제" },
  { href: "/v2/glossary", label: "용어" },
  { href: "/v2/guide", label: "안내" },
] as const;

function isCurrent(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PublicSiteHeader() {
  const pathname = usePathname();

  return (
    <header id="site-header" className="public-site-header border-b border-[#173f34] bg-[#fdfdfb]/98">
      <div className="mx-auto max-w-[1248px] px-4 sm:px-6 lg:px-10">
        <div className="flex min-h-[92px] items-center justify-between gap-5 border-b border-[#ccd4cf] py-4 sm:min-h-[106px]">
          <Link href="/v2" className="focus-ring min-w-0 rounded-sm" aria-label="헌법판례요약시스템 홈">
            <span className="block truncate font-sans text-[20px] font-extrabold leading-none text-[#123d32] sm:text-[30px]">헌법판례요약시스템</span>
            <span className="mt-2 block text-xs font-medium text-[#52635d] sm:text-sm">세계 헌법재판과 헌법 판례</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2 text-sm font-semibold text-[#44554f] sm:gap-5">
            <Link href="/v2/guide" className="focus-ring hidden rounded-sm py-2 hover:text-[#123d32] sm:inline-flex">사이트 안내</Link>
            <Link href="/v2/search" aria-label="검색" title="검색" className="focus-ring inline-flex size-10 items-center justify-center rounded-sm hover:bg-[#eef2ef] hover:text-[#123d32]">
              <Search className="size-5" aria-hidden="true" />
            </Link>
          </div>
        </div>
        <nav className="grid grid-cols-5 overflow-x-auto" aria-label="주요 메뉴">
          {primaryNavigation.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "focus-ring relative flex min-h-12 min-w-[84px] items-center justify-center px-2 text-center text-xs font-semibold text-[#53635d] transition hover:bg-[#f3f6f4] hover:text-[#123d32] sm:min-h-14 sm:text-sm",
                  current && "text-[#123d32] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#123d32]",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
