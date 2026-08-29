import { NextResponse } from "next/server";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

// Temporary one-shot migration runner. Removed after the migration is applied.
const ALLOWED_MIGRATIONS = new Set(["20260829120000_admin_ops_watchdog.sql"]);

function migrationName(body: unknown) {
  if (typeof body !== "object" || body === null || !("migration" in body)) return "";
  return typeof body.migration === "string" ? body.migration : "";
}

async function ipv6Candidates(hostname: string): Promise<string[]> {
  try {
    const addresses = await lookup(hostname, { all: true });
    const v6 = addresses.filter((entry) => entry.family === 6).map((entry) => entry.address);
    if (v6.length > 0) return v6;
  } catch {
    // Fall through to DNS-over-HTTPS.
  }
  try {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=AAAA`, { signal: AbortSignal.timeout(10000) });
    const json = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    return (json.Answer ?? []).filter((entry) => entry.type === 28 && typeof entry.data === "string").map((entry) => entry.data as string);
  } catch {
    return [];
  }
}

async function runSql(connectionString: string, sql: string) {
  const url = new URL(connectionString);
  const password = decodeURIComponent(url.password);
  const user = decodeURIComponent(url.username);
  const database = url.pathname.replace(/^\//, "") || "postgres";
  const port = url.port ? Number(url.port) : 5432;

  const attempt = async (host: string) => {
    const client = new Client({ host, port, user, password, database, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try {
      await client.connect();
      await client.query(sql);
      const { rows } = await client.query("select to_regclass('public.admin_ops_events') as table_name");
      return rows[0]?.table_name as string | null;
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  const hostname = url.hostname;
  try {
    const tableName = await attempt(hostname);
    return { tableName, host: hostname };
  } catch {
    // Direct hostname failed (for example an IPv6-only host on an IPv4 resolver).
    const candidates = await ipv6Candidates(hostname);
    for (const address of candidates) {
      try {
        const tableName = await attempt(address);
        return { tableName, host: address };
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error(`Cannot reach database host ${hostname} (no usable address).`);
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedSecretRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is allowed; a migration name is validated below.
  }

  const filename = migrationName(body);
  if (!ALLOWED_MIGRATIONS.has(filename)) {
    return NextResponse.json({ error: "Migration not allowed" }, { status: 400 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 500 });
  }

  const filePath = path.join(process.cwd(), "supabase", "migrations", filename);
  let sql: string;
  try {
    sql = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return NextResponse.json({ error: "Migration file not found" }, { status: 500 });
  }

  try {
    const { tableName, host } = await runSql(connectionString, sql);
    return NextResponse.json({ ok: true, applied: filename, table: tableName, host });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
