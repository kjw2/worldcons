export function retryCount() {
  return Math.max(0, Number(process.env.CRAWLER_RETRY_COUNT ?? 2));
}

export function retryDelayMs() {
  return Math.max(0, Number(process.env.CRAWLER_DELAY_MS ?? 2000));
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { retries?: number; delayMs?: number; shouldRetry?: (error: unknown, attempt: number) => boolean } = {},
) {
  const retries = options.retries ?? retryCount();
  const waitMs = options.delayMs ?? retryDelayMs();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || options.shouldRetry?.(error, attempt) === false) break;
      if (waitMs > 0) await delay(waitMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
