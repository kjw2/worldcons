"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/classnames";

const SHOW_DELAY_MS = 90;
const MIN_VISIBLE_MS = 260;
const MAX_VISIBLE_MS = 8000;

function isModifiedClick(event: MouseEvent) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function isSamePageHashNavigation(url: URL) {
  return url.pathname === window.location.pathname && url.search === window.location.search && url.hash !== window.location.hash;
}

function isInternalAnchorNavigation(anchor: HTMLAnchorElement, event: MouseEvent) {
  if (event.defaultPrevented || isModifiedClick(event)) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  if (url.href === window.location.href || isSamePageHashNavigation(url)) return false;

  return true;
}

function isInternalFormNavigation(form: HTMLFormElement, event: SubmitEvent) {
  if (event.defaultPrevented) return false;
  const target = form.getAttribute("target");
  if (target && target !== "_self") return false;

  const action = form.getAttribute("action") || window.location.href;
  const url = new URL(action, window.location.href);
  return url.origin === window.location.origin;
}

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleSinceRef = useRef(0);

  const setProgressVisible = useCallback((nextVisible: boolean) => {
    visibleRef.current = nextVisible;
    setVisible(nextVisible);
  }, []);

  const clearTimers = useCallback(() => {
    if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (maxVisibleTimerRef.current) clearTimeout(maxVisibleTimerRef.current);
    delayTimerRef.current = null;
    hideTimerRef.current = null;
    maxVisibleTimerRef.current = null;
  }, []);

  const forceFinish = useCallback(() => {
    clearTimers();
    if (visibleRef.current) setProgressVisible(false);
  }, [clearTimers, setProgressVisible]);

  const start = useCallback(() => {
    if (delayTimerRef.current || visibleRef.current) return;
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    delayTimerRef.current = setTimeout(() => {
      visibleSinceRef.current = Date.now();
      delayTimerRef.current = null;
      setProgressVisible(true);
      if (maxVisibleTimerRef.current) clearTimeout(maxVisibleTimerRef.current);
      maxVisibleTimerRef.current = setTimeout(() => {
        maxVisibleTimerRef.current = null;
        setProgressVisible(false);
      }, MAX_VISIBLE_MS);
    }, SHOW_DELAY_MS);
  }, [setProgressVisible]);

  const finish = useCallback(() => {
    if (delayTimerRef.current) {
      clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (!visibleRef.current) return;

    const elapsed = Date.now() - visibleSinceRef.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (maxVisibleTimerRef.current) {
        clearTimeout(maxVisibleTimerRef.current);
        maxVisibleTimerRef.current = null;
      }
      setProgressVisible(false);
      hideTimerRef.current = null;
    }, remaining);
  }, [setProgressVisible]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (anchor && isInternalAnchorNavigation(anchor, event)) start();
    };

    const handleSubmit = (event: SubmitEvent) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (form && isInternalFormNavigation(form, event)) start();
    };

    const handlePageShow = () => {
      forceFinish();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") finish();
    };

    window.addEventListener("popstate", forceFinish);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("submit", handleSubmit, true);

    return () => {
      window.removeEventListener("popstate", forceFinish);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("submit", handleSubmit, true);
      clearTimers();
    };
  }, [clearTimers, finish, forceFinish, start]);

  useEffect(() => {
    finish();
  }, [finish, pathname, searchKey]);

  return (
    <div
      data-navigation-progress
      role="status"
      aria-live="polite"
      aria-busy={visible}
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-[80] transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="h-0.5 overflow-hidden bg-primary/10">
        <div className="navigation-progress-bar h-full w-1/2 rounded-r-full bg-primary shadow-[0_0_18px_rgba(31,42,68,0.42)]" />
      </div>
      <div className="absolute right-4 top-[calc(var(--chrome-header-height)+0.75rem)] sm:right-6 lg:right-8">
        <div className="flex min-h-9 items-center gap-2 rounded-full border border-line bg-white/95 px-3 text-sm font-semibold text-ink shadow-floating backdrop-blur">
          <span className="relative size-4 rounded-full border border-primary/20" aria-hidden="true">
            <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary navigation-spinner" />
          </span>
          <span>이동 중</span>
        </div>
      </div>
    </div>
  );
}
