import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, isSecureRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function logoutResponse(request: Request) {
  const response = NextResponse.redirect(new URL("/admin/login?loggedOut=1", request.url), { status: 303 });
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
  return logoutResponse(request);
}

export async function GET(request: Request) {
  return logoutResponse(request);
}
