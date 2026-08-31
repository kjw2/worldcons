import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, adminMutationAuthFailureStatus, isMasterdashSsoOnly, isSecureRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function logoutResponse(request: Request) {
  const response = NextResponse.redirect(new URL(isMasterdashSsoOnly() ? "/" : "/admin/login?loggedOut=1", request.url), { status: 303 });
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  const csrfToken = formData?.get("csrfToken");
  const authFailureStatus = adminMutationAuthFailureStatus(request, typeof csrfToken === "string" ? csrfToken : undefined);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  return logoutResponse(request);
}

export async function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
}
