const endpoint = process.argv[2]?.trim() || "https://worldcons.vercel.app/api/mcp";
const url = new URL(endpoint);
if (url.protocol !== "https:" && url.hostname !== "localhost") {
  throw new Error("MCP smoke endpoint must use HTTPS, except for localhost.");
}

async function rpc(id: number, method: string, params: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const payload = await response.json() as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
  if (!response.ok || payload.error || !payload.result) {
    throw new Error(`MCP ${method} failed (${response.status}): ${payload.error?.message ?? "invalid response"}`);
  }
  return payload.result;
}

async function main() {
  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "worldcons-smoke", version: "1.0.0" },
  });
  const listed = await rpc(2, "tools/list", {});
  const searched = await rpc(3, "tools/call", {
    name: "search",
    arguments: { query: "표현의 자유" },
  });

  const tools = Array.isArray(listed.tools)
    ? listed.tools.flatMap((tool) => tool && typeof tool === "object" && "name" in tool ? [String(tool.name)] : [])
    : [];
  const structuredContent = searched.structuredContent && typeof searched.structuredContent === "object"
    ? searched.structuredContent as { results?: Array<{ id?: string }> }
    : {};
  const results = Array.isArray(structuredContent.results) ? structuredContent.results : [];
  const serverInfo = initialized.serverInfo && typeof initialized.serverInfo === "object"
    ? initialized.serverInfo as { name?: string; version?: string }
    : {};

  console.log(JSON.stringify({
    status: "ok",
    endpoint: url.toString(),
    server: serverInfo.name,
    version: serverInfo.version,
    tools: tools.sort(),
    searchResultCount: results.length,
    firstResultId: results[0]?.id ?? null,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MCP smoke failed.");
  process.exitCode = 1;
});
