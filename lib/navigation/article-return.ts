import { publicPath } from "@/lib/seo/public-urls";

const ARTICLE_RETURN_PATH_MAX_LENGTH = 2_048;
const RETURN_ORIGIN = "https://worldcons.local";

const STATIC_RETURN_PATHS = new Set([
  "/",
  "/list",
  "/search",
]);

function isAllowedReturnPath(pathname: string) {
  if (STATIC_RETURN_PATHS.has(pathname)) return true;
  return /^\/(?:sources|tags)\/[a-z0-9][a-z0-9-]*$/i.test(pathname);
}

export function safeArticleReturnPath(value?: string | null) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > ARTICLE_RETURN_PATH_MAX_LENGTH) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;

  try {
    const url = new URL(candidate, RETURN_ORIGIN);
    if (url.origin !== RETURN_ORIGIN) return null;
    const pathname = publicPath(url.pathname);
    if (!isAllowedReturnPath(pathname)) return null;
    return `${pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function articleReturnPathForLocation(pathname: string, searchParams: { toString(): string }) {
  const query = searchParams.toString();
  return safeArticleReturnPath(query ? `${pathname}?${query}` : pathname);
}

export function articleHrefWithReturnTo(slug: string, returnTo?: string | null) {
  const href = `/articles/${encodeURIComponent(slug)}`;
  const safeReturnTo = safeArticleReturnPath(returnTo);
  if (!safeReturnTo) return href;

  return `${href}#${new URLSearchParams({ returnTo: safeReturnTo }).toString()}`;
}
