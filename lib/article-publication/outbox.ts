import { postgresArticleCacheOutboxRepository } from "@/lib/article-publication/repository";
import type { ArticleCacheOutboxEvent, ArticleCacheOutboxRepository } from "@/lib/article-publication/types";
import { articlePublicationV4OutboxProcessorEnabled } from "@/lib/article-publication/compatibility";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";
import { boundedInteger } from "@/lib/utils/numbers";

function errorCode(error: unknown) {
  const candidate = error instanceof Error ? error.message : "";
  return candidate === "handler.configuration_missing" || candidate === "handler.revalidation_failed"
    ? candidate
    : "handler.failed";
}

export interface ArticleCacheOutboxHandler {
  invalidate(events: readonly ArticleCacheOutboxEvent[]): Promise<void>;
}

export async function processArticleCacheOutboxBatch(options: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  environment?: Record<string, string | undefined>;
  repository?: ArticleCacheOutboxRepository;
  handler: ArticleCacheOutboxHandler;
}) {
  if (!articlePublicationV4OutboxProcessorEnabled(options.environment ?? process.env)) {
    return { enabled: false as const, claimedCount: 0, deliveredCount: 0, failedCount: 0, deadLetterCount: 0 };
  }
  const repository = options.repository ?? postgresArticleCacheOutboxRepository;
  const limit = boundedInteger(options.limit, 20, { min: 1, max: 100 });
  const leaseSeconds = boundedInteger(options.leaseSeconds, 120, { min: 15, max: 900 });
  const events = await repository.claim(options.workerId, limit, leaseSeconds);
  recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "read", authority: "new", outcome: "succeeded" });
  if (events.length === 0) {
    return { enabled: true as const, claimedCount: 0, deliveredCount: 0, failedCount: 0, deadLetterCount: 0 };
  }

  try {
    await options.handler.invalidate(events);
    let deliveredCount = 0;
    for (const event of events) {
      await repository.deliver(event, options.workerId);
      recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "succeeded" });
      deliveredCount += 1;
    }
    return { enabled: true as const, claimedCount: events.length, deliveredCount, failedCount: 0, deadLetterCount: 0 };
  } catch (error) {
    let failedCount = 0;
    let deadLetterCount = 0;
    for (const event of events) {
      try {
        const status = await repository.fail(event, options.workerId, errorCode(error));
        recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction: "write", authority: "new", outcome: "failed" });
        failedCount += 1;
        if (status === "dead_letter") deadLetterCount += 1;
      } catch {
        // A stale lease is owned by another worker; its state is authoritative.
      }
    }
    return { enabled: true as const, claimedCount: events.length, deliveredCount: 0, failedCount, deadLetterCount };
  }
}

export function createExistingPublicCacheHandler(environment: Record<string, string | undefined> = process.env): ArticleCacheOutboxHandler {
  return {
    async invalidate() {
      const baseUrl = environment.APP_BASE_URL?.trim();
      const secret = environment.CRON_SECRET?.trim();
      if (!baseUrl || !secret) throw new Error("handler.configuration_missing");
      const response = await fetch(new URL("/api/admin/public-content/revalidate", baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("handler.revalidation_failed");
    },
  };
}
