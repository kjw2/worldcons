import { BarChart3, BookOpenCheck, ClipboardList, Home, KeyRound, LayoutDashboard, Link2, ListChecks, Newspaper } from "lucide-react";

type AdminTabKey = "operations" | "dashboard" | "articles" | "ingestion-runs" | "candidates" | "llm" | "audit" | "analytics" | "glossary-candidates";

export function AdminTabs({
  active,
}: {
  active: AdminTabKey;
}) {
  const tabs = [
    {
      key: "operations" as const,
      href: "/admin/operations",
      label: "운영 홈",
      icon: Home,
    },
    {
      key: "dashboard" as const,
      href: "/admin",
      label: "대시보드",
      icon: LayoutDashboard,
    },
    {
      key: "articles" as const,
      href: "/admin/articles",
      label: "기사 관리",
      icon: Newspaper,
    },
    {
      key: "ingestion-runs" as const,
      href: "/admin/ingestion-runs",
      label: "실행 기록",
      icon: ListChecks,
    },
    {
      key: "candidates" as const,
      href: "/admin/candidates",
      label: "URL 후보",
      icon: Link2,
    },
    {
      key: "llm" as const,
      href: "/admin/llm",
      label: "LLM 관리",
      icon: KeyRound,
    },
    {
      key: "audit" as const,
      href: "/admin/audit",
      label: "감사 로그",
      icon: ClipboardList,
    },
    {
      key: "analytics" as const,
      href: "/admin/analytics",
      label: "이용 통계",
      icon: BarChart3,
    },
    {
      key: "glossary-candidates" as const,
      href: "/admin/glossary-candidates",
      label: "용어 후보",
      icon: BookOpenCheck,
    },
  ];

  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b border-rule" aria-label="관리자 화면">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const selected = active === tab.key;
        return (
          <a
            key={tab.key}
            href={tab.href}
            aria-current={selected ? "page" : undefined}
            className={`focus-ring -mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition ${
              selected
                ? "border-court text-court"
                : "border-transparent text-ink/60 hover:border-rule hover:text-ink"
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
