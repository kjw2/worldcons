import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_SESSION_COOKIE = "worldcons_admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const DEFAULT_ADMIN_USERNAME = "ap570@naver.com";

interface AdminSessionPayload {
  username: string;
  expiresAt: number;
}

function configuredSecret() {
  const secret = process.env.CRON_SECRET?.trim();
  return secret || null;
}

function configuredAdminUsername() {
  return process.env.ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME;
}

function configuredAdminPassword() {
  const password = process.env.ADMIN_PASSWORD?.trim();
  return password || null;
}

function configuredSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim() || process.env.ADMIN_PASSWORD?.trim();
  if (secret) return secret;
  return process.env.NODE_ENV !== "production" ? "worldcons-local-admin-session-secret" : null;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function signPayload(payload: string) {
  const secret = configuredSessionSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cookieValueFromRequest(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

export function validateAdminCredentials(username: string, password: string) {
  const expectedUsername = configuredAdminUsername();
  const expectedPassword = configuredAdminPassword();
  const usernameMatches = safeEqual(username.trim(), expectedUsername);
  const passwordMatches = expectedPassword
    ? safeEqual(password, expectedPassword)
    : safeEqual(password, "missing-admin-password") && false;

  return usernameMatches && Boolean(expectedPassword) && passwordMatches;
}

export function createAdminSession(username = configuredAdminUsername()) {
  const payload: AdminSessionPayload = {
    username,
    expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signPayload(encodedPayload);
  if (!signature) {
    throw new Error("ADMIN_SESSION_SECRET or ADMIN_PASSWORD is required for admin login.");
  }

  return `${encodedPayload}.${signature}`;
}

export function verifyAdminSession(sessionValue?: string | null) {
  if (!sessionValue) {
    return false;
  }

  const [encodedPayload, signature] = sessionValue.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = signPayload(encodedPayload);
  if (!expectedSignature || !safeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<AdminSessionPayload>;
    return (
      payload.username === configuredAdminUsername() &&
      typeof payload.expiresAt === "number" &&
      Number.isFinite(payload.expiresAt) &&
      payload.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}

export function isAuthorizedRequest(request: Request) {
  if (verifyAdminSession(cookieValueFromRequest(request, ADMIN_SESSION_COOKIE))) {
    return true;
  }

  const secret = configuredSecret();

  if (!secret) {
    return false;
  }

  const auth = request.headers.get("authorization");
  const querySecret = new URL(request.url).searchParams.get("secret");
  return auth === `Bearer ${secret}` || querySecret === secret;
}

export function isAuthorizedSecret(secretValue?: string | null) {
  const secret = configuredSecret();
  return Boolean(secret && secretValue === secret);
}

export async function isAuthorizedPageRequest() {
  const cookieStore = await cookies();
  return verifyAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}

export function safeAdminNextPath(value?: string | null) {
  if (!value || value.startsWith("//") || value.includes("\\")) {
    return "/admin";
  }

  if (value === "/admin" || value.startsWith("/admin/") || value.startsWith("/admin?")) {
    return value;
  }

  return "/admin";
}

export function isSecureRequest(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}
