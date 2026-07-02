"use client";

import type { SiteEventInput } from "@/lib/analytics/events";

export const ARTICLE_VIEWED_STORAGE_PREFIX = "worldcons:article-viewed:";

function rememberArticleView(event: SiteEventInput) {
  if (event.eventType !== "article_view" || !event.articleSlug) return;

  try {
    window.sessionStorage.setItem(`${ARTICLE_VIEWED_STORAGE_PREFIX}${event.articleSlug}`, String(Date.now()));
  } catch {
    // Ignore private-mode or quota failures; analytics still uses the network path.
  }
}

export function sendAnalyticsEvent(event: SiteEventInput) {
  const payload = JSON.stringify({
    ...event,
    path: event.path ?? window.location.pathname,
  });

  rememberArticleView(event);

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon("/api/analytics/event", blob)) return;
  }

  void fetch("/api/analytics/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => null);
}
