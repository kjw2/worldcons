import { getRuntimeD1Binding, type D1RuntimeDatabase, type D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";
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

function opsBinding(): D1RuntimeDatabase | null {
  return getRuntimeD1Binding("worldcons_ops");
}

function resultOk(result: D1RuntimeResult) {
  return result.success !== false && !result.error;
}

function resultChanges(result: D1RuntimeResult) {
  return Number(result.meta?.changes ?? 0);
}

async function runD1(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("MasterDash D1 write is unavailable.");
  const result = await statement.run();
  if (!resultOk(result)) throw new Error(result.error || "MasterDash D1 write failed.");
  return result;
}

async function rowsD1<T extends Record<string, unknown>>(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await binding.prepare(sql).bind(...values).all<T>();
  if (!resultOk(result)) throw new Error(result.error || "MasterDash D1 read failed.");
  return result.results ?? [];
}

export async function consumeMasterdashJti(jti: string, expiresAtSeconds: number) {
  const binding = opsBinding();
  if (!binding) return { ok: false as const, unavailable: true, error: "worldcons_ops D1 is not configured." };

  const now = new Date().toISOString();
  const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
  const jtiHash = sha256Base64Url(jti);

  try {
    await runD1(binding, "DELETE FROM masterdash_sso_jtis WHERE expires_at < ?", [now]);
    const inserted = await runD1(
      binding,
      "INSERT OR IGNORE INTO masterdash_sso_jtis (jti_hash, system_id, expires_at, created_at) VALUES (?, 'worldcons', ?, ?)",
      [jtiHash, expiresAt, now],
    );
    if (resultChanges(inserted) === 1) return { ok: true as const };
    if (resultChanges(inserted) === 0) return { ok: false as const, replay: true, error: "MasterDash token was already used." };
    return { ok: false as const, unavailable: true, error: "Unexpected MasterDash JTI write result." };
  } catch (error) {
    return { ok: false as const, unavailable: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getCollectionControlState(): Promise<CollectionControlState> {
  const binding = opsBinding();
  if (!binding) return { available: false, paused: false, updatedAt: null, lastRequestId: null, error: "worldcons_ops D1 is not configured." };

  try {
    const [row] = await rowsD1<{
      paused?: number | boolean;
      updated_at?: string | null;
      last_request_id?: string | null;
    }>(binding, "SELECT paused, updated_at, last_request_id FROM masterdash_collection_control WHERE system_id = 'worldcons' LIMIT 1");
    return {
      available: true,
      paused: row?.paused === true || row?.paused === 1,
      updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null,
      lastRequestId: typeof row?.last_request_id === "string" ? row.last_request_id : null,
    };
  } catch (error) {
    return { available: false, paused: false, updatedAt: null, lastRequestId: null, error: error instanceof Error ? error.message : String(error) };
  }
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
  const binding = opsBinding();
  if (!binding) throw new Error("worldcons_ops D1 is not configured for MasterDash collection control.");
  const now = new Date().toISOString();
  await runD1(
    binding,
    [
      "INSERT INTO masterdash_collection_control (system_id, paused, updated_at, last_request_id)",
      "VALUES ('worldcons', ?, ?, ?)",
      "ON CONFLICT(system_id) DO UPDATE SET",
      "paused = excluded.paused, updated_at = excluded.updated_at, last_request_id = excluded.last_request_id",
    ].join(" "),
    [paused ? 1 : 0, now, requestId],
  );
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
  const binding = opsBinding();
  if (!binding) throw new Error("worldcons_ops D1 is not configured for MasterDash control requests.");

  const createdAt = new Date().toISOString();
  const inserted = await runD1(
    binding,
    [
      "INSERT OR IGNORE INTO masterdash_control_requests",
      "(request_id, system_id, action, requested_at, body_sha256, status, created_at)",
      "VALUES (?, 'worldcons', ?, ?, ?, 'processing', ?)",
    ].join(" "),
    [input.requestId, input.action, input.requestedAt, input.bodyHash, createdAt],
  );
  if (resultChanges(inserted) === 1) return { kind: "claimed" };

  const [existing] = await rowsD1<{
    action?: string;
    requested_at?: string;
    body_sha256?: string;
    status?: string;
    response_status?: number | null;
    response_message?: string | null;
  }>(
    binding,
    "SELECT action, requested_at, body_sha256, status, response_status, response_message FROM masterdash_control_requests WHERE request_id = ? LIMIT 1",
    [input.requestId],
  );
  if (!existing) throw new Error("Existing control request could not be read.");
  if (
    existing.action !== input.action ||
    typeof existing.requested_at !== "string" ||
    Date.parse(existing.requested_at) !== Date.parse(input.requestedAt) ||
    existing.body_sha256 !== input.bodyHash
  ) {
    throw new Error("requestId was already used for a different MasterDash control request.");
  }
  return {
    kind: "duplicate",
    status: existing.status as ClaimedControlRequest["status"],
    httpStatus: typeof existing.response_status === "number" ? existing.response_status : null,
    message: typeof existing.response_message === "string" ? existing.response_message : null,
  };
}

export async function completeControlRequest(requestId: string, status: "succeeded" | "failed", httpStatus: number, message: string) {
  const binding = opsBinding();
  if (!binding) throw new Error("worldcons_ops D1 is not configured for MasterDash control requests.");
  await runD1(
    binding,
    "UPDATE masterdash_control_requests SET status = ?, response_status = ?, response_message = ?, completed_at = ? WHERE request_id = ?",
    [status, httpStatus, message.slice(0, 500), new Date().toISOString(), requestId],
  );
}
