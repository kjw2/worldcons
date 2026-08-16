const DEFAULT_BASE_URL = "http://localhost:3000";
export const LEGACY_PUBLIC_PREFIX = "/v2";
export const MIN_INDEXABLE_TAG_ARTICLE_COUNT = 3;

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

export function getAppBaseUrl() {
  if (process.env.APP_BASE_URL) {
    return normalizeBaseUrl(process.env.APP_BASE_URL);
  }

  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) {
    return normalizeBaseUrl(vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`);
  }

  return DEFAULT_BASE_URL;
}

export function publicPath(path = "/") {
  const trimmed = path.trim() || "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash === LEGACY_PUBLIC_PREFIX || withSlash === `${LEGACY_PUBLIC_PREFIX}/`) return "/";
  if (withSlash.startsWith(`${LEGACY_PUBLIC_PREFIX}/`)) {
    const stripped = withSlash.slice(LEGACY_PUBLIC_PREFIX.length);
    return stripped || "/";
  }
  return withSlash === "/" ? "/" : withSlash.replace(/\/+$/, "") || "/";
}

export function publicAbsoluteUrl(path = "/") {
  const nextPath = publicPath(path);
  return nextPath === "/" ? `${getAppBaseUrl()}/` : `${getAppBaseUrl()}${nextPath}`;
}

export function isIndexablePublicTag(tag: { articleCount?: number | null }) {
  return (tag.articleCount ?? 0) >= MIN_INDEXABLE_TAG_ARTICLE_COUNT;
}
