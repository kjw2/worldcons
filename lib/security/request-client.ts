import { createHash, createHmac } from "node:crypto";

export type HeaderLike = {
  get(name: string): string | null;
};

// Client IP drives rate-limit bucket keys and analytics identifiers, so it must only
// come from a header the current deployment actually controls. Any header a client can
// set at will would let a caller rotate its own bucket key and bypass the limit.
//
// Cloudflare overwrites `cf-connecting-ip` at the edge, so it is the only
// platform-trusted client address by default. Other proxy headers require an
// explicit opt-in and must never outrank the Cloudflare edge identity.
const PLATFORM_CLIENT_IP_HEADERS = ["cf-connecting-ip"] as const;
const OPT_IN_CLIENT_IP_HEADERS = new Set(["true-client-ip", "x-forwarded-for", "x-real-ip", "x-client-ip"]);

function limitText(value?: string | null, max = 300) {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function trustedOptInHeaders() {
  return (process.env.TRUSTED_CLIENT_IP_HEADERS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => OPT_IN_CLIENT_IP_HEADERS.has(name));
}

function firstForwardedAddress(value: string | null) {
  // A forwarding chain is "client, proxy1, proxy2"; the left-most entry is the client.
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .find(Boolean) ?? null
  );
}

export function clientIpHeaderPriority() {
  return [...PLATFORM_CLIENT_IP_HEADERS, ...trustedOptInHeaders()];
}

export function getClientIp(headers?: HeaderLike) {
  for (const name of clientIpHeaderPriority()) {
    const value = firstForwardedAddress(headers?.get(name) ?? null);
    if (value) return limitText(value.replace(/^\[|\]$/g, ""), 120);
  }

  return null;
}

export function hashRequestValue(value?: string | null) {
  if (!value) return null;
  const secret =
    process.env.ANALYTICS_HASH_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.CRON_SECRET;

  if (secret) {
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  return createHash("sha256").update(value).digest("hex");
}
