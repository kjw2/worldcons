import { delay, retryDelayMs } from "@/lib/crawler/retry";

const lastRequestByOrigin = new Map<string, number>();

export async function respectRateLimit(url: string, delayMs = retryDelayMs(), signal?: AbortSignal) {
  if (delayMs <= 0) return;

  const origin = new URL(url).origin;
  const now = Date.now();
  const last = lastRequestByOrigin.get(origin) ?? 0;
  const waitMs = Math.max(0, last + delayMs - now);
  if (waitMs > 0) await delay(waitMs, signal);
  lastRequestByOrigin.set(origin, Date.now());
}
