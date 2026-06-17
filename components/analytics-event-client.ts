"use client";

import type { SiteEventInput } from "@/lib/analytics/events";

export function sendAnalyticsEvent(event: SiteEventInput) {
  const payload = JSON.stringify({
    ...event,
    path: event.path ?? window.location.pathname,
  });

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
