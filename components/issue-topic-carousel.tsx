"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquareText, Scale, ShieldCheck, Vote } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import type { TagSummary } from "@/lib/db/types";
import { cn } from "@/lib/utils/classnames";

const AUTO_SCROLL_MS = 12_000;
const issueIcons = [MessageSquareText, Vote, ShieldCheck, Scale] as const;

export function IssueTopicCarousel({ tags }: { tags: TagSummary[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, tags.length - 1)));
  }, [tags.length]);

  const scrollToIndex = useCallback((nextIndex: number, behavior: ScrollBehavior = "smooth") => {
    if (tags.length === 0) return;
    const normalizedIndex = (nextIndex + tags.length) % tags.length;
    const viewport = viewportRef.current;
    const target = viewport?.children.item(normalizedIndex);
    if (viewport && target instanceof HTMLElement) {
      viewport.scrollTo({ left: target.offsetLeft, behavior });
    }
    setActiveIndex(normalizedIndex);
  }, [tags.length]);

  useEffect(() => {
    if (!autoScroll || isPaused || tags.length <= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const nextIndex = (activeIndex + 1) % tags.length;
    const timer = window.setTimeout(
      () => scrollToIndex(nextIndex, nextIndex === 0 ? "auto" : "smooth"),
      AUTO_SCROLL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeIndex, autoScroll, isPaused, scrollToIndex, tags.length]);

  if (tags.length === 0) return null;

  function selectTag(nextIndex: number) {
    setAutoScroll(false);
    const normalizedIndex = (nextIndex + tags.length) % tags.length;
    scrollToIndex(normalizedIndex, Math.abs(normalizedIndex - activeIndex) === 1 ? "smooth" : "auto");
  }

  function syncActiveIndex() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const cards = Array.from(viewport.children).filter((card): card is HTMLElement => card instanceof HTMLElement);
    if (cards.length === 0) return;
    const nearest = cards.reduce((best, card, index) => {
      const distance = Math.abs(card.offsetLeft - viewport.scrollLeft);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setActiveIndex(nearest.index);
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
        {tags.length > 1 ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs tabular-nums text-[#74817c]">{activeIndex + 1} / {tags.length}</span>
            <button type="button" onClick={() => selectTag(activeIndex - 1)} aria-label="이전 헌법 주제" title="이전 헌법 주제" className="focus-ring inline-flex size-8 items-center justify-center rounded-sm border border-[#c8d2cc] bg-white text-[#456056] hover:border-[#879a90] hover:text-[#123d32]"><ChevronLeft className="size-4" aria-hidden="true" /></button>
            <button type="button" onClick={() => selectTag(activeIndex + 1)} aria-label="다음 헌법 주제" title="다음 헌법 주제" className="focus-ring inline-flex size-8 items-center justify-center rounded-sm border border-[#c8d2cc] bg-white text-[#456056] hover:border-[#879a90] hover:text-[#123d32]"><ChevronRight className="size-4" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        onScroll={syncActiveIndex}
        className="relative -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {tags.map((tag, index) => {
          const Icon = issueIcons[index % issueIcons.length];
          return (
            <IntentPrefetchLink key={tag.slug} href={`/v2/list?tag=${encodeURIComponent(tag.slug)}`} className="focus-ring group grid min-h-28 min-w-[84%] snap-start grid-cols-[42px_minmax(0,1fr)_auto] gap-3 rounded-sm border border-[#d4dcd7] bg-white p-4 transition hover:border-[#829b8e] hover:bg-[#f8faf8] sm:min-w-[calc((100%-0.75rem)/2)] xl:min-w-[calc((100%-2.25rem)/4)]">
              <span className="inline-flex size-10 items-center justify-center text-[#315b4d]"><Icon className="size-6" aria-hidden="true" /></span>
              <span className="min-w-0"><span className="archive-serif block break-words text-lg font-semibold text-[#173d33]">{tag.name}</span><span className="mt-2 block text-xs text-[#68756f]">관련 판례 {(tag.articleCount ?? 0).toLocaleString("ko-KR")}건</span></span>
              <ChevronRight className="mt-auto size-4 text-[#7c8983] transition group-hover:translate-x-0.5 group-hover:text-[#123d32]" aria-hidden="true" />
            </IntentPrefetchLink>
          );
        })}
      </div>

      {tags.length > 1 ? (
        <div className="mt-3 flex justify-center gap-2" aria-label="헌법 주제 페이지">
          {tags.map((tag, index) => (
            <button key={tag.slug} type="button" onClick={() => selectTag(index)} aria-label={`${index + 1}번째 헌법 주제 보기`} aria-current={activeIndex === index ? "page" : undefined} title={`${index + 1}번째 헌법 주제`} className={cn("focus-ring size-2 rounded-full transition", activeIndex === index ? "bg-[#123d32]" : "bg-[#bdc8c2] hover:bg-[#70847a]")} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
