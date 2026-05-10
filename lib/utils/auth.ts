import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

export const ADMIN_SESSION_COOKIE = "worldcons_admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

interface AdminSessionPayload {
  username: string;
  expiresAt: number;
}

function configuredSecret() {
  const secret = process.env.CRON_SECRET?.trim();
  return secret || null;
}

function configuredAdminUsername() {
  return process.env.ADMIN_USERNAME?.trim() || "admin";
}

function configuredAdminPassword() {
  const password = process.env.ADMIN_PASSWORD?.trim();
  return password || configuredSecret();
}

function configuredSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim() || process.env.ADMIN_PASSWORD?.trim() || configuredSecret();
  if (secret) return secret;
  return process.env.NODE_ENV !== "production" ? "worldcons-local-admin-session-secret" : null;
}

function allowLocalDevelopmentCredentials() {
  return !configuredAdminPassword() && process.env.NODE_ENV !== "production";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
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

  if (allowLocalDevelopmentCredentials()) {
    return username.trim() === "admin" && password === "admin";
  }

  if (!expectedPassword) {
    return false;
  }

  return username.trim() === expectedUsername && safeEqual(password, expectedPassword);
}

export function createAdminSession(username = configuredAdminUsername()) {
  const payload: AdminSessionPayload = {
    username,
    expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signPayload(encodedPayload);
  if (!signature) {
    throw new Error("ADMIN_SESSION_SECRET, ADMIN_PASSWORD, or CRON_SECRET is required for admin login.");
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

export async function isAuthorizedPageRequest(secretValue?: string | null) {
  const cookieStore = await cookies();
  if (verifyAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value)) {
    return true;
  }

  if (isAuthorizedSecret(secretValue)) {
    return true;
  }

  const secret = configuredSecret();
  if (!secret) {
    return false;
  }

  const headerStore = await headers();
  return headerStore.get("authorization") === `Bearer ${secret}`;
}
