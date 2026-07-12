export function retryCount() {
  return Math.max(0, Number(process.env.CRAWLER_RETRY_COUNT ?? 2));
}

export function retryDelayMs() {
  return Math.max(0, Number(process.env.CRAWLER_DELAY_MS ?? 2000));
}

export function delay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { retries?: number; delayMs?: number; signal?: AbortSignal; shouldRetry?: (error: unknown, attempt: number) => boolean } = {},
) {
  const retries = options.retries ?? retryCount();
  const waitMs = options.delayMs ?? retryDelayMs();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || options.shouldRetry?.(error, attempt) === false) break;
      if (waitMs > 0) await delay(waitMs, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
