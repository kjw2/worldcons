import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { consumeMasterdashJti } from "@/lib/masterdash/store";
import { MasterdashSecurityError, verifyMasterdashSsoToken } from "@/lib/masterdash/security";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSession,
} from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function secured(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokens = url.searchParams.getAll("masterdash_token");
  if (tokens.length !== 1) {
    return secured(NextResponse.json({ error: "A single MasterDash token is required." }, { status: 400 }));
  }

  try {
    const claims = verifyMasterdashSsoToken(tokens[0]);
    const consumed = await consumeMasterdashJti(claims.jti, claims.exp + 60);
    if (!consumed.ok) {
      const status = consumed.replay ? 409 : 503;
      return secured(NextResponse.json({ error: consumed.replay ? "MasterDash token was already used." : "SSO replay protection is unavailable." }, { status }));
    }

    const response = NextResponse.redirect(new URL("/admin", request.url), { status: 303 });
    response.cookies.set({
      name: ADMIN_SESSION_COOKIE,
      value: createAdminSession(),
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    });
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/auth/masterdash",
        metadata: {
          action: "masterdash.sso.exchange",
          result: "success",
          actorId: claims.sub,
          actorRole: claims.role,
          targetType: "admin_session",
          targetId: "worldcons",
        },
      },
      request.headers,
    ).catch(() => null);
    return secured(response);
  } catch (error) {
    const status = error instanceof MasterdashSecurityError ? error.status : 500;
    const message = error instanceof MasterdashSecurityError ? error.message : "MasterDash SSO exchange failed.";
    return secured(NextResponse.json({ error: message }, { status }));
  }
}
