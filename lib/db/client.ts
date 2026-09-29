import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase was retired from the WorldCons runtime during the M13 Cloudflare
 * cutover. Keep this compatibility seam so legacy modules fail closed instead
 * of reconnecting to Supabase when old environment variables happen to exist.
 *
 * Historical migration/rollback source may still import these helpers, but
 * WorldCons no longer creates a Supabase client or reads Supabase credentials.
 */
export function hasSupabaseConfig(): false {
  return false;
}

export function getSupabaseAdmin(): SupabaseClient | null {
  return null;
}

export function getSupabaseServiceRoleAdmin(): SupabaseClient | null {
  return null;
}
