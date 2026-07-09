import { z } from "zod";
import { LLM_PROVIDER_IDS, type AdminLlmSettingsInput } from "@/lib/ai/llm-settings-types";
import type { AdminArticleBulkRef } from "@/lib/db/admin-queries";
import type { SourceUrlCandidateStatus } from "@/lib/db/source-url-candidates";

type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ADMIN_REF_MAX_LENGTH = 240;
const ADMIN_NOTE_MAX_LENGTH = 1000;
const ADMIN_MODEL_MAX_LENGTH = 120;
const ADMIN_LLM_MODEL_MAX_LENGTH = 160;
const ADMIN_LLM_BASE_URL_MAX_LENGTH = 500;
const ADMIN_LLM_KEY_VALUE_MAX_LENGTH = 20_000;
const ADMIN_BULK_MAX_ITEMS = 100;
const ADMIN_CANDIDATE_ID_MAX_LENGTH = 120;
const ADMIN_RETURN_TO_MAX_LENGTH = 300;
const ADMIN_QUERY_TEXT_MAX_LENGTH = 300;
const ADMIN_JOB_REASON_MAX_LENGTH = 500;

const INGEST_ACTIONS = ["ingest", "ingest-and-summarize", "summarize", "retry-summary", "refresh-tags"] as const;
const REVIEW_ACTIONS = [
  "approve-and-summarize",
  "retry-summary",
  "resummarize-with-model",
  "publish-reviewed",
  "close-private",
  "retry-source-ingest",
] as const;
const BULK_ACTIONS = ["mark-needs-review", "close-private"] as const;
const CANDIDATE_ACTIONS = ["ignore", "retrying"] as const;
const CANDIDATE_STATUSES = ["pending", "retrying", "fetched", "failed", "ignored"] as const;
const JOB_ACTIONS = ["cancel", "retry"] as const;

const ACTION_TO_STATUS = {
  ignore: "ignored",
  retrying: "retrying",
} as const satisfies Record<(typeof CANDIDATE_ACTIONS)[number], SourceUrlCandidateStatus>;

const controlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function issueMessage(result: z.SafeParseError<unknown>) {
  return result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

function validationResult<T>(result: z.SafeParseReturnType<unknown, T>): ValidationResult<T> {
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, data: result.data };
}

function optionalText(maxLength: number) {
  return z.preprocess(
    (value) => {
      if (value === null || value === undefined) return undefined;
      if (typeof value !== "string") return value;
      const text = value.trim();
      return text ? text : undefined;
    },
    z.string().max(maxLength).refine((value) => !controlCharacterPattern.test(value), "control characters are not allowed").optional(),
  );
}

function optionalInteger(min: number, max: number) {
  return z.preprocess(
    (value) => {
      if (value === null || value === undefined || value === "") return undefined;
      if (typeof value === "string") return Number(value);
      return value;
    },
    z.number().int().min(min).max(max).optional(),
  );
}

function optionalBoolean() {
  return z.boolean().optional().default(false);
}

function optionalHttpUrl(maxLength: number) {
  return optionalText(maxLength).refine((value) => {
    if (value === undefined) return true;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");
}

const adminIngestBodySchema = z
  .object({
    action: z.enum(INGEST_ACTIONS).optional().default("ingest"),
    sourceKey: optionalText(ADMIN_REF_MAX_LENGTH),
    articleId: optionalText(ADMIN_REF_MAX_LENGTH),
    slug: optionalText(ADMIN_REF_MAX_LENGTH),
    limit: optionalInteger(1, 100),
    summarizeLimit: optionalInteger(1, 100),
    summarize: optionalBoolean(),
    refreshTags: optionalBoolean(),
    allowVercelCrawling: optionalBoolean(),
  })
  .strict();

export type AdminIngestBody = z.infer<typeof adminIngestBodySchema>;

const adminReviewBodySchema = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    articleId: optionalText(ADMIN_REF_MAX_LENGTH),
    slug: optionalText(ADMIN_REF_MAX_LENGTH),
    note: optionalText(ADMIN_NOTE_MAX_LENGTH),
    provider: z.enum(LLM_PROVIDER_IDS).optional(),
    model: optionalText(ADMIN_MODEL_MAX_LENGTH),
    confirmation: optionalText(ADMIN_REF_MAX_LENGTH),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.articleId && !value.slug) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["articleId"], message: "articleId or slug is required" });
    }
    if (value.action === "close-private" && value.confirmation !== "close-private") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: "close-private requires explicit confirmation" });
    }
    if (value.action === "resummarize-with-model" && !value.model) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "model is required for resummarize-with-model" });
    }
  })
  .transform((value) => ({
    action: value.action,
    articleId: value.articleId,
    slug: value.slug,
    note: value.note,
    provider: value.provider,
    model: value.model,
  }));

export type AdminReviewBody = z.infer<typeof adminReviewBodySchema>;

const adminBulkInputSchema = z
  .object({
    action: z.enum(BULK_ACTIONS),
    confirmation: optionalText(ADMIN_REF_MAX_LENGTH),
    note: optionalText(ADMIN_NOTE_MAX_LENGTH),
    items: z
      .array(
        z
          .object({
            id: optionalText(ADMIN_REF_MAX_LENGTH),
            slug: optionalText(ADMIN_REF_MAX_LENGTH),
          })
          .strict()
          .refine((value) => Boolean(value.id || value.slug), "id or slug is required"),
      )
      .optional(),
    ids: z.array(optionalText(ADMIN_REF_MAX_LENGTH).pipe(z.string())).optional(),
    articleIds: z.array(optionalText(ADMIN_REF_MAX_LENGTH).pipe(z.string())).optional(),
    slugs: z.array(optionalText(ADMIN_REF_MAX_LENGTH).pipe(z.string())).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "close-private" && value.confirmation !== "close-private") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: "close-private requires explicit confirmation" });
    }
  })
  .transform((value, context) => {
    const refs: AdminArticleBulkRef[] = [];

    for (const item of value.items ?? []) refs.push({ id: item.id, slug: item.slug });
    for (const id of value.ids ?? []) refs.push({ id });
    for (const id of value.articleIds ?? []) refs.push({ id });
    for (const slug of value.slugs ?? []) refs.push({ slug });

    const seen = new Set<string>();
    const uniqueRefs = refs.filter((ref) => {
      const key = ref.id ? `id:${ref.id}` : `slug:${ref.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (uniqueRefs.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Select explicit article ids or slugs" });
      return z.NEVER;
    }
    if (uniqueRefs.length > ADMIN_BULK_MAX_ITEMS) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Bulk actions are limited to 100 explicitly selected articles" });
      return z.NEVER;
    }

    return {
      action: value.action,
      refs: uniqueRefs,
      note: value.note,
    };
  });

export type AdminArticleBulkBody = z.infer<typeof adminBulkInputSchema>;

const adminCandidateQuerySchema = z
  .object({
    source: optionalText(ADMIN_REF_MAX_LENGTH),
    status: optionalText(40).pipe(z.enum(CANDIDATE_STATUSES).optional()),
    type: optionalText(80),
    q: optionalText(ADMIN_QUERY_TEXT_MAX_LENGTH),
    page: optionalInteger(1, 10_000),
    pageSize: optionalInteger(1, 100),
  })
  .strict();

export type AdminCandidateQuery = z.infer<typeof adminCandidateQuerySchema>;

const adminCandidateMutationSchema = z
  .object({
    isForm: z.boolean().optional().default(false),
    csrfToken: optionalText(ADMIN_REF_MAX_LENGTH),
    candidateId: optionalText(ADMIN_CANDIDATE_ID_MAX_LENGTH),
    action: optionalText(40).pipe(z.enum(CANDIDATE_ACTIONS).optional()),
    status: optionalText(40).pipe(z.enum(CANDIDATE_STATUSES).optional()),
    returnTo: optionalText(ADMIN_RETURN_TO_MAX_LENGTH),
  })
  .strict()
  .transform((value, context) => {
    const statusFromAction = value.action ? ACTION_TO_STATUS[value.action] : undefined;
    const targetStatus = value.status ?? statusFromAction;
    if (!value.action && !value.status) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "action or status is required" });
      return z.NEVER;
    }
    if (statusFromAction && value.status && statusFromAction !== value.status) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "action and status do not match" });
      return z.NEVER;
    }
    if (!value.candidateId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateId"], message: "candidateId is required" });
      return z.NEVER;
    }
    if (!targetStatus) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Invalid status" });
      return z.NEVER;
    }

    return {
      ...value,
      candidateId: value.candidateId,
      targetStatus,
    };
  });

export type AdminCandidateMutationBody = z.infer<typeof adminCandidateMutationSchema>;

const llmKeyInputSchema = z
  .object({
    id: optionalText(120),
    label: optionalText(120),
    value: optionalText(ADMIN_LLM_KEY_VALUE_MAX_LENGTH),
    delete: z.boolean().optional(),
  })
  .strict();

const llmProviderSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultModel: optionalText(ADMIN_LLM_MODEL_MAX_LENGTH),
    displayName: optionalText(120),
    baseUrl: optionalHttpUrl(ADMIN_LLM_BASE_URL_MAX_LENGTH),
    keys: z.array(llmKeyInputSchema).max(50).optional(),
  })
  .strict();

const llmProvidersSchema = z
  .object({
    gemini: llmProviderSettingsSchema.optional(),
    openai: llmProviderSettingsSchema.optional(),
    anthropic: llmProviderSettingsSchema.optional(),
    "openai-compatible": llmProviderSettingsSchema.optional(),
  })
  .strict();

const adminLlmSettingsSchema = z
  .object({
    summary: z
      .object({
        provider: z.enum(LLM_PROVIDER_IDS).optional(),
        model: optionalText(ADMIN_LLM_MODEL_MAX_LENGTH),
      })
      .strict()
      .optional(),
    providers: llmProvidersSchema.optional(),
  })
  .strict();

const adminLlmTestSchema = z
  .object({
    provider: z.enum(LLM_PROVIDER_IDS),
    model: optionalText(ADMIN_LLM_MODEL_MAX_LENGTH),
  })
  .strict();

export type AdminLlmTestBody = z.infer<typeof adminLlmTestSchema>;

const adminJobRunBodySchema = z
  .object({
    maxJobs: optionalInteger(1, 10),
    leaseSeconds: optionalInteger(10, 600),
    jobTypes: z.array(z.enum(INGEST_ACTIONS)).min(1).max(5).optional(),
  })
  .strict();

export type AdminJobRunBody = z.infer<typeof adminJobRunBodySchema>;

const adminJobActionBodySchema = z
  .object({
    action: z.enum(JOB_ACTIONS),
    reason: optionalText(ADMIN_JOB_REASON_MAX_LENGTH),
  })
  .strict();

export type AdminJobActionBody = z.infer<typeof adminJobActionBodySchema>;

function searchParamsObject(searchParams: URLSearchParams) {
  return Object.fromEntries(searchParams.entries());
}

export function parseAdminIngestBody(body: unknown): ValidationResult<AdminIngestBody> {
  return validationResult(adminIngestBodySchema.safeParse(body));
}

export function parseAdminReviewBody(body: unknown): ValidationResult<AdminReviewBody> {
  return validationResult(adminReviewBodySchema.safeParse(body));
}

export function parseAdminArticleBulkBody(body: unknown): ValidationResult<AdminArticleBulkBody> {
  return validationResult(adminBulkInputSchema.safeParse(body));
}

export function parseAdminCandidateQuery(searchParams: URLSearchParams): ValidationResult<AdminCandidateQuery> {
  return validationResult(adminCandidateQuerySchema.safeParse(searchParamsObject(searchParams)));
}

export function parseAdminCandidateMutationBody(body: unknown): ValidationResult<AdminCandidateMutationBody> {
  return validationResult(adminCandidateMutationSchema.safeParse(body));
}

export function parseAdminLlmSettingsBody(body: unknown): ValidationResult<AdminLlmSettingsInput> {
  return validationResult(adminLlmSettingsSchema.safeParse(body));
}

export function parseAdminLlmTestBody(body: unknown): ValidationResult<AdminLlmTestBody> {
  return validationResult(adminLlmTestSchema.safeParse(body));
}

export function parseAdminJobRunBody(body: unknown): ValidationResult<AdminJobRunBody> {
  return validationResult(adminJobRunBodySchema.safeParse(body));
}

export function parseAdminJobActionBody(body: unknown): ValidationResult<AdminJobActionBody> {
  return validationResult(adminJobActionBodySchema.safeParse(body));
}
