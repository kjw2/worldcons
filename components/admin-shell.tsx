"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BookOpenCheck,
  ClipboardList,
  ExternalLink,
  Home,
  KeyRound,
  Link2,
  ListChecks,
  LogOut,
  Menu,
  Newspaper,
  PanelLeftClose,
  Route,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";

interface AdminNavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

const primaryNavigation: AdminNavigationItem[] = [
  { href: "/admin", label: "Operations overview", icon: Home, exact: true },
  { href: "/admin/work", label: "Unified work queue", icon: ListChecks },
  { href: "/admin/operations", label: "Legacy triage", icon: Route },
];

const contentNavigation: AdminNavigationItem[] = [
  { href: "/admin/articles", label: "Articles", icon: Newspaper },
  { href: "/admin/candidates", label: "URL candidates", icon: Link2 },
  { href: "/admin/glossary-candidates", label: "Glossary candidates", icon: BookOpenCheck },
];

const systemNavigation: AdminNavigationItem[] = [
  { href: "/admin/ingestion-runs", label: "Ingestion runs", icon: ListChecks },
  { href: "/admin/jobs", label: "Legacy job queue", icon: PanelLeftClose },
  { href: "/admin/audit", label: "Audit", icon: ClipboardList },
  { href: "/admin/llm", label: "LLM settings", icon: KeyRound },
  { href: "/admin/analytics", label: "Analytics", icon: BarChart3 },
];

const allNavigation = [...primaryNavigation, ...contentNavigation, ...systemNavigation];

function isCurrent(pathname: string, item: AdminNavigationItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavigationGroup({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label: string;
  items: AdminNavigationItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <section aria-labelledby={`admin-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <h2 id={`admin-nav-${label.toLowerCase().replace(/\s+/g, "-")}`} className="px-3 text-xs font-semibold uppercase text-ink/45">
        {label}
      </h2>
      <nav className="mt-2 grid gap-1" aria-label={label}>
        {items.map((item) => {
          const Icon = item.icon;
          const current = isCurrent(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              className={`focus-ring flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-semibold transition ${
                current ? "bg-ink text-white" : "text-ink/68 hover:bg-parchment hover:text-ink"
              }`}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
function Navigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="grid gap-6">
      <NavigationGroup label="Operate" items={primaryNavigation} pathname={pathname} onNavigate={onNavigate} />
      <NavigationGroup label="Content" items={contentNavigation} pathname={pathname} onNavigate={onNavigate} />
      <NavigationGroup label="System" items={systemNavigation} pathname={pathname} onNavigate={onNavigate} />
    </div>
  );
}

export function AdminShell({ children, csrfToken, identity }: { children: React.ReactNode; csrfToken: string; identity: string }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useMemo(
    () => allNavigation.find((item) => isCurrent(pathname, item))?.label ?? "Administrator",
    [pathname],
  );

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [mobileOpen]);

  if (pathname === "/admin/login") return children;

  return (
    <div className="admin-shell min-h-screen bg-[#f5f6f7] text-ink">
      <a href="#admin-main" className="focus-ring fixed left-3 top-3 z-[70] -translate-y-20 rounded-md bg-white px-3 py-2 text-sm font-semibold shadow-panel focus:translate-y-0">
        Skip to administrator content
      </a>

      <div className="grid min-h-screen min-w-0 lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="hidden border-r border-rule bg-white lg:flex lg:min-h-screen lg:flex-col" aria-label="Administrator navigation">
          <div className="border-b border-rule px-5 py-5">
            <Link href="/admin" className="focus-ring block rounded-sm">
              <span className="block text-base font-semibold text-ink">WorldCons Admin</span>
              <span className="mt-1 block text-xs text-ink/50">Operations workspace</span>
            </Link>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-5">
            <Navigation pathname={pathname} />
          </div>
          <div className="border-t border-rule p-3">
            <Link href="/" className="focus-ring flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold text-ink/62 hover:bg-parchment">
              <ExternalLink className="size-4" aria-hidden="true" />
              Public site
            </Link>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-30 border-b border-rule bg-white/95 backdrop-blur">
            <div className="flex min-h-16 min-w-0 items-center justify-between gap-3 px-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobileOpen(true)}
                  className="focus-ring inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-rule text-ink/70 hover:bg-parchment lg:hidden"
                  aria-label="Open administrator navigation"
                  title="Open navigation"
                >
                  <Menu className="size-5" aria-hidden="true" />
                </button>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-court">Administrator</p>
                  <p className="truncate text-sm font-semibold text-ink" aria-live="polite">{location}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="hidden min-w-0 items-center gap-2 border-r border-rule pr-3 sm:flex">
                  <UserRound className="size-4 shrink-0 text-ink/45" aria-hidden="true" />
                  <span className="max-w-44 truncate text-xs font-semibold text-ink/62">{identity}</span>
                </div>
                <form action="/api/admin/logout" method="post">
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <button
                    type="submit"
                    className="focus-ring inline-flex size-10 items-center justify-center rounded-md border border-rule text-ink/64 hover:bg-parchment"
                    aria-label="Sign out"
                    title="Sign out"
                  >
                    <LogOut className="size-4" aria-hidden="true" />
                  </button>
                </form>
              </div>
            </div>
          </header>

          <main id="admin-main" tabIndex={-1} className="min-w-0 overflow-x-clip">
            {children}
          </main>
        </div>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Administrator navigation">
          <button type="button" className="absolute inset-0 bg-ink/35" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />
          <aside className="absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col border-r border-rule bg-white shadow-panel">
            <div className="flex min-h-16 items-center justify-between border-b border-rule px-4">
              <span className="font-semibold text-ink">WorldCons Admin</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="focus-ring inline-flex size-10 items-center justify-center rounded-md border border-rule text-ink/68"
                aria-label="Close administrator navigation"
                title="Close navigation"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-5">
              <Navigation pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
