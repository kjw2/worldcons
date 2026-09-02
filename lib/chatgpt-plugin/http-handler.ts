import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WorldconsCaseService } from "@/lib/chatgpt-plugin/case-service";
import { createWorldconsMcpServer } from "@/lib/chatgpt-plugin/server";

export async function handleWorldconsMcpRequest(
  request: Request,
  service = new WorldconsCaseService(),
) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createWorldconsMcpServer(service);

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withPublicMcpHeaders(response);
  } catch (error) {
    console.error(JSON.stringify({
      event: "worldcons_plugin_mcp_protocol_error",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    }));
    return withPublicMcpHeaders(Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal MCP server error" },
    }, { status: 500 }));
  } finally {
    await server.close().catch(() => undefined);
  }
}

export function mcpMethodNotAllowed() {
  return withPublicMcpHeaders(Response.json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Method not allowed." },
  }, { status: 405, headers: { Allow: "POST, OPTIONS" } }));
}

export function mcpOptionsResponse() {
  return withPublicMcpHeaders(new Response(null, { status: 204 }));
}

export function mcpRateLimitExceeded(retryAfterSeconds: number) {
  return withPublicMcpHeaders(Response.json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Too many MCP requests. Please retry later." },
  }, {
    status: 429,
    headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
  }));
}

function withPublicMcpHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
  headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
