import { NextResponse } from "next/server";
import { z } from "zod";
import { ARTICLE_CONTENT_TYPES, type ArticleListFilters } from "@/lib/db/types";
import type { SiteEventInput } from "@/lib/analytics/events";
import { isPublicClientEventType } from "@/lib/analytics/events";

export type SearchMode = "fulltext" | "semantic" | "hybrid";

type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

const RANGE_VALUES = ["latest", "today", "week", "month"] as const;
const SEARCH_MODE_VALUES = ["fulltext", "semantic", "hybrid"] as const;
const TAG_SORT_VALUES = ["count", "latest", "name"] as const;
const TAG_TYPE_VALUES = ["court", "country", "law", "article", "right", "party", "institution", "topic", "doctrine", "procedure", "case_type"] as const;
const COUNT_MODE_VALUES = ["exact", "planned", "estimated", "none"] as const;

const controlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sourceKeyPattern = /^[a-z]{2}(?:-[a-z0-9]+)+$/;
const languagePattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;
const safeFilterPattern = /^[\p{L}\p{M}\p{N} _./:·°§#-]+$/u;
const analyticsMetadataKeyPattern = /^[A-Za-z0-9_.:-]{1,80}$/;

function optionalText(maxLength: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    },
    z.string().max(maxLength).refine((value) => !controlCharacterPattern.test(value), "control characters are not allowed").optional(),
  );
}

function optionalPatternText(maxLength: number, pattern: RegExp, label: string) {
  return optionalText(maxLength).refine((value) => value === undefined || pattern.test(value), `${label} contains unsupported characters`);
}

const articleListSchema = z.object({
  q: optionalText(200),
  range: z.enum(RANGE_VALUES).optional().default("latest"),
  source: optionalPatternText(80, sourceKeyPattern, "source"),
  jurisdiction: optionalPatternText(80, safeFilterPattern, "jurisdiction"),
  type: z.enum(ARTICLE_CONTENT_TYPES).optional(),
  tag: optionalPatternText(120, safeFilterPattern, "tag"),
  language: optionalPatternText(32, languagePattern, "language"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  count: z.enum(COUNT_MODE_VALUES).optional(),
});

const searchSchema = articleListSchema.extend({
  mode: z.enum(SEARCH_MODE_VALUES).optional().default("hybrid"),
  count: z.enum(COUNT_MODE_VALUES).optional().default("none"),
}).superRefine((value, ctx) => {
  if ((value.page - 1) * value.pageSize > 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["page"],
      message: "search offset must not exceed 10000",
    });
  }
});

const tagsSchema = z.object({
  type: optionalPatternText(40, safeFilterPattern, "type").pipe(z.enum(TAG_TYPE_VALUES).optional()),
  sort: z.enum(TAG_SORT_VALUES).optional().default("count"),
});

const slugSchema = z.string().trim().min(1).max(240).regex(slugPattern, "slug contains unsupported characters");
const sourceKeySchema = z.string().trim().min(1).max(80).regex(sourceKeyPattern, "sourceKey contains unsupported characters");

const analyticsMetadataValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const analyticsSchema = z.object({
  eventType: z.string().trim().max(80).refine(isPublicClientEventType, "unsupported analytics event"),
  path: optionalText(500).refine((value) => value === undefined || value.startsWith("/"), "path must be site-relative"),
  articleId: optionalPatternText(80, safeFilterPattern, "articleId"),
  articleSlug: optionalPatternText(240, slugPattern, "articleSlug"),
  articleTitle: optionalText(500),
  tagSlug: optionalPatternText(200, slugPattern, "tagSlug"),
  tagName: optionalPatternText(200, safeFilterPattern, "tagName"),
  sourceKey: optionalPatternText(80, sourceKeyPattern, "sourceKey"),
  jurisdiction: optionalPatternText(80, safeFilterPattern, "jurisdiction"),
  institutionName: optionalPatternText(300, safeFilterPattern, "institutionName"),
  resultCount: z.coerce.number().int().min(0).max(1_000_000).optional(),
  metadata: z
    .record(z.string().regex(analyticsMetadataKeyPattern), analyticsMetadataValueSchema)
    .refine((value) => Object.keys(value).length <= 20, "metadata has too many keys")
    .optional(),
});

function searchParamsObject(searchParams: URLSearchParams) {
  return Object.fromEntries(searchParams.entries());
}

function issueMessage(result: z.SafeParseError<unknown>) {
  return result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

export function publicApiValidationErrorResponse(error: string) {
  return NextResponse.json({ error: "Invalid request", detail: error }, { status: 400 });
}

export function parseArticleListApiParams(searchParams: URLSearchParams): ValidationResult<ArticleListFilters> {
  const result = articleListSchema.safeParse(searchParamsObject(searchParams));
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, data: result.data as ArticleListFilters };
}

export function parseSearchApiParams(searchParams: URLSearchParams): ValidationResult<{ filters: ArticleListFilters; mode: SearchMode }> {
  const result = searchSchema.safeParse(searchParamsObject(searchParams));
  if (!result.success) return { ok: false, error: issueMessage(result) };
  const { mode, ...filters } = result.data;
  return { ok: true, data: { filters: filters as ArticleListFilters, mode } };
}

export function parseTagsApiParams(searchParams: URLSearchParams): ValidationResult<{ type?: string; sort: "count" | "latest" | "name" }> {
  const result = tagsSchema.safeParse(searchParamsObject(searchParams));
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, data: result.data };
}

export function parseSlugParam(value: string): ValidationResult<string> {
  const result = slugSchema.safeParse(value);
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, data: result.data };
}

export function parseSourceKeyParam(value: string): ValidationResult<string> {
  const result = sourceKeySchema.safeParse(value);
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, data: result.data };
}

export function parseAnalyticsEventBody(body: unknown): ValidationResult<SiteEventInput> {
  const result = analyticsSchema.safeParse(body);
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return {
    ok: true,
    data: result.data as SiteEventInput,
  };
}

export function isProbablyOversizedJsonRequest(request: Request, maxBytes: number) {
  const length = Number(request.headers.get("content-length") ?? 0);
  return Number.isFinite(length) && length > maxBytes;
}

export function unsafePostgrestOrValue(value: string) {
  return /[(),"']/u.test(value);
}
