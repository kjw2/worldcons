import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// Temporary one-shot migration runner. Removed after the migration is applied.
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  const sql = await fs.promises.readFile(
    path.join(process.cwd(), "supabase/migrations/20260829120000_admin_ops_watchdog.sql"),
    "utf8",
  );
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    await client.connect();
    await client.query(sql);
    const { rows } = await client.query("select to_regclass('public.admin_ops_events') as t");
    console.log(JSON.stringify({ applied: true, table: rows[0]?.t }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
