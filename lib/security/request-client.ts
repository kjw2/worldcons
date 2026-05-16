import { createHash, createHmac } from "node:crypto";

export type HeaderLike = {
  get(name: string): string | null;
};

function limitText(value?: string | null, max = 300) {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export function getClientIp(headers?: HeaderLike) {
  const forwardedFor = headers?.get("x-forwarded-for") ?? headers?.get("x-vercel-forwarded-for");
  const firstForwarded = forwardedFor
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
  const value =
    headers?.get("cf-connecting-ip") ??
    headers?.get("true-client-ip") ??
    headers?.get("x-real-ip") ??
    firstForwarded ??
    headers?.get("x-client-ip");

  return limitText(value?.replace(/^\[|\]$/g, ""), 120);
}

export function hashRequestValue(value?: string | null) {
  if (!value) return null;
  const secret =
    process.env.ANALYTICS_HASH_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (secret) {
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  return createHash("sha256").update(value).digest("hex");
}
