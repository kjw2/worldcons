import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getAdminLlmSettingsView, saveAdminLlmSettings } from "@/lib/ai/llm-settings";
import type { AdminLlmSettingsInput } from "@/lib/ai/llm-settings-types";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ settings: await getAdminLlmSettingsView() });
}

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as AdminLlmSettingsInput;
    const settings = await saveAdminLlmSettings(body);
    await recordSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/llm-settings",
        metadata: {
          action: "save_llm_settings",
          provider: settings.summary.provider,
          model: settings.summary.model,
        },
      },
      request.headers,
    ).catch(() => null);
    return NextResponse.json({ settings });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[admin llm-settings] ${message}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

