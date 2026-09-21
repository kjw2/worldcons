import { NextResponse } from "next/server";
import { WorldconsCaseService } from "@/lib/chatgpt-plugin/case-service";
import { isCloudflareWorkerRuntime } from "@/lib/runtime/platform";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function deploymentMetadata() {
  if (isCloudflareWorkerRuntime()) {
    return { deployment: "cloudflare-workers", version: "worker" };
  }
  return {
    deployment: process.env.VERCEL ? "vercel" : "node",
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
  };
}

export async function GET() {
  const metadata = deploymentMetadata();
  try {
    await new WorldconsCaseService().health();
    return NextResponse.json({
      status: "ready",
      service: "worldcons-plugin-mcp",
      ...metadata,
      checks: { database: "ok", search: "ok" },
    }, { headers: { "Cache-Control": "public, s-maxage=30" } });
  } catch (error) {
    console.warn("[plugin-mcp-health] readiness check failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({
      status: "degraded",
      service: "worldcons-plugin-mcp",
      ...metadata,
      checks: { database: "unavailable", search: "unavailable" },
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
