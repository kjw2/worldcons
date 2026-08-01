import { getSupabaseAdmin } from "@/lib/db/client";
import { sha256Base64Url, type MasterdashAction } from "@/lib/masterdash/security";

export interface CollectionControlState {
  available: boolean;
  paused: boolean;
  updatedAt: string | null;
  lastRequestId: string | null;
  error?: string;
}

export class CollectionPausedError extends Error {
  readonly status = 423;

  constructor(message = "Collection is paused. Existing in-flight work was not interrupted.") {
    super(message);
    this.name = "CollectionPausedError";
  }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}

export async function consumeMasterdashJti(jti: string, expiresAtSeconds: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false as const, unavailable: true, error: "Supabase is not configured." };
  const now = new Date().toISOString();
  await supabase.from("masterdash_sso_jtis").delete().lt("expires_at", now);
  const { error } = await supabase.from("masterdash_sso_jtis").insert({
    jti_hash: sha256Base64Url(jti),
    system_id: "worldcons",
    expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
  });
  if (!error) return { ok: true as const };
  if (errorCode(error) === "23505") return { ok: false as const, replay: true, error: "MasterDash token was already used." };
  return { ok: false as const, unavailable: true, error: errorMessage(error) };
}

export async function getCollectionControlState(): Promise<CollectionControlState> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { available: false, paused: false, updatedAt: null, lastRequestId: null, error: "Supabase is not configured." };
  const { data, error } = await supabase
    .from("masterdash_collection_control")
    .select("paused, updated_at, last_request_id")
    .eq("system_id", "worldcons")
    .maybeSingle();
  if (error) return { available: false, paused: false, updatedAt: null, lastRequestId: null, error: error.message };
  return {
    available: true,
    paused: data?.paused === true,
    updatedAt: typeof data?.updated_at === "string" ? data.updated_at : null,
    lastRequestId: typeof data?.last_request_id === "string" ? data.last_request_id : null,
  };
}

export async function assertCollectionCanStart() {
  const state = await getCollectionControlState();
  if (!state.available) {
    if (process.env.MASTERDASH_CONTROL_SECRET?.trim()) {
      throw new Error("MasterDash collection control state is unavailable; refusing to start a new collection.");
    }
    return;
  }
  if (state.paused) throw new CollectionPausedError();
}

export async function setCollectionPaused(paused: boolean, requestId: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured for MasterDash collection control.");
  const { error } = await supabase.from("masterdash_collection_control").upsert(
    {
      system_id: "worldcons",
      paused,
      updated_at: new Date().toISOString(),
      last_request_id: requestId,
    },
    { onConflict: "system_id" },
  );
  if (error) throw new Error(error.message);
  return getCollectionControlState();
}

export interface ClaimedControlRequest {
  kind: "claimed" | "duplicate";
  status?: "processing" | "succeeded" | "failed";
  httpStatus?: number | null;
  message?: string | null;
}

export async function claimControlRequest(input: {
  requestId: string;
  action: MasterdashAction;
  requestedAt: string;
  bodyHash: string;
}): Promise<ClaimedControlRequest> {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured for MasterDash control requests.");
  const { error } = await supabase.from("masterdash_control_requests").insert({
    request_id: input.requestId,
    system_id: "worldcons",
    action: input.action,
    requested_at: input.requestedAt,
    body_sha256: input.bodyHash,
    status: "processing",
  });
  if (!error) return { kind: "claimed" };
  if (errorCode(error) !== "23505") throw new Error(error.message);

  const existing = await supabase
    .from("masterdash_control_requests")
    .select("action, requested_at, body_sha256, status, response_status, response_message")
    .eq("request_id", input.requestId)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error(existing.error?.message ?? "Existing control request could not be read.");
  if (
    existing.data.action !== input.action ||
    Date.parse(existing.data.requested_at) !== Date.parse(input.requestedAt) ||
    existing.data.body_sha256 !== input.bodyHash
  ) {
    throw new Error("requestId was already used for a different MasterDash control request.");
  }
  return {
    kind: "duplicate",
    status: existing.data.status as ClaimedControlRequest["status"],
    httpStatus: typeof existing.data.response_status === "number" ? existing.data.response_status : null,
    message: typeof existing.data.response_message === "string" ? existing.data.response_message : null,
  };
}

export async function completeControlRequest(requestId: string, status: "succeeded" | "failed", httpStatus: number, message: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured for MasterDash control requests.");
  const { error } = await supabase
    .from("masterdash_control_requests")
    .update({ status, response_status: httpStatus, response_message: message.slice(0, 500), completed_at: new Date().toISOString() })
    .eq("request_id", requestId);
  if (error) throw new Error(error.message);
}
