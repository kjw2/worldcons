import { BarChart3, LayoutDashboard, ListChecks } from "lucide-react";

function withSecret(path: string, secret?: string | null) {
  return secret ? `${path}?secret=${encodeURIComponent(secret)}` : path;
}

export function AdminTabs({
  active,
  secret,
}: {
  active: "dashboard" | "analytics" | "ingestion-runs";
  secret?: string | null;
}) {
  const tabs = [
    {
      key: "dashboard" as const,
      href: withSecret("/admin", secret),
      label: "대시보드",
      icon: LayoutDashboard,
    },
    {
      key: "analytics" as const,
      href: withSecret("/admin/analytics", secret),
      label: "이용 통계",
      icon: BarChart3,
    },
    {
      key: "ingestion-runs" as const,
      href: withSecret("/admin/ingestion-runs", secret),
      label: "실행 기록",
      icon: ListChecks,
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
