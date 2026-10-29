export const SITEMAP_SOURCE_ATTEMPTS = 2;
export const SITEMAP_SOURCE_RETRY_DELAY_MS = 150;

export interface SitemapSourceUnavailableLog {
  event: "sitemap_source_unavailable";
  source: string;
  attempts: number;
}

export interface ResilientSitemapReadOptions {
  attempts?: number;
  delayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  log?: (entry: SitemapSourceUnavailableLog) => void;
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

export async function resilientSitemapRead<T>(
  source: string,
  read: () => Promise<T[]>,
  options: ResilientSitemapReadOptions = {},
): Promise<T[]> {
  const attempts = Math.max(1, options.attempts ?? SITEMAP_SOURCE_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? SITEMAP_SOURCE_RETRY_DELAY_MS);
  const wait = options.wait ?? waitForRetry;
  const log = options.log ?? logUnavailable;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch {
      if (attempt < attempts) {
        if (delayMs > 0) await wait(delayMs);
        continue;
      }
    }
  }

  log({ event: "sitemap_source_unavailable", source, attempts });
  throw new SitemapSourceUnavailableError(source);
}
