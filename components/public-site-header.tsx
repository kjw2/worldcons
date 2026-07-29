"use client";

import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
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
    <header id="site-header" className="public-site-header border-b border-archive-line-strong bg-white/95">
      <div className="mx-auto max-w-[1248px] px-4 sm:px-6 lg:px-10">
        <div className="flex min-h-[92px] items-center justify-between gap-3 border-b border-archive-line py-4 sm:min-h-[106px] sm:gap-5">
          <IntentPrefetchLink href="/v2" className="focus-ring min-w-0 rounded-sm" aria-label="헌법판례요약시스템 홈">
            <span className="block truncate font-sans text-[18px] font-extrabold leading-none text-archive-accent sm:text-[30px]">헌법판례요약시스템</span>
            <span className="mt-2 block text-xs font-medium text-archive-text sm:text-sm">세계 헌법재판과 헌법 판례</span>
          </IntentPrefetchLink>
          <div className="flex shrink-0 items-center gap-1 text-sm font-semibold text-archive-text sm:gap-5">
            <IntentPrefetchLink href="/v2/guide" className="focus-ring hidden rounded-sm py-2 hover:text-archive-accent sm:inline-flex">사이트 안내</IntentPrefetchLink>
            <a
              href="https://worldlaws.cclib.workers.dev/"
              target="_blank"
              rel="noopener noreferrer"
              title="WORLDLAWS 새 창에서 열기"
              className="focus-ring inline-flex rounded-sm py-2 text-[11px] hover:text-archive-accent sm:text-sm"
            >
              WORLDLAWS
            </a>
            <IntentPrefetchLink href="/v2/search" aria-label="검색" title="검색" className="focus-ring inline-flex size-10 items-center justify-center rounded-sm hover:bg-archive-tint hover:text-archive-accent">
              <Search className="size-5" aria-hidden="true" />
            </IntentPrefetchLink>
          </div>
        </div>
        <nav className="grid grid-cols-5 overflow-x-auto" aria-label="주요 메뉴">
          {primaryNavigation.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <IntentPrefetchLink
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "focus-ring relative flex min-h-12 min-w-[84px] items-center justify-center px-2 text-center text-xs font-semibold text-archive-text transition hover:bg-archive-surface hover:text-archive-accent sm:min-h-14 sm:text-sm",
                  current && "text-archive-accent after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-archive-accent",
                )}
              >
                {item.label}
              </IntentPrefetchLink>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
