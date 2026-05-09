import { Search } from "lucide-react";

export function SearchBox({
  defaultValue,
  placeholder = "검색어를 입력하세요",
  action = "/search",
}: {
  defaultValue?: string;
  placeholder?: string;
  action?: string;
}) {
  return (
    <form action={action} className="flex w-full items-center gap-2">
      <label className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink/45" aria-hidden="true" />
        <span className="sr-only">검색어</span>
        <input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="focus-ring h-11 w-full rounded-md border border-rule bg-white px-10 text-sm shadow-sm outline-none placeholder:text-ink/40"
        />
      </label>
      <button type="submit" className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-court px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-court/90">
        <Search className="size-4" aria-hidden="true" />
        검색
      </button>
    </form>
  );
}
