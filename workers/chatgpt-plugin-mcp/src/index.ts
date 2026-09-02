import { createMcpHandler } from "agents/mcp/server";
import { createWorldconsMcpServer } from "./server";
import { WorldconsSearchClient } from "./search-client";

const SERVICE_NAME = "worldcons-plugin-mcp";

export async function handleWorldconsPluginRequest(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
) {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return Response.json({
      service: SERVICE_NAME,
      name: "헌법판례요약시스템",
      homepage: "https://worldcons.vercel.app/guide/chatgpt-plugin",
      mcp: "/mcp",
    }, { headers: publicJsonHeaders("public, max-age=300") });
  }

  if (url.pathname === "/health") {
    return healthResponse(env);
  }

  if (url.pathname !== "/mcp") {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "The requested endpoint does not exist." } },
      { status: 404, headers: publicJsonHeaders("no-store") },
    );
  }

  const client = clientFor(env);
  const handler = createMcpHandler(
    () => createWorldconsMcpServer(client),
    {
      route: "/mcp",
      legacy: "stateless",
      onerror(error) {
        console.error(JSON.stringify({
          event: "worldcons_plugin_mcp_protocol_error",
          error: error.name,
        }));
      },
    },
  );
  return handler(request, env, ctx);
}

async function healthResponse(env: Cloudflare.Env) {
  const requestId = crypto.randomUUID();
  try {
    await clientFor(env).health(requestId);
    return Response.json({
      status: "ready",
      service: SERVICE_NAME,
      version: env.VERSION_METADATA.id,
      checks: { searchApi: "ok" },
    }, { headers: publicJsonHeaders("public, max-age=30") });
  } catch {
    return Response.json({
      status: "degraded",
      service: SERVICE_NAME,
      version: env.VERSION_METADATA.id,
      checks: { searchApi: "unavailable" },
    }, { status: 503, headers: publicJsonHeaders("no-store") });
  }
}

function clientFor(env: Cloudflare.Env) {
  return new WorldconsSearchClient({
    searchApi: env.SEARCH_API,
    siteBaseUrl: env.SITE_BASE_URL,
    detailTextLimit: boundedConfigInteger(env.SEARCH_DETAIL_TEXT_LIMIT, 16_000, 1, 350_000),
    sourceTextPageLimit: boundedConfigInteger(env.SOURCE_TEXT_PAGE_LIMIT, 12_000, 1, 50_000),
  });
}

function boundedConfigInteger(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function publicJsonHeaders(cacheControl: string) {
  return {
    "Cache-Control": cacheControl,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

export default {
  fetch(request, env, ctx) {
    return handleWorldconsPluginRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
