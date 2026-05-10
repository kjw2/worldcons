"use client";

import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";

const STORAGE_KEY = "worldcons:fixed-chrome";
const HEADER_HIDE_AFTER_PX = 96;
const SCROLL_DELTA_PX = 6;

function readStoredPreference() {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(STORAGE_KEY) !== "false";
}

function setChromeFixed(enabled: boolean) {
  document.documentElement.classList.toggle("chrome-fixed", enabled);
  if (!enabled) {
    setHeaderHidden(false);
  }
}

function setHeaderHidden(hidden: boolean) {
  document.documentElement.classList.toggle("chrome-header-hidden", hidden);
}

function updateChromeHeights() {
  const header = document.getElementById("site-header");
  document.documentElement.style.setProperty("--chrome-header-height", `${header?.offsetHeight ?? 0}px`);
}

export function FixedChromeToggle() {
  const [enabled, setEnabled] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const nextEnabled = readStoredPreference();
    setEnabled(nextEnabled);
    setMounted(true);
    setChromeFixed(nextEnabled);
    updateChromeHeights();

    const header = document.getElementById("site-header");
    const observer = new ResizeObserver(updateChromeHeights);
    if (header) observer.observe(header);

    let lastScrollY = window.scrollY;
    let frameId = 0;

    function updateHeaderVisibility() {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const currentScrollY = window.scrollY;
        const deltaY = currentScrollY - lastScrollY;
        const fixed = document.documentElement.classList.contains("chrome-fixed");

        if (!fixed || currentScrollY <= HEADER_HIDE_AFTER_PX) {
          setHeaderHidden(false);
        } else if (deltaY > SCROLL_DELTA_PX) {
          setHeaderHidden(true);
        } else if (deltaY < -SCROLL_DELTA_PX) {
          setHeaderHidden(false);
        }

        lastScrollY = currentScrollY;
      });
    }

    window.addEventListener("resize", updateChromeHeights);
    window.addEventListener("scroll", updateHeaderVisibility, { passive: true });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("resize", updateChromeHeights);
      window.removeEventListener("scroll", updateHeaderVisibility);
    };
  }, []);

  function toggleFixedChrome() {
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    window.localStorage.setItem(STORAGE_KEY, String(nextEnabled));
    setChromeFixed(nextEnabled);
    updateChromeHeights();
  }

  const Icon = enabled ? Pin : PinOff;

  return (
    <button
      type="button"
      aria-label={enabled ? "헤더 고정 끄기" : "헤더 고정 켜기"}
      aria-pressed={enabled}
      title={enabled ? "헤더 고정 끄기" : "헤더 고정 켜기"}
      onClick={toggleFixedChrome}
      className={[
        "chrome-toggle-button focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink shadow-soft transition hover:bg-parchment hover:text-court",
        mounted ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      <Icon className="size-4" aria-hidden="true" />
      {enabled ? "헤더 고정" : "헤더 해제"}
    </button>
  );
}
