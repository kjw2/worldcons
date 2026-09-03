"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "error";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers expose the API but deny it; use the selection fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
  if (!copied) throw new Error("Clipboard copy failed");
}

export function CopyToClipboardButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function handleCopy() {
    try {
      await copyText(value);
      setState("copied");
    } catch {
      setState("error");
    }

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 5000);
  }

  const label = state === "copied" ? "복사됨" : state === "error" ? "복사 실패" : "주소 복사";

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="focus-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-2 border border-archive-accent bg-archive-accent px-4 text-sm font-bold text-white transition-colors hover:border-archive-accent-hover hover:bg-archive-accent-hover"
      aria-label={`플러그인 연결 주소 ${label}`}
      title={label}
    >
      {state === "copied" ? (
        <Check className="size-4" aria-hidden="true" />
      ) : state === "error" ? (
        <TriangleAlert className="size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
      <span aria-live="polite">{label}</span>
    </button>
  );
}
