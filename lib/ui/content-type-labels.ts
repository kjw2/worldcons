import type { ArticleContentType, ArticleListItem } from "@/lib/db/types";

const CONTENT_TYPE_LABELS: Record<ArticleContentType, string> = {
  news: "뉴스",
  press_release: "보도자료",
  decision: "결정",
  opinion: "의견",
  order: "명령",
  other: "기타",
};

const SPAIN_RESOLUTION_TYPE_LABELS: Record<string, string> = {
  SENTENCIA: "판결",
  AUTO: "결정",
  DECLARACION: "선언",
};

function normalizeResolutionType(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .trim()
        .toUpperCase()
    : null;
}

export function displayContentTypeLabel(contentType?: string | null) {
  return contentType && contentType in CONTENT_TYPE_LABELS
    ? CONTENT_TYPE_LABELS[contentType as ArticleContentType]
    : contentType || "기타";
}

export function displayArticleTypeLabel(article: Pick<ArticleListItem, "contentType" | "sourceKey" | "sourceMetadata">) {
  if (article.sourceKey === "es-tribunal-constitucional") {
    const resolutionType = normalizeResolutionType(article.sourceMetadata?.resolutionType);
    if (resolutionType && resolutionType in SPAIN_RESOLUTION_TYPE_LABELS) {
      return SPAIN_RESOLUTION_TYPE_LABELS[resolutionType];
    }
  }

  return displayContentTypeLabel(article.contentType);
}
