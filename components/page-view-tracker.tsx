"use client";

import { useEffect, useRef } from "react";
import type { SiteEventInput } from "@/lib/analytics/events";
import { sendAnalyticsEvent } from "@/components/analytics-event-client";

export function PageViewTracker({ event }: { event: SiteEventInput }) {
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    sendAnalyticsEvent(event);
  }, [event]);

  return null;
}
