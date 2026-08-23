"use client";

import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { cn } from "@/lib/utils/classnames";

const primaryNavigation = [
  { href: "/list", label: "판례" },
  { href: "/sources", label: "국가·기관" },
  { href: "/tags", label: "헌법 쟁점" },
  { href: "/glossary", label: "용어집" },
  { href: "/guide", label: "이용안내" },
] as const;

function isCurrent(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PublicSiteHeader() {
  const pathname = usePathname();

  return (
    <header id="site-header" className="public-site-header border-b border-archive-line-strong bg-white">
      <div className="mx-auto max-w-[1248px] px-4 sm:px-6 lg:px-10">
        <div className="flex min-h-[62px] items-center justify-between gap-4 py-2.5">
          <IntentPrefetchLink href="/" className="focus-ring min-w-0 rounded-sm" aria-label="WORLD CONS 홈">
            <span className="block text-[22px] font-extrabold leading-none tracking-[-0.03em] text-archive-accent sm:text-[28px]">WORLD CONS</span>
            <span className="mt-1.5 block text-[12px] font-medium text-archive-text sm:text-[13px]">세계 헌법판례 데이터베이스</span>
          </IntentPrefetchLink>

          <div className="flex shrink-0 items-center gap-3">
            <a
              href="https://worldlaws.cclib.workers.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex rounded-sm text-xs font-semibold text-archive-text hover:text-archive-accent"
            >
              WORLDLAWS
            </a>
            <IntentPrefetchLink href="/search" aria-label="통합검색" title="통합검색" className="focus-ring inline-flex h-10 items-center gap-2 rounded-sm border border-archive-line px-3 text-sm font-semibold text-archive-text hover:border-archive-accent hover:text-archive-accent">
              <Search className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">통합검색</span>
            </IntentPrefetchLink>
          </div>
        </div>

        <nav className="flex overflow-x-auto border-t border-archive-line" aria-label="주요 메뉴">
          {primaryNavigation.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <IntentPrefetchLink
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "focus-ring relative flex min-h-11 min-w-[92px] items-center justify-center px-4 text-sm font-semibold text-archive-text transition hover:text-archive-accent",
                  current && "text-archive-accent after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-archive-accent",
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
