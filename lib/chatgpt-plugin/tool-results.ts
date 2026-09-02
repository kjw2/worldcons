import { safeToolError } from "@/lib/chatgpt-plugin/errors";

export function jsonToolResult(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

export function errorToolResult(error: unknown) {
  const safe = safeToolError(error);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
          ...(safe.retryAfter ? { retryAfter: safe.retryAfter } : {}),
        },
      }),
    }],
    isError: true,
  };
}

export async function runTool<T>(
  toolName: string,
  requestId: string,
  action: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    const value = await action();
    console.log(JSON.stringify({
      event: "worldcons_plugin_mcp_call",
      requestId,
      toolName,
      status: "ok",
      durationMs: Date.now() - startedAt,
    }));
    return jsonToolResult(value);
  } catch (error) {
    const safe = safeToolError(error);
    console.warn(JSON.stringify({
      event: "worldcons_plugin_mcp_call",
      requestId,
      toolName,
      status: "error",
      errorClass: safe.code,
      durationMs: Date.now() - startedAt,
    }));
    return errorToolResult(safe);
  }
}
