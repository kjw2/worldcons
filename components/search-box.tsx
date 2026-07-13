import { Search } from "lucide-react";
import { cn } from "@/lib/utils/classnames";

export function SearchBox({
  defaultValue,
  placeholder,
  action = "/search",
  variant = "compact",
  hiddenFields = [],
}: {
  defaultValue?: string;
  placeholder?: string;
  action?: string;
  variant?: "hero" | "compact";
  hiddenFields?: Array<[string, string]>;
}) {
  const isHero = variant === "hero";
  const resolvedPlaceholder = placeholder ?? (isHero ? "표현의 자유, 선거, QPC, First Amendment" : "검색어를 입력하세요");

  return (
    <form action={action} className={cn("flex w-full items-center gap-2", isHero ? "max-w-3xl" : "")}>
      {hiddenFields.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="relative min-w-0 flex-1">
        <Search
          className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-subtle", isHero ? "left-4 size-5" : "left-3 size-4")}
          aria-hidden="true"
        />
        <span className="sr-only">검색어</span>
        <input
          name="q"
          defaultValue={defaultValue}
          placeholder={resolvedPlaceholder}
          className={cn(
            "focus-ring w-full rounded-sm border border-[#cbd4ce] bg-white outline-none placeholder:text-[#8b9691]",
            isHero ? "h-14 px-12 text-base" : "h-11 px-10 text-sm",
          )}
        />
      </label>
      <button
        type="submit"
        className={cn(
          "focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-sm bg-[#123d32] font-semibold text-white transition hover:bg-[#285748]",
          isHero ? "h-14 px-5 text-base" : "h-11 px-4 text-sm",
        )}
      >
        <Search className="size-4" aria-hidden="true" />
        검색
      </button>
    </form>
  );
}
