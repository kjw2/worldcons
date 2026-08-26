import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSession,
  isSecureRequest,
  safeAdminNextPath,
  validateAdminCredentials,
} from "@/lib/utils/auth";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function redirectUrl(request: Request, path: string) {
  return new URL(path, request.url);
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const rateLimit = await consumeRateLimit(request, "adminLogin");
  if (rateLimit?.limited) {
    if (contentType.includes("application/json")) {
      return rateLimitExceededResponse(rateLimit, "Too many login attempts");
    }

    const response = NextResponse.redirect(redirectUrl(request, "/admin/login?error=rate_limit"), { status: 303 });
    for (const [key, value] of new Headers(rateLimit.headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  let username = "";
  let password = "";
  let nextPath = "/admin";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    username = typeof body.username === "string" ? body.username : "";
    password = typeof body.password === "string" ? body.password : "";
    nextPath = safeAdminNextPath(typeof body.next === "string" ? body.next : null);
  } else {
    const formData = await request.formData();
    username = String(formData.get("username") ?? "");
    password = String(formData.get("password") ?? "");
    nextPath = safeAdminNextPath(String(formData.get("next") ?? "/admin"));
  }

  if (!validateAdminCredentials(username, password)) {
    if (contentType.includes("application/json")) {
      return NextResponse.json({ error: "Invalid admin credentials" }, { status: 401 });
    }

    const failedUrl = redirectUrl(request, `/admin/login?error=1&next=${encodeURIComponent(nextPath)}`);
    return NextResponse.redirect(failedUrl, { status: 303 });
  }

  const response = contentType.includes("application/json")
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(redirectUrl(request, nextPath), { status: 303 });

  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: createAdminSession(),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
