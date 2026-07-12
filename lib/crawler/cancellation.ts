import type { CrawlerExecutionHooks } from "@/lib/crawler/types";

export function assertCrawlerExecution(hooks?: CrawlerExecutionHooks) {
  if (hooks?.signal?.aborted) throw hooks.signal.reason;
}

export async function checkpointCrawlerExecution(hooks?: CrawlerExecutionHooks) {
  assertCrawlerExecution(hooks);
  await hooks?.checkpoint?.();
  assertCrawlerExecution(hooks);
}
