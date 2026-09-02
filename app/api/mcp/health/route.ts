import { NextResponse } from "next/server";
import { WorldconsCaseService } from "@/lib/chatgpt-plugin/case-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    await new WorldconsCaseService().health();
    return NextResponse.json({
      status: "ready",
      service: "worldcons-plugin-mcp",
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      deployment: "vercel",
      checks: { database: "ok", search: "ok" },
    }, { headers: { "Cache-Control": "public, s-maxage=30" } });
  } catch (error) {
    console.warn("[plugin-mcp-health] readiness check failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({
      status: "degraded",
      service: "worldcons-plugin-mcp",
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      deployment: "vercel",
      checks: { database: "unavailable", search: "unavailable" },
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
