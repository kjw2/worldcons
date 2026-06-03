import { BarChart3, BookOpenCheck, KeyRound, LayoutDashboard, ListChecks } from "lucide-react";

export function AdminTabs({
  active,
}: {
  active: "dashboard" | "analytics" | "ingestion-runs" | "glossary-candidates" | "llm";
}) {
  const tabs = [
    {
      key: "dashboard" as const,
      href: "/admin",
      label: "대시보드",
      icon: LayoutDashboard,
    },
    {
      key: "analytics" as const,
      href: "/admin/analytics",
      label: "이용 통계",
      icon: BarChart3,
    },
    {
      key: "ingestion-runs" as const,
      href: "/admin/ingestion-runs",
      label: "실행 기록",
      icon: ListChecks,
    },
    {
      key: "glossary-candidates" as const,
      href: "/admin/glossary-candidates",
      label: "용어 후보",
      icon: BookOpenCheck,
    },
    {
      key: "llm" as const,
      href: "/admin/llm",
      label: "LLM 관리",
      icon: KeyRound,
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
