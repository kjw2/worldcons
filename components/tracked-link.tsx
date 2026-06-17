"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { SiteEventInput } from "@/lib/analytics/events";
import { sendAnalyticsEvent } from "@/components/analytics-event-client";

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
