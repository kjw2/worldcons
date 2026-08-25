"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

const SHOW_AFTER_PX = 640;

export function BackToTopButton() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let frameId = 0;

    function updateVisibility() {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        setIsVisible(window.scrollY > SHOW_AFTER_PX);
      });
    }

    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", updateVisibility);
    };
  }, []);

  function scrollToTop() {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }

  return (
    <button
      type="button"
      aria-label="맨 위로 가기"
      title="맨 위로 가기"
      onClick={scrollToTop}
      className={[
        "back-to-top-button focus-ring fixed z-50 inline-flex size-11 items-center justify-center rounded-sm border border-archive-line-strong bg-white text-archive-text transition-colors duration-200 hover:bg-archive-surface-soft hover:text-archive-accent",
        isVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      ].join(" ")}
    >
      <ArrowUp className="size-5" aria-hidden="true" />
    </button>
  );
}
