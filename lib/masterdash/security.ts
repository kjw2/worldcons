import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MASTERDASH_SYSTEM_ID = "worldcons";
export const MASTERDASH_SSO_ISSUER = "masterdash";
export const MASTERDASH_SSO_AUDIENCE = "worldcons-admin";
export const MASTERDASH_CONTROL_VERSION = "2026-08-01";
export const MASTERDASH_ACTIONS = ["incremental_collect", "pause_collection", "resume_collection"] as const;

export type MasterdashAction = (typeof MASTERDASH_ACTIONS)[number];

export interface MasterdashSsoClaims {
  iss: string;
  aud: string;
  sub: string;
  role: "owner" | "admin" | "operator";
  systemId: typeof MASTERDASH_SYSTEM_ID;
  iat: number;
  exp: number;
  jti: string;
  email?: string;
  name?: string;
  workspaceId?: string;
  workspaceSlug?: string;
}

export interface MasterdashControlRequest {
  version: typeof MASTERDASH_CONTROL_VERSION;
  requestId: string;
  systemId: typeof MASTERDASH_SYSTEM_ID;
  action: MasterdashAction;
  requestedAt: string;
  requestedBy: {
    userId: string;
    email?: string;
    workspaceId: string;
    role: "owner" | "admin" | "operator";
  };
}

export class MasterdashSecurityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MasterdashSecurityError";
  }
}

const encoder = new TextEncoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(["owner", "admin", "operator"]);
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_TOKEN_LIFETIME_SECONDS = 60;
export const MASTERDASH_CONTROL_WINDOW_MS = 60_000;
export const MASTERDASH_MAX_BODY_BYTES = 64 * 1024;

function requiredSecret(value: string | undefined, name: string) {
  const secret = value?.trim();
  if (!secret || encoder.encode(secret).byteLength < 32) {
    throw new MasterdashSecurityError(`${name} is not configured with at least 32 bytes.`, 503);
  }
  return secret;
}

function safeEqual(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function decodeBase64UrlJson(value: string) {
  if (!value || !BASE64URL_PATTERN.test(value)) {
    throw new MasterdashSecurityError("Malformed MasterDash token.", 401);
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new MasterdashSecurityError("Malformed MasterDash token.", 401);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredBoundedString(value: unknown, field: string, maxLength = 300) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new MasterdashSecurityError(`Invalid ${field}.`, 400);
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string, maxLength = 300) {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, field, maxLength);
}

export function sha256Base64Url(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function verifyMasterdashSsoToken(token: string, now = new Date()): MasterdashSsoClaims {
  const secret = requiredSecret(process.env.MASTERDASH_SSO_SECRET, "MASTERDASH_SSO_SECRET");
  if (token.length > 8_192) throw new MasterdashSecurityError("Malformed MasterDash token.", 401);

  const parts = token.split(".");
  if (parts.length !== 3) throw new MasterdashSecurityError("Malformed MasterDash token.", 401);
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!isRecord(header) || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) {
    throw new MasterdashSecurityError("Unsupported MasterDash token algorithm.", 401);
  }
  if (!signature || !BASE64URL_PATTERN.test(signature)) {
    throw new MasterdashSecurityError("Malformed MasterDash token signature.", 401);
  }
  const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  if (!safeEqual(signature, expected)) throw new MasterdashSecurityError("Invalid MasterDash token signature.", 401);
  if (!isRecord(payload)) throw new MasterdashSecurityError("Invalid MasterDash token claims.", 401);

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const iat = payload.iat;
  const exp = payload.exp;
  if (
    payload.iss !== MASTERDASH_SSO_ISSUER ||
    payload.aud !== MASTERDASH_SSO_AUDIENCE ||
    payload.systemId !== MASTERDASH_SYSTEM_ID ||
    !Number.isInteger(iat) ||
    !Number.isInteger(exp) ||
    (exp as number) <= (iat as number) ||
    (exp as number) - (iat as number) > MAX_TOKEN_LIFETIME_SECONDS ||
    (iat as number) > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    (exp as number) <= nowSeconds ||
    (exp as number) > nowSeconds + MAX_TOKEN_LIFETIME_SECONDS + MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new MasterdashSecurityError("Invalid or expired MasterDash token claims.", 401);
  }

  const role = requiredBoundedString(payload.role, "role", 40);
  if (!ALLOWED_ROLES.has(role)) throw new MasterdashSecurityError("MasterDash role is not allowed.", 403);

  return {
    iss: MASTERDASH_SSO_ISSUER,
    aud: MASTERDASH_SSO_AUDIENCE,
    sub: requiredBoundedString(payload.sub, "sub", 200),
    role: role as MasterdashSsoClaims["role"],
    systemId: MASTERDASH_SYSTEM_ID,
    iat: iat as number,
    exp: exp as number,
    jti: requiredBoundedString(payload.jti, "jti", 200),
    email: optionalBoundedString(payload.email, "email", 320),
    name: optionalBoundedString(payload.name, "name", 200),
    workspaceId: optionalBoundedString(payload.workspaceId, "workspaceId", 200),
    workspaceSlug: optionalBoundedString(payload.workspaceSlug, "workspaceSlug", 200),
  };
}

function parseControlBody(rawBody: string): MasterdashControlRequest {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new MasterdashSecurityError("Invalid JSON body.", 400);
  }
  if (!isRecord(value) || !isRecord(value.requestedBy)) {
    throw new MasterdashSecurityError("Invalid MasterDash control body.", 400);
  }
  if (value.version !== MASTERDASH_CONTROL_VERSION || value.systemId !== MASTERDASH_SYSTEM_ID) {
    throw new MasterdashSecurityError("Invalid MasterDash control target or version.", 400);
  }
  if (typeof value.action !== "string" || !(MASTERDASH_ACTIONS as readonly string[]).includes(value.action)) {
    throw new MasterdashSecurityError("Unsupported MasterDash control action.", 400);
  }
  const action = value.action as MasterdashAction;
  const requestId = requiredBoundedString(value.requestId, "requestId", 64);
  if (!UUID_PATTERN.test(requestId)) throw new MasterdashSecurityError("Invalid requestId.", 400);
  const requestedAt = requiredBoundedString(value.requestedAt, "requestedAt", 64);
  const requestedBy = value.requestedBy;
  const role = requiredBoundedString(requestedBy.role, "requestedBy.role", 40);
  if (!ALLOWED_ROLES.has(role)) throw new MasterdashSecurityError("MasterDash role is not allowed.", 403);
  if (role === "operator" && action !== "incremental_collect") {
    throw new MasterdashSecurityError("MasterDash operator role cannot change collection pause state.", 403);
  }
  return {
    version: MASTERDASH_CONTROL_VERSION,
    requestId,
    systemId: MASTERDASH_SYSTEM_ID,
    action,
    requestedAt,
    requestedBy: {
      userId: requiredBoundedString(requestedBy.userId, "requestedBy.userId", 200),
      email: optionalBoundedString(requestedBy.email, "requestedBy.email", 320),
      workspaceId: requiredBoundedString(requestedBy.workspaceId, "requestedBy.workspaceId", 200),
      role: role as MasterdashControlRequest["requestedBy"]["role"],
    },
  };
}

export function verifyMasterdashControlRequest(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  requestId: string | null;
  now?: Date;
}) {
  const secret = requiredSecret(process.env.MASTERDASH_CONTROL_SECRET, "MASTERDASH_CONTROL_SECRET");
  if (encoder.encode(input.rawBody).byteLength > MASTERDASH_MAX_BODY_BYTES) {
    throw new MasterdashSecurityError("MasterDash control body is too large.", 413);
  }
  const timestamp = input.timestamp?.trim();
  const signature = input.signature?.trim();
  if (!timestamp || !signature || !BASE64URL_PATTERN.test(signature)) {
    throw new MasterdashSecurityError("Missing MasterDash control authentication headers.", 401);
  }
  const timestampMs = Date.parse(timestamp);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MASTERDASH_CONTROL_WINDOW_MS) {
    throw new MasterdashSecurityError("MasterDash control timestamp is outside the allowed window.", 401);
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${input.rawBody}`).digest("base64url");
  if (!safeEqual(signature, expected)) throw new MasterdashSecurityError("Invalid MasterDash control signature.", 403);

  const body = parseControlBody(input.rawBody);
  if (body.requestId !== input.requestId?.trim() || body.requestedAt !== timestamp) {
    throw new MasterdashSecurityError("MasterDash control headers do not match the body.", 400);
  }
  if (Date.parse(body.requestedAt) !== timestampMs) {
    throw new MasterdashSecurityError("Invalid requestedAt timestamp.", 400);
  }
  return { body, bodyHash: sha256Base64Url(input.rawBody) };
}
