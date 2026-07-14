"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquareText, Scale, ShieldCheck, Vote } from "lucide-react";
import type { TagSummary } from "@/lib/db/types";
import { cn } from "@/lib/utils/classnames";

const PAGE_SIZE = 4;
const AUTO_ROTATE_MS = 10_000;
const issueIcons = [MessageSquareText, Vote, ShieldCheck, Scale] as const;

export function IssueTopicCarousel({ tags }: { tags: TagSummary[] }) {
  const pages = useMemo(
    () => Array.from({ length: Math.ceil(tags.length / PAGE_SIZE) }, (_, index) => tags.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)),
    [tags],
  );
  const [page, setPage] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, pages.length - 1)));
  }, [pages.length]);

  useEffect(() => {
    if (!autoRotate || isPaused || pages.length <= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setPage((current) => (current + 1) % pages.length), AUTO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [autoRotate, isPaused, pages.length]);

  if (pages.length === 0) return null;

  function selectPage(nextPage: number) {
    setAutoRotate(false);
    setPage((nextPage + pages.length) % pages.length);
  }

  return (
    <section
      className="mb-9"
      aria-labelledby="issue-trackers"
      onPointerEnter={() => setIsPaused(true)}
      onPointerLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsPaused(false);
      }}
    >
      <div className="archive-rule-title mb-3 flex min-h-9 items-start justify-between gap-4">
        <h2 id="issue-trackers" className="text-base font-semibold text-[#243b33]">주요 헌법 쟁점</h2>
        {pages.length > 1 ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs tabular-nums text-[#74817c]">{page + 1} / {pages.length}</span>
            <button type="button" onClick={() => selectPage(page - 1)} aria-label="이전 헌법 주제" title="이전 헌법 주제" className="focus-ring inline-flex size-8 items-center justify-center rounded-sm border border-[#c8d2cc] bg-white text-[#456056] hover:border-[#879a90] hover:text-[#123d32]"><ChevronLeft className="size-4" aria-hidden="true" /></button>
            <button type="button" onClick={() => selectPage(page + 1)} aria-label="다음 헌법 주제" title="다음 헌법 주제" className="focus-ring inline-flex size-8 items-center justify-center rounded-sm border border-[#c8d2cc] bg-white text-[#456056] hover:border-[#879a90] hover:text-[#123d32]"><ChevronRight className="size-4" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>

      <div key={page} className="issue-carousel-page -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-4">
        {pages[page].map((tag, index) => {
          const Icon = issueIcons[(page * PAGE_SIZE + index) % issueIcons.length];
          return (
            <Link key={tag.slug} href={`/v2/tags/${tag.slug}`} prefetch={false} className="focus-ring group grid min-h-28 min-w-[84%] snap-start grid-cols-[42px_minmax(0,1fr)_auto] gap-3 rounded-sm border border-[#d4dcd7] bg-white p-4 transition hover:border-[#829b8e] hover:bg-[#f8faf8] sm:min-w-0">
              <span className="inline-flex size-10 items-center justify-center text-[#315b4d]"><Icon className="size-6" aria-hidden="true" /></span>
              <span className="min-w-0"><span className="archive-serif block break-words text-lg font-semibold text-[#173d33]">{tag.name}</span><span className="mt-2 block text-xs text-[#68756f]">관련 판례 {(tag.articleCount ?? 0).toLocaleString("ko-KR")}건</span></span>
              <ChevronRight className="mt-auto size-4 text-[#7c8983] transition group-hover:translate-x-0.5 group-hover:text-[#123d32]" aria-hidden="true" />
            </Link>
          );
        })}
      </div>

      {pages.length > 1 ? (
        <div className="mt-3 flex justify-center gap-2" aria-label="헌법 주제 페이지">
          {pages.map((_, index) => (
            <button key={index} type="button" onClick={() => selectPage(index)} aria-label={`${index + 1}번째 헌법 주제 보기`} aria-current={page === index ? "page" : undefined} title={`${index + 1}번째 헌법 주제`} className={cn("focus-ring size-2 rounded-full transition", page === index ? "bg-[#123d32]" : "bg-[#bdc8c2] hover:bg-[#70847a]")} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
