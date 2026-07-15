"use client";

import { useEffect } from "react";

const LIST_PENDING_KEY = "worldcons:list-scroll:pending-paginated";
const LIST_SNAPSHOT_TTL_MS = 30 * 60 * 1_000;

interface ListReturnSnapshot {
  key: string;
  clickedSlug: string;
  scrollY: number;
  targetTop: number;
  savedAt: number;
}

function currentListKey() {
  return `${window.location.pathname}${window.location.search}`;
}

function findArticleElement(slug: string) {
  return [...document.querySelectorAll<HTMLElement>("[data-article-slug]")]
    .find((element) => element.dataset.articleSlug === slug) ?? null;
}

function shouldSaveNavigation(event: MouseEvent) {
  return !event.defaultPrevented
    && event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

function saveSnapshot(slug: string) {
  const target = findArticleElement(slug);
  const snapshot: ListReturnSnapshot = {
    key: currentListKey(),
    clickedSlug: slug,
    scrollY: window.scrollY,
    targetTop: target?.getBoundingClientRect().top ?? 120,
    savedAt: Date.now(),
  };

  try {
    window.sessionStorage.setItem(LIST_PENDING_KEY, JSON.stringify(snapshot));
  } catch {
    // Browser history restoration remains available when session storage is unavailable.
  }
}

function readSnapshot() {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(LIST_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const snapshot = JSON.parse(raw) as Partial<ListReturnSnapshot>;
    if (
      snapshot.key !== currentListKey()
      || typeof snapshot.clickedSlug !== "string"
      || typeof snapshot.scrollY !== "number"
      || typeof snapshot.targetTop !== "number"
      || typeof snapshot.savedAt !== "number"
      || Date.now() - snapshot.savedAt > LIST_SNAPSHOT_TTL_MS
    ) {
      return null;
    }
    return snapshot as ListReturnSnapshot;
  } catch {
    return null;
  }
}

function restoreSnapshot(snapshot: ListReturnSnapshot) {
  const target = findArticleElement(snapshot.clickedSlug);
  if (target) {
    const targetY = target.getBoundingClientRect().top + window.scrollY - snapshot.targetTop;
    window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
    return;
  }
  window.scrollTo({ top: Math.max(0, snapshot.scrollY), behavior: "auto" });
}

export function ArticleListReturnState() {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!shouldSaveNavigation(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[data-list-article-slug]");
      const slug = link?.dataset.listArticleSlug;
      if (slug) saveSnapshot(slug);
    };

    document.addEventListener("click", handleClick, true);
    const snapshot = readSnapshot();
    if (snapshot) {
      try {
        window.sessionStorage.removeItem(LIST_PENDING_KEY);
      } catch {
        // The snapshot is harmless if storage becomes unavailable between reads.
      }
      requestAnimationFrame(() => requestAnimationFrame(() => restoreSnapshot(snapshot)));
    }

    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return null;
}
