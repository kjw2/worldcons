type RedactableAuditEventInput = {
  eventType?: string;
  path?: string | null;
  articleId?: string | null;
  articleSlug?: string | null;
  articleTitle?: string | null;
  sourceKey?: string | null;
  metadata?: Record<string, unknown>;
};

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const MAX_AUDIT_STRING_LENGTH = 500;
const MAX_REDACTION_DEPTH = 8;

const httpUrlPattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const openAiLikeKeyPattern = /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g;
const geminiKeyPattern = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi;
const inlineSecretPattern = /(\b(?:api[_-]?key|token|secret|password|authorization|cookie|csrf)\b\s*[:=]\s*)[^\s,;&]+/gi;
const sensitiveKeyPattern = /(?:api[_-]?key|secret|token|password|authorization|cookie|csrf|bearer|session|x[_-]?cron[_-]?secret)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxLength = MAX_AUDIT_STRING_LENGTH) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - TRUNCATED.length))}${TRUNCATED}`;
}

function stripAbsoluteUrlQuery(value: string) {
  return value.replace(httpUrlPattern, (match) => {
    const trailing = match.match(/[),.;:]+$/)?.[0] ?? "";
    const urlText = trailing ? match.slice(0, -trailing.length) : match;
    try {
      const url = new URL(urlText);
      url.search = "";
      url.hash = "";
      return `${url.toString()}${trailing}`;
    } catch {
      return match;
    }
  });
}

function stripRelativePathQuery(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const endIndex = [queryIndex, hashIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  return endIndex === undefined ? value : value.slice(0, endIndex);
}

export function isAdminAuditEventType(value: unknown) {
  return value === "admin_action" || value === "admin_review_action";
}

export function redactAdminAuditText(value: string, maxLength = MAX_AUDIT_STRING_LENGTH) {
  const withoutUrlQueries = stripRelativePathQuery(stripAbsoluteUrlQuery(value.trim()));
  const redacted = withoutUrlQueries
    .replace(openAiLikeKeyPattern, REDACTED)
    .replace(geminiKeyPattern, REDACTED)
    .replace(bearerTokenPattern, `Bearer ${REDACTED}`)
    .replace(inlineSecretPattern, `$1${REDACTED}`);
  return truncateText(redacted, maxLength);
}

export function redactAdminAuditPath(value?: string | null) {
  if (value === undefined || value === null) return value;
  return redactAdminAuditText(value);
}

function redactAdminAuditValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && sensitiveKeyPattern.test(key)) return REDACTED;
  if (typeof value === "string") return redactAdminAuditText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED;

  if (Array.isArray(value)) {
    return value.map((item) => redactAdminAuditValue(item, undefined, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([entryKey, entryValue]) => [entryKey, redactAdminAuditValue(entryValue, entryKey, depth + 1)] as const)
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }

  return String(value);
}

export function redactAdminAuditMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return {};
  const redacted = redactAdminAuditValue(metadata);
  return isRecord(redacted) ? redacted : {};
}

export function redactAdminAuditEventInput<T extends RedactableAuditEventInput>(input: T): T {
  if (!isAdminAuditEventType(input.eventType)) return input;
  return {
    ...input,
    path: redactAdminAuditPath(input.path),
    articleId: typeof input.articleId === "string" ? redactAdminAuditText(input.articleId, 80) : input.articleId,
    articleSlug: typeof input.articleSlug === "string" ? redactAdminAuditText(input.articleSlug, 300) : input.articleSlug,
    articleTitle: typeof input.articleTitle === "string" ? redactAdminAuditText(input.articleTitle, 500) : input.articleTitle,
    sourceKey: typeof input.sourceKey === "string" ? redactAdminAuditText(input.sourceKey, 120) : input.sourceKey,
    metadata: input.metadata ? redactAdminAuditMetadata(input.metadata) : input.metadata,
  };
}
