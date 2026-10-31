export const SITEMAP_SOURCE_ATTEMPTS = 2;
export const SITEMAP_SOURCE_RETRY_DELAY_MS = 150;

export interface SitemapSourceUnavailableLog {
  event: "sitemap_source_unavailable";
  source: string;
  attempts: number;
}

/** Safe, bounded diagnostic: never records SQL, article content, or raw exception text. */
export interface SitemapReadAttemptLog {
  event: "sitemap_source_attempt_failed";
  source: string;
  attempt: number;
  reason: string;
}

export interface ResilientSitemapReadOptions {
  attempts?: number;
  delayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  log?: (entry: SitemapSourceUnavailableLog) => void;
  logAttempt?: (entry: SitemapReadAttemptLog) => void;
}

export class SitemapSourceUnavailableError extends Error {
  readonly code = "sitemap_source_unavailable";
  readonly source: string;

  constructor(source: string) {
    super(`Required sitemap source is unavailable: ${source}`);
    this.name = "SitemapSourceUnavailableError";
    this.source = source;
  }
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function logUnavailable(entry: SitemapSourceUnavailableLog) {
  console.error(JSON.stringify(entry));
}

function classifyReadFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  // Some internal guards use their code as the Error.message. Permit only a
  // strict identifier; never emit arbitrary error strings that can contain
  // data, queries or credentials.
  const safe = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
  if (safe.test(error.message)) return error.message;
  const candidate = error as Error & { code?: unknown };
  if (typeof candidate.code === "string" && safe.test(candidate.code)) return candidate.code;
  return safe.test(error.name) ? error.name : "unknown_error";
}

function logAttemptFailure(entry: SitemapReadAttemptLog) {
  console.error(JSON.stringify(entry));
}

export async function resilientSitemapRead<T>(
  source: string,
  read: () => Promise<T[]>,
  options: ResilientSitemapReadOptions = {},
): Promise<T[]> {
  const attempts = Math.max(1, options.attempts ?? SITEMAP_SOURCE_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? SITEMAP_SOURCE_RETRY_DELAY_MS);
  const wait = options.wait ?? waitForRetry;
  const log = options.log ?? logUnavailable;
  const logAttempt = options.logAttempt ?? logAttemptFailure;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      logAttempt({ event: "sitemap_source_attempt_failed", source, attempt, reason: classifyReadFailure(error) });
      if (attempt < attempts) {
        if (delayMs > 0) await wait(delayMs);
        continue;
      }
    }
  }

  log({ event: "sitemap_source_unavailable", source, attempts });
  throw new SitemapSourceUnavailableError(source);
}
