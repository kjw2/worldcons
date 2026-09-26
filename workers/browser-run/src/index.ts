import { launch } from "@cloudflare/playwright";

const MAX_HTML_BYTES = 3_000_000;
const MAX_TIMEOUT_MS = 60_000;

interface NavigateRequest {
  url: string;
  timeoutMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  waitForSelector?: string;
  userAgent?: string;
}

interface ParsedNavigateRequest extends NavigateRequest {
  timeoutMs: number;
  waitUntil: "load" | "domcontentloaded" | "networkidle";
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function authorized(request: Request, env: Env) {
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env.BROWSER_RUN_TOKEN?.trim();
  if (!supplied || !expected) return false;
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  if (difference !== 0) {
    console.warn(JSON.stringify({ event: "browser_auth_failed", suppliedLength: supplied.length, expectedLength: expected.length }));
  }
  return difference === 0;
}

function allowedTarget(value: string, env: Env) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("browser.invalid_url");
  const roots = env.BROWSER_ALLOWED_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  if (!roots.some((root) => hostname === root || hostname.endsWith(`.${root}`))) {
    throw new Error("browser.host_not_allowed");
  }
  return url;
}

function parseBody(value: unknown, env: Env): ParsedNavigateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser.invalid_body");
  const input = value as Partial<NavigateRequest>;
  if (typeof input.url !== "string" || input.url.length > 2_048) throw new Error("browser.invalid_url");
  const url = allowedTarget(input.url, env);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(input.timeoutMs ?? 45_000)));
  const waitUntil = input.waitUntil ?? "domcontentloaded";
  if (!["load", "domcontentloaded", "networkidle"].includes(waitUntil)) throw new Error("browser.invalid_wait_until");
  if (input.waitForSelector && (input.waitForSelector.length > 200 || /[\u0000-\u001f\u007f]/.test(input.waitForSelector))) {
    throw new Error("browser.invalid_selector");
  }
  return {
    url: url.toString(),
    timeoutMs,
    waitUntil,
    waitForSelector: input.waitForSelector,
    userAgent: typeof input.userAgent === "string" && input.userAgent.length <= 300 ? input.userAgent : undefined,
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ schemaVersion: 1, service: "worldcons-browser-run" });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/navigate") return json({ error: "not_found" }, 404);
    if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401);

    let input: ParsedNavigateRequest;
    try {
      input = parseBody(await request.json(), env);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "browser.invalid_body" }, 400);
    }

    const browser = await launch(env.BROWSER, { keep_alive: 60_000 });
    try {
      const page = await browser.newPage(input.userAgent ? { userAgent: input.userAgent } : undefined);
      const response = await page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
      let selectorMatched: boolean | undefined;
      if (input.waitForSelector) {
        selectorMatched = await page.waitForSelector(input.waitForSelector, { timeout: Math.min(input.timeoutMs, 10_000) })
          .then(() => true, () => false);
      }
      const html = await page.content();
      if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) return json({ error: "browser.response_too_large" }, 413);
      const finalUrl = page.url();
      const status = response?.status() ?? 200;
      const headers = response?.headers() ?? {};
      return json({
        schemaVersion: 1,
        url: input.url,
        finalUrl,
        status,
        headers,
        contentType: headers["content-type"],
        html,
        fetchedAt: new Date().toISOString(),
        diagnostics: {
          redirected: finalUrl !== input.url,
          redirectChain: finalUrl !== input.url ? [input.url, finalUrl] : undefined,
          blocked: status === 403 || status === 429,
          selectorMatched,
          title: await page.title().catch(() => ""),
          description: await page.locator("meta[name='description']").first().getAttribute("content").catch(() => null),
          errorCode: status >= 400 ? `HTTP_${status}` : undefined,
          errorMessage: status >= 400 ? "Browser Run navigation returned an HTTP error." : undefined,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({
        schemaVersion: 1,
        url: input.url,
        finalUrl: input.url,
        status: 0,
        headers: {},
        fetchedAt: new Date().toISOString(),
        diagnostics: {
          timeout: /timeout/i.test(message),
          errorCode: /timeout/i.test(message) ? "TIMEOUT" : "BROWSER_RUN_ERROR",
          errorMessage: message.slice(0, 500),
        },
      }, 502);
    } finally {
      await browser.close();
    }
  },
} satisfies ExportedHandler<Env>;
