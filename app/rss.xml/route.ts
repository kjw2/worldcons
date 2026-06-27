import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { displaySourceLabel } from "@/lib/ui/source-labels";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FEED_ITEM_LIMIT = 50;

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plainText(value?: string | null) {
  return (value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function feedDate(value?: string | null) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toUTCString() : new Date().toUTCString();
}

function articleUpdatedAt(article: {
  summarizedAt?: string | null;
  fetchedAt?: string | null;
  discoveredAt?: string | null;
  originalPublishedAt?: string | null;
}) {
  return article.summarizedAt || article.fetchedAt || article.discoveredAt || article.originalPublishedAt || null;
}

export async function GET() {
  const baseUrl = getAppBaseUrl();
  const feedUrl = `${baseUrl}/rss.xml`;
  const articles = await listArticles({ pageSize: FEED_ITEM_LIMIT, count: "none" });
  const latestUpdatedAt = articles.items.map(articleUpdatedAt).filter(Boolean).sort().at(-1) ?? null;

  const items = articles.items
    .map((article) => {
      const title = plainText(article.koreanTitle || article.originalTitle || "제목 미상");
      const link = `${baseUrl}/articles/${article.slug}`;
      const description = plainText(article.oneLineSummary || article.summaryJson?.summary?.coreSummary?.[0] || "");
      const sourceLabel = displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName });
      const categories = article.tags.map((tag) => tag.name).filter(Boolean);

      return [
        "    <item>",
        `      <title>${escapeXml(title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <description>${escapeXml(description)}</description>`,
        `      <pubDate>${escapeXml(feedDate(article.originalPublishedAt || articleUpdatedAt(article)))}</pubDate>`,
        `      <source url="${escapeXml(`${baseUrl}/sources/${article.sourceKey}`)}">${escapeXml(sourceLabel)}</source>`,
        ...categories.map((category) => `      <category>${escapeXml(category)}</category>`),
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>World Cons 최신 헌법판례 요약</title>",
    `    <link>${escapeXml(baseUrl)}</link>`,
    "    <description>세계 헌법재판기관의 최신 공개 자료를 한국어 요약으로 제공하는 World Cons RSS 피드입니다.</description>",
    "    <language>ko</language>",
    `    <lastBuildDate>${escapeXml(feedDate(latestUpdatedAt))}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
