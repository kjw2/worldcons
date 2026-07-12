import type { DiscoveredItem, RawArticle } from "@/lib/sources/types";
import type { CollectionMetadata, SourceDiscoveryOptions } from "@/lib/crawler/types";
import { addDiagnosticAttempt, diagnosticFromResponse } from "@/lib/crawler/diagnostics";
import { extractHtmlMetadata } from "@/lib/crawler/extract-metadata";
import { extractReadableText } from "@/lib/crawler/extract-readable-text";
import { crawlUrl } from "@/lib/crawler/http-client";
import { crawlWithPlaywright, isPlaywrightEnabled } from "@/lib/crawler/playwright-client";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import { extractHtmlText, extractPdfText } from "@/lib/ingest/extract-text";
import { MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";

function shouldUsePlaywright(options?: SourceDiscoveryOptions) {
  if (options?.usePlaywright === false) return false;
  if (options?.strategy && options.strategy !== "auto" && options.strategy !== "playwright") return false;
  return options?.usePlaywright === true || isPlaywrightEnabled();
}

export async function fetchHtmlDocument(url: string) {
  let response = await crawlUrl({ url });
  if ((!response.html || response.status === 403 || response.status === 0) && isPlaywrightEnabled()) {
    const playwright = await crawlWithPlaywright({ url, usePlaywright: true });
    if (playwright.html && playwright.status < 400) response = playwright;
  }

  if (!response.html) {
    throw new Error(`HTML fetch failed for ${url}: ${response.status} ${response.diagnostics?.errorMessage ?? "No HTML returned"}`);
  }

  return response.html;
}

function collectionForFetch(item: DiscoveredItem, strategy: CollectionMetadata["strategy"]): CollectionMetadata {
  const prior = item.metadata?.collection;
  if (prior?.strategy === "sitemap") {
    return { ...prior, strategy: "sitemap-detail", confidence: prior.confidence ?? "medium", sourceUrlVerified: strategy === "fetch" || strategy === "playwright" };
  }
  if (prior?.strategy === "seed") {
    return {
      ...prior,
      confidence: prior.confidence ?? "low",
      sourceUrlVerified: strategy === "fetch" || strategy === "playwright",
      publishable: false,
      sourceTextAvailable: false,
      reason: prior.reason ?? "Live discovery or source text fetch failed. Seed URL was stored for later retry.",
    };
  }
  if (prior?.strategy === "rss") {
    return { ...prior, confidence: prior.confidence ?? "high", sourceUrlVerified: strategy === "fetch" || strategy === "playwright" };
  }
  if (prior?.strategy === "playwright" && strategy === "fetch") {
    return prior;
  }

  if (strategy === "fetch" || strategy === "playwright") {
    return {
      strategy,
      confidence: "high",
      diagnosticsId: prior?.diagnosticsId,
      sourceUrlVerified: true,
      source: prior?.source,
      publishable: true,
      sourceTextAvailable: true,
    };
  }

  if (prior) return prior;
  return { strategy: "fetch", confidence: "high", sourceUrlVerified: true };
}

function robotsAttempt(url: string, robots: RobotsResult) {
  return {
    url,
    strategy: "robots" as const,
    status: robots.status,
    robotsUrl: robots.robotsUrl,
    robotsAllowed: robots.allowed,
    robotsMatchedRule: robots.matchedRule,
    robotsMatchedDirective: robots.matchedDirective,
    robotsCrawlDelaySeconds: robots.crawlDelaySeconds,
    robotsUserAgent: robots.userAgent,
    errorCode: robots.allowed ? undefined : "ROBOTS_DISALLOW",
    errorMessage: robots.allowed ? undefined : `Disallowed by robots.txt rule ${robots.matchedRule ?? "(empty)"}`,
  };
}

export async function fetchRawItem(item: DiscoveredItem, options?: SourceDiscoveryOptions): Promise<RawArticle> {
  await options?.checkpoint?.();
  if (options?.signal?.aborted) throw options.signal.reason;
  const robots = await checkRobotsAllowed(item.url, options).catch(() => {
    if (options?.signal?.aborted) throw options.signal.reason;
    return null;
  });
  await options?.checkpoint?.();
  if (robots) addDiagnosticAttempt(options?.diagnostics, robotsAttempt(item.url, robots));
  if (robots && !robots.allowed) {
    return {
      ...item,
      text: "",
      metadata: {
        ...item.metadata,
        collection: {
          ...(item.metadata?.collection ?? {}),
          strategy: item.metadata?.collection?.strategy ?? "official-listing",
          confidence: "medium",
          sourceUrlVerified: true,
          publishable: false,
          sourceTextAvailable: false,
          robotsDisallowed: true,
          reason: "robots.txt policy disallows automatic source text fetch. Official link is preserved for manual review.",
        },
        robots,
        warning: "robots.txt disallow matched; inserted for review only.",
      },
    };
  }

  let response = await crawlUrl({
    url: item.url,
    rateLimitDelayMs: robotsDelayMs(robots),
    signal: options?.signal,
    checkpoint: options?.checkpoint,
  });
  addDiagnosticAttempt(options?.diagnostics, diagnosticFromResponse(response));
  if ((response.status === 403 || response.status === 0 || !response.html) && shouldUsePlaywright(options)) {
    const playwright = await crawlWithPlaywright({
      url: item.url,
      usePlaywright: true,
      signal: options?.signal,
      checkpoint: options?.checkpoint,
    });
    addDiagnosticAttempt(options?.diagnostics, diagnosticFromResponse(playwright, { fallback: true }));
    if (playwright.html || playwright.buffer || (playwright.status > 0 && playwright.status < 400)) {
      response = playwright;
    }
  }

  if (response.status >= 400 || response.status === 0) {
    if (item.metadata?.collection?.strategy === "seed") {
      return {
        ...item,
        text: [item.title, item.publishedAt, item.url].filter(Boolean).join("\n"),
        metadata: {
          ...item.metadata,
          collection: {
            ...item.metadata.collection,
            confidence: "low",
            sourceUrlVerified: false,
            publishable: false,
            sourceTextAvailable: false,
            reason: item.metadata.collection.reason ?? "Live discovery or source text fetch failed. Seed URL was stored for later retry.",
          },
          diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-20),
          warning: item.metadata.warning ?? "Collected from configured official URL seed because live discovery failed.",
          error: response.diagnostics,
        },
      };
    }

    throw new Error(`Fetch failed for ${item.url}: ${response.status} ${response.diagnostics?.errorMessage ?? "unknown error"}`);
  }

  const contentType = response.contentType ?? "";
  const isPdf = contentType.includes("application/pdf") || item.url.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    const buffer = response.buffer;
    if (!buffer) {
      addDiagnosticAttempt(options?.diagnostics, {
        url: item.url,
        finalUrl: response.finalUrl,
        strategy: response.strategy,
        status: response.status,
        contentType,
        errorCode: "PDF_EMPTY_BUFFER",
        errorMessage: "PDF fetch returned no binary buffer.",
      });
      return {
        ...item,
        text: "",
        metadata: {
          ...item.metadata,
          collection: {
            ...collectionForFetch(item, response.strategy),
            publishable: false,
            sourceTextAvailable: false,
            reason: "Official PDF fetch was allowed, but no PDF buffer was returned.",
          },
          robots,
          diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-20),
          contentTypeHeader: contentType,
          extraction: "pdf-parse",
        },
      };
    }
    let text = "";
    try {
      await options?.checkpoint?.();
      text = await extractPdfText(buffer);
      await options?.checkpoint?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addDiagnosticAttempt(options?.diagnostics, {
        url: item.url,
        finalUrl: response.finalUrl,
        strategy: response.strategy,
        status: response.status,
        contentType,
        errorCode: "PDF_TEXT_EXTRACTION_FAILED",
        errorMessage: message,
      });
      return {
        ...item,
        pdfBuffer: buffer,
        text: "",
        metadata: {
          ...item.metadata,
          collection: {
            ...collectionForFetch(item, response.strategy),
            publishable: false,
            sourceTextAvailable: false,
            reason: "Official PDF fetch was allowed, but automatic text extraction failed.",
          },
          robots,
          diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-20),
          contentTypeHeader: contentType,
          extraction: "pdf-parse",
        },
      };
    }
    return {
      ...item,
      pdfBuffer: buffer,
      text,
      metadata: {
        ...item.metadata,
        collection: {
          ...collectionForFetch(item, response.strategy),
          publishable: text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH,
          sourceTextAvailable: text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH,
        },
        robots,
        diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-20),
        contentTypeHeader: contentType,
        extraction: "pdf-parse",
      },
    };
  }

  const html = response.html ?? response.text ?? "";
  const text = extractReadableText(html, response.finalUrl, item.metadata?.bodySelectors) || extractHtmlText(html, response.finalUrl);
  const metadata = extractHtmlMetadata(html);
  const collection = collectionForFetch(item, response.strategy);
  const sourceTextAvailable = text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH;
  return {
    ...item,
    url: response.finalUrl || item.url,
    title: metadata.title ?? item.title,
    publishedAt: metadata.publishedAt ?? item.publishedAt,
    html,
    text,
    metadata: {
      ...item.metadata,
      collection: {
        ...collection,
        publishable: sourceTextAvailable && collection.strategy !== "seed",
        sourceTextAvailable,
        reason: sourceTextAvailable ? collection.reason : collection.reason ?? "Official metadata was collected, but source text is not available.",
      },
      robots,
      crawledMetadata: {
        description: metadata.description,
        decisionNumber: metadata.decisionNumber,
        caseNumber: metadata.caseNumber,
        senateOrChamber: metadata.senateOrChamber,
      },
      diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-20),
      contentTypeHeader: contentType,
      extraction: "readability-cheerio",
    },
  };
}
