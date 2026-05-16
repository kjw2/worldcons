"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { SiteEventInput } from "@/lib/analytics/events";

interface TrackedLinkProps {
  href: string;
  event: SiteEventInput;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  target?: string;
  rel?: string;
  title?: string;
}

function sendAnalyticsEvent(event: SiteEventInput) {
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

export function TrackedLink({ href, event, className, style, children, target, rel, title }: TrackedLinkProps) {
  function handleClick() {
    sendAnalyticsEvent(event);
  }

  return (
    <Link href={href} onClick={handleClick} className={className} style={style} target={target} rel={rel} title={title}>
      {children}
    </Link>
  );
}
