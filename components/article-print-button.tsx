"use client";

import { useRef, useState } from "react";
import { Printer } from "lucide-react";

export function ArticlePrintButton({ printHref }: { printHref: string }) {
  const [isLoading, setIsLoading] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadTimeoutRef = useRef<number | null>(null);

  function cleanupFrame(delayMs = 0) {
    window.setTimeout(() => {
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      frameRef.current?.remove();
      frameRef.current = null;
      setIsLoading(false);
    }, delayMs);
  }

  function handlePrint() {
    if (isLoading) return;

    setIsLoading(true);
    frameRef.current?.remove();

    const frame = document.createElement("iframe");
    frame.title = "인쇄용 HTML";
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.border = "0";
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    frameRef.current = frame;

    loadTimeoutRef.current = window.setTimeout(() => {
      cleanupFrame();
    }, 15000);

    frame.onload = () => {
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      const printWindow = frame.contentWindow;
      if (!printWindow) {
        cleanupFrame();
        return;
      }

      let didCleanup = false;
      const finish = () => {
        if (didCleanup) return;
        didCleanup = true;
        cleanupFrame(300);
      };

      printWindow.addEventListener("afterprint", finish, { once: true });
      window.setTimeout(finish, 10000);
      window.setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 100);
    };

    frame.onerror = () => cleanupFrame();
    frame.src = printHref;
    document.body.appendChild(frame);
  }

  return (
    <button
      type="button"
      onClick={handlePrint}
      disabled={isLoading}
      aria-busy={isLoading}
      className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink disabled:cursor-wait disabled:opacity-70"
    >
      <Printer className="size-4" aria-hidden="true" />
      인쇄
    </button>
  );
}
