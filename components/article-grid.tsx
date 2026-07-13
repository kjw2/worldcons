"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ArticleListItem } from "@/lib/db/types";
import { ArticleCard } from "@/components/article-card";
import { EmptyState } from "@/components/ui/empty-state";

const BASIC_PENDING_KEY = "worldcons:list-scroll:pending-basic";
const BASIC_TTL_MS = 30 * 60 * 1000;

interface BasicListSnapshot {
  key: string;
  clickedSlug: string;
  scrollY: number;
  targetTop: number;
  savedAt: number;
}

function currentListKey() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}`;
}

function findArticleElement(slug: string) {
  if (typeof document === "undefined") return null;
  return [...document.querySelectorAll<HTMLElement>("[data-article-slug]")].find((element) => element.dataset.articleSlug === slug) ?? null;
}

function restoreSnapshot(snapshot: BasicListSnapshot) {
  const target = findArticleElement(snapshot.clickedSlug);
  if (target) {
    const targetY = target.getBoundingClientRect().top + window.scrollY - snapshot.targetTop;
    window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
    return;
  }

  window.scrollTo({ top: Math.max(0, snapshot.scrollY), behavior: "auto" });
}

function readBasicSnapshot() {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(BASIC_PENDING_KEY);
  if (!raw) return null;

  try {
    const snapshot = JSON.parse(raw) as Partial<BasicListSnapshot>;
    if (
      snapshot.key !== currentListKey() ||
      typeof snapshot.clickedSlug !== "string" ||
      typeof snapshot.scrollY !== "number" ||
      typeof snapshot.targetTop !== "number" ||
      typeof snapshot.savedAt !== "number" ||
      Date.now() - snapshot.savedAt > BASIC_TTL_MS
    ) {
      return null;
    }

    return snapshot as BasicListSnapshot;
  } catch {
    return null;
  }
}

function saveBasicSnapshot(slug: string) {
  if (typeof window === "undefined") return;
  const target = findArticleElement(slug);
  const snapshot: BasicListSnapshot = {
    key: currentListKey(),
    clickedSlug: slug,
    scrollY: window.scrollY,
    targetTop: target?.getBoundingClientRect().top ?? 120,
    savedAt: Date.now(),
  };

  try {
    window.sessionStorage.setItem(BASIC_PENDING_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore private-mode or quota failures; browser default restoration remains available.
  }
}

export function ArticleGrid({
  articles,
  onArticleNavigate,
  restoreScroll = true,
}: {
  articles: ArticleListItem[];
  onArticleNavigate?: (slug: string) => void;
  restoreScroll?: boolean;
}) {
  const restoredRef = useRef(false);
  const handleArticleNavigate = useCallback(
    (slug: string) => {
      if (onArticleNavigate) {
        onArticleNavigate(slug);
        return;
      }

      saveBasicSnapshot(slug);
    },
    [onArticleNavigate],
  );

  useEffect(() => {
    if (!restoreScroll || onArticleNavigate || restoredRef.current) return;
    const snapshot = readBasicSnapshot();
    if (!snapshot) return;

    restoredRef.current = true;
    window.sessionStorage.removeItem(BASIC_PENDING_KEY);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => restoreSnapshot(snapshot));
    });
  }, [articles.length, onArticleNavigate, restoreScroll]);

  if (articles.length === 0) {
    return (
      <EmptyState
        title="조건에 맞는 자료가 없습니다"
        description="검색어를 줄이거나 필터 조건을 바꾸면 더 많은 공식 자료를 확인할 수 있습니다."
      />
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {articles.map((article) => (
        <ArticleCard key={article.slug} article={article} onArticleNavigate={handleArticleNavigate} />
      ))}
    </div>
  );
}
