import type { Metadata } from "next";
import type { SourceRecord } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/public-urls";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";

export const SOURCE_ARCHIVE_PAGE_SIZE = 30;

export function parseSourceArchivePage(value?: string | string[]): number | null {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= 10_000 ? page : null;
}

export function sourceArchivePageHref(sourceKey: string, page: number) {
  const path = `/sources/${encodeURIComponent(sourceKey)}`;
  return page <= 1 ? path : `${path}?page=${page}`;
}

export function isOutOfRangeSourceArchivePage(page: number, itemCount: number) {
  return page > 1 && itemCount === 0;
}

export function sourceArchiveMetadata(source: SourceRecord, page: number | null): Metadata {
  const canonical = `${getAppBaseUrl()}/sources/${source.sourceKey}`;
  if (page === null) {
    return {
      alternates: { canonical },
      robots: { index: false, follow: true },
    };
  }

  if (page <= 1) {
    return {
      title: displaySourceLabel(source),
      description: `${displayJurisdictionLabel(source.jurisdiction)} 공식 헌법재판 자료 수집 기관`,
      alternates: { canonical },
    };
  }

  return {
    title: `${displaySourceLabel(source)} 판례 목록 ${page}페이지`,
    description: `${displayJurisdictionLabel(source.jurisdiction)} ${displaySourceLabel(source)}의 공식 공개 판례를 최신순으로 정리한 ${page}페이지입니다.`,
    alternates: { canonical: `${canonical}?page=${page}` },
  };
}
