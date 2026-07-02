"use client";

import { useState, type SyntheticEvent } from "react";

type SnapshotState =
  | { status: "idle"; text: null; error: null }
  | { status: "loading"; text: null; error: null }
  | { status: "loaded"; text: string; error: null }
  | { status: "error"; text: null; error: string };

function textLength(value?: string | null) {
  return new Intl.NumberFormat("ko-KR").format((value ?? "").trim().length);
}

export function ArticleSourceSnapshot({ slug }: { slug: string }) {
  const [state, setState] = useState<SnapshotState>({ status: "idle", text: null, error: null });

  async function loadSnapshot() {
    if (state.status === "loading" || state.status === "loaded") return;

    setState({ status: "loading", text: null, error: null });
    try {
      const response = await fetch(`/api/articles/${slug}/source-text`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = (await response.json()) as { cleanedText?: string | null };
      const text = payload.cleanedText?.trim();
      if (!text) throw new Error("보존된 원문 스냅샷이 없습니다.");
      setState({ status: "loaded", text, error: null });
    } catch (error) {
      setState({ status: "error", text: null, error: error instanceof Error ? error.message : "원문 스냅샷을 불러오지 못했습니다." });
    }
  }

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) void loadSnapshot();
  }

  return (
    <details onToggle={handleToggle} className="rounded-lg border border-line bg-surface-muted/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        보존된 원문 스냅샷
        {state.status === "loaded" ? <span className="ml-1 font-medium text-ink-subtle">({textLength(state.text)}자)</span> : null}
      </summary>
      <div className="mt-4">
        {state.status === "idle" ? <p className="text-sm leading-6 text-ink-muted">열면 보존된 원문 스냅샷을 불러옵니다.</p> : null}
        {state.status === "loading" ? <div className="h-32 animate-pulse rounded-lg bg-white" aria-label="원문 스냅샷을 불러오는 중" /> : null}
        {state.status === "error" ? <p className="rounded-lg bg-white p-4 text-sm leading-6 text-court">{state.error}</p> : null}
        {state.status === "loaded" ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-4 text-[13px] leading-7 text-ink-muted">{state.text}</pre>
        ) : null}
      </div>
    </details>
  );
}
