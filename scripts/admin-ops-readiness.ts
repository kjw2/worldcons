import "dotenv/config";
import { getSupabaseAdmin } from "@/lib/db/client";

interface ReadinessCheck {
  name: string;
  migration?: string;
  run: () => Promise<void>;
}

interface ReadinessResult {
  name: string;
  migration?: string;
  ok: boolean;
  detail?: string;
}

function errorMessage(error: unknown) {
  if (!error) return "Unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const parts = [record.code, record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    return parts.length ? parts.join(" | ") : JSON.stringify(record);
  }
  return String(error);
}

async function main() {
  const supabase = getSupabaseAdmin();
  const results: ReadinessResult[] = [];

  if (!supabase) {
    console.error("Admin ops readiness failed: Supabase admin client is not configured.");
    console.error("Check SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Secret values are not printed.");
    process.exitCode = 1;
    return;
  }
  const admin = supabase;

  async function head(table: string, columns = "id") {
    const { error } = await admin.from(table).select(columns, { head: true, count: "exact" }).limit(1);
    if (error) throw error;
  }

  async function rpc(functionName: string, args?: Record<string, unknown>) {
    const { error } = await admin.rpc(functionName, args);
    if (error) throw error;
  }

  const checks: ReadinessCheck[] = [
    {
      name: "dashboard summary view: admin_article_status_summary_v",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => head("admin_article_status_summary_v", "source_key,status,count,latest_updated_at"),
    },
    {
      name: "dashboard summary view: admin_source_health_v",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => head("admin_source_health_v", "source_key,total_count,pending_summary_count,attention_count,failed_count"),
    },
    {
      name: "dashboard summary view: admin_candidate_summary_v",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => head("admin_candidate_summary_v", "source_key,pending_count,retrying_count,failed_count"),
    },
    {
      name: "dashboard summary view: admin_attention_articles_v",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => head("admin_attention_articles_v", "id,slug,source_key,status"),
    },
    {
      name: "dashboard summary RPC: rpc_admin_dashboard_snapshot",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => rpc("rpc_admin_dashboard_snapshot"),
    },
    {
      name: "analytics health RPC: rpc_admin_analytics_health_snapshot",
      migration: "supabase/migrations/20260709120000_admin_dashboard_summary_views.sql",
      run: () => rpc("rpc_admin_analytics_health_snapshot", { days: 1 }),
    },
    {
      name: "admin audit table: admin_audit_logs",
      migration: "supabase/migrations/20260709130000_admin_audit_and_edit_history.sql",
      run: () => head("admin_audit_logs", "id,occurred_at,action,redacted_metadata"),
    },
    {
      name: "admin edit history table: admin_article_edit_history",
      migration: "supabase/migrations/20260709130000_admin_audit_and_edit_history.sql",
      run: () => head("admin_article_edit_history", "id,article_id,edited_at,changed_fields"),
    },
    {
      name: "article triage columns: articles.error_class/error_context/review_state",
      migration: "supabase/migrations/20260709140000_admin_article_triage_columns.sql",
      run: () => head("articles", "id,error_class,error_context,review_state"),
    },
    {
      name: "admin job table: admin_jobs",
      migration: "supabase/migrations/20260709150000_admin_jobs.sql",
      run: () => head("admin_jobs", "id,job_type,status,idempotency_key"),
    },
    {
      name: "admin job event table: admin_job_events",
      migration: "supabase/migrations/20260709150000_admin_jobs.sql",
      run: () => head("admin_job_events", "id,job_id,event_type,metadata"),
    },
    {
      name: "admin job claim RPC: claim_admin_job",
      migration: "supabase/migrations/20260709150000_admin_jobs.sql",
      run: async () => {
        const { error } = await admin.rpc("claim_admin_job", {
          worker_id: "admin-readiness",
          job_types: ["__readiness_never_claim__"],
          lease_seconds: 1,
        });
        if (error) throw error;
      },
    },
  ];

  for (const check of checks) {
    try {
      await check.run();
      results.push({ name: check.name, migration: check.migration, ok: true });
    } catch (error) {
      results.push({ name: check.name, migration: check.migration, ok: false, detail: errorMessage(error) });
    }
  }

  console.log("Admin ops readiness");
  for (const result of results) {
    console.log(`${result.ok ? "OK" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    const missingMigrations = Array.from(new Set(failed.map((result) => result.migration).filter((value): value is string => Boolean(value))));
    console.error("\nReadiness failed. Apply the missing additive migrations before relying on production admin queue operations:");
    for (const migration of missingMigrations) {
      console.error(`- ${migration}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nReadiness passed. Admin v2 P0-P2 database objects are reachable.");
}

main().catch((error) => {
  console.error(`Admin ops readiness failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
