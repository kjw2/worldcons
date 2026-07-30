"use client";

import { useEffect } from "react";
import { safeArticleReturnPath } from "@/lib/navigation/article-return";

const HISTORY_STATE_KEY = "worldconsArticleReturn";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 30 * 60 * 1_000;
const RESTORE_TIMEOUT_MS = 8_000;

interface ArticleHistorySnapshot {
  version: typeof SNAPSHOT_VERSION;
  returnPath: string;
  clickedSlug: string;
  scrollY: number;
  targetTop: number;
  savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentReturnPath() {
  return `${window.location.pathname}${window.location.search}`;
}

function articleSlugFromAnchor(anchor: HTMLAnchorElement) {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  try {
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    const match = url.pathname.match(/^\/(?:v2\/)?articles\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function shouldSaveNavigation(event: MouseEvent) {
  return !event.defaultPrevented
    && event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

function visibleElement(element: HTMLElement) {
  return element.isConnected && element.getClientRects().length > 0;
}

function articleTarget(slug: string) {
  const articleElements = [...document.querySelectorAll<HTMLElement>("[data-article-slug]")];
  const article = articleElements.find(
    (element) => element.dataset.articleSlug === slug && visibleElement(element),
  );
  if (article) return article;

  const anchors = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
  const anchor = anchors.find(
    (candidate) => articleSlugFromAnchor(candidate) === slug && visibleElement(candidate),
  );
  return anchor ?? null;
}

function saveHistorySnapshot(anchor: HTMLAnchorElement, slug: string) {
  const returnPath = safeArticleReturnPath(currentReturnPath());
  if (!returnPath) return;

  const target = anchor.closest<HTMLElement>("[data-article-slug]") ?? anchor;
  const snapshot: ArticleHistorySnapshot = {
    version: SNAPSHOT_VERSION,
    returnPath,
    clickedSlug: slug,
    scrollY: window.scrollY,
    targetTop: target.getBoundingClientRect().top,
    savedAt: Date.now(),
  };

  try {
    const currentState = isRecord(window.history.state) ? window.history.state : {};
    window.history.replaceState(
      { ...currentState, [HISTORY_STATE_KEY]: snapshot },
      "",
      window.location.href,
    );
  } catch {
    // Native browser restoration and the list-specific session snapshots remain available.
  }
}

function historySnapshot(state: unknown) {
  if (!isRecord(state) || !isRecord(state[HISTORY_STATE_KEY])) return null;

  const candidate = state[HISTORY_STATE_KEY];
  const returnPath = typeof candidate.returnPath === "string"
    ? safeArticleReturnPath(candidate.returnPath)
    : null;
  if (
    candidate.version !== SNAPSHOT_VERSION
    || !returnPath
    || typeof candidate.clickedSlug !== "string"
    || !candidate.clickedSlug
    || typeof candidate.scrollY !== "number"
    || !Number.isFinite(candidate.scrollY)
    || typeof candidate.targetTop !== "number"
    || !Number.isFinite(candidate.targetTop)
    || typeof candidate.savedAt !== "number"
    || Date.now() - candidate.savedAt > SNAPSHOT_TTL_MS
  ) {
    return null;
  }

  return {
    version: SNAPSHOT_VERSION,
    returnPath,
    clickedSlug: candidate.clickedSlug,
    scrollY: candidate.scrollY,
    targetTop: candidate.targetTop,
    savedAt: candidate.savedAt,
  } satisfies ArticleHistorySnapshot;
}

function restoreHistorySnapshot(snapshot: ArticleHistorySnapshot) {
  if (snapshot.returnPath !== currentReturnPath()) return () => undefined;

  let cancelled = false;
  let frameId: number | null = null;
  let observer: MutationObserver | null = null;
  let timeoutId: number | null = null;
  const settleTimerIds: number[] = [];
  let restoreStarted = false;

  const cleanup = () => {
    cancelled = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    observer?.disconnect();
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    settleTimerIds.forEach((timerId) => window.clearTimeout(timerId));
    window.removeEventListener("wheel", cleanup);
    window.removeEventListener("touchstart", cleanup);
    window.removeEventListener("pointerdown", cleanup);
    window.removeEventListener("keydown", cleanup);
  };

  const alignTarget = () => {
    if (cancelled || snapshot.returnPath !== currentReturnPath()) return false;

    const target = articleTarget(snapshot.clickedSlug);
    if (!target) return false;

    const targetY = target.getBoundingClientRect().top + window.scrollY - snapshot.targetTop;
    window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
    return true;
  };

  const restore = () => {
    if (!alignTarget()) return false;
    if (restoreStarted) return true;

    restoreStarted = true;
    observer?.disconnect();
    [80, 240, 700].forEach((delay, index, delays) => {
      const timerId = window.setTimeout(() => {
        alignTarget();
        if (index === delays.length - 1) cleanup();
      }, delay);
      settleTimerIds.push(timerId);
    });
    return true;
  };

  const start = () => {
    if (restore()) return;

    window.scrollTo({ top: Math.max(0, snapshot.scrollY), behavior: "auto" });
    observer = new MutationObserver(() => {
      if (restore()) observer?.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(cleanup, RESTORE_TIMEOUT_MS);
  };

  window.addEventListener("wheel", cleanup, { passive: true });
  window.addEventListener("touchstart", cleanup, { passive: true });
  window.addEventListener("pointerdown", cleanup, { passive: true });
  window.addEventListener("keydown", cleanup);
  frameId = window.requestAnimationFrame(() => {
    frameId = window.requestAnimationFrame(start);
  });

  return cleanup;
}

export function ArticleHistoryRestoration() {
  useEffect(() => {
    let stopRestoring: () => void = () => undefined;

    const handleClick = (event: MouseEvent) => {
      if (!shouldSaveNavigation(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      const slug = anchor ? articleSlugFromAnchor(anchor) : null;
      if (anchor && slug) saveHistorySnapshot(anchor, slug);
    };

    const restoreFromState = (state: unknown) => {
      const snapshot = historySnapshot(state);
      if (!snapshot) return;
      stopRestoring();
      stopRestoring = restoreHistorySnapshot(snapshot);
    };

    const handlePopState = (event: PopStateEvent) => {
      restoreFromState(event.state);
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) restoreFromState(window.history.state);
    };

    document.addEventListener("click", handleClick, true);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      stopRestoring();
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  return null;
}
