import { NextResponse } from "next/server";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
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

  const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    await client.query(sql);
    const { rows } = await client.query("select to_regclass('public.admin_ops_events') as table_name");
    return NextResponse.json({ ok: true, applied: filename, table: rows[0]?.table_name });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
