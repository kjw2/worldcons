import { createHash, createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BlobNotFoundError,
  get as vercelGet,
  head as vercelHead,
  put as vercelPut,
} from "@vercel/blob";

export const ARTIFACT_BLOB_ACCESS = "private" as const;
export const ARTIFACT_BLOB_CONTRACT_VERSION = "worldcons-artifact-blob-v1";
export const ARTIFACT_BLOB_KEY_PREFIX = "artifacts";
export const ARTIFACT_BLOB_DEFAULT_CONTENT_TYPE = "application/json";
export const ARTIFACT_BLOB_MAX_BYTES = 4 * 1024 * 1024;

export const ARTIFACT_BLOB_PROVIDER_ENV = "ARTIFACT_BLOB_PROVIDER";
export const ARTIFACT_BLOB_BUCKET_ENV = "ARTIFACT_BLOB_BUCKET";
export const ARTIFACT_BLOB_READ_FALLBACK_ENV = "ARTIFACT_BLOB_READ_FALLBACK_ENABLED";
export const ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV = "ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS";
export const ARTIFACT_BLOB_PROVIDER_VERCEL = "vercel" as const;
export const ARTIFACT_BLOB_PROVIDER_SUPABASE = "supabase" as const;
export const ARTIFACT_BLOB_PROVIDER_R2 = "r2" as const;
export const ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT = "worldcons-artifacts";
export const ARTIFACT_BLOB_R2_ACCOUNT_ID_ENV = "R2_ACCOUNT_ID";
export const ARTIFACT_BLOB_R2_ENDPOINT_ENV = "R2_ENDPOINT";
export const ARTIFACT_BLOB_R2_ACCESS_KEY_ID_ENV = "R2_ACCESS_KEY_ID";
export const ARTIFACT_BLOB_R2_SECRET_ACCESS_KEY_ENV = "R2_SECRET_ACCESS_KEY";
export const ARTIFACT_BLOB_R2_REGION_ENV = "R2_REGION";

export type ArtifactBlobKind = "fetch" | "normalization" | "article_raw";
export type ArtifactBlobProvider =
  | typeof ARTIFACT_BLOB_PROVIDER_VERCEL
  | typeof ARTIFACT_BLOB_PROVIDER_SUPABASE
  | typeof ARTIFACT_BLOB_PROVIDER_R2;

const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SECRET_PATTERN = /(token|secret|signature|credential)/i;
const ARTIFACT_REF_PATTERN =
  /^artifacts\/(fetch|normalization|article_raw)\/[a-z][a-z0-9._-]{0,79}\/[0-9a-f]{64}\.json$/;

export interface ArtifactBlobUploadInput {
  kind: ArtifactBlobKind;
  sourceKey: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface ArtifactBlobStorageRef {
  storageRef: string;
  sha256: string;
  size: number;
  contentType: string;
  contractVersion: string;
}

export interface ArtifactBlobPutOptions {
  access: "private";
  addRandomSuffix: boolean;
  allowOverwrite: boolean;
  contentType: string;
}

export interface ArtifactBlobGetOptions {
  access: "private";
  useCache: boolean;
}

export interface ArtifactBlobPutResult {
  pathname: string;
}

export interface ArtifactBlobGetResult {
  statusCode: number;
  stream: ReadableStream<Uint8Array> | null;
  size: number | null;
}

export interface ArtifactBlobHeadResult {
  pathname: string;
  size: number;
}

export interface ArtifactBlobTransport {
  put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions): Promise<ArtifactBlobPutResult>;
  get(pathname: string, options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null>;
  head(pathname: string): Promise<ArtifactBlobHeadResult>;
}

/**
 * Minimal structural slice of `@supabase/supabase-js` storage that the artifact
 * transport needs. Keeping it structural lets tests inject a fake client while the
 * server-only factory below supplies the real service-role client.
 */
export interface ArtifactBlobSupabaseBucket {
  upload(
    pathname: string,
    body: Buffer,
    options: { contentType: string; upsert: boolean },
  ): Promise<{ data: { path: string } | null; error: unknown }>;
  download(pathname: string): PromiseLike<{ data: Blob | null; error: unknown }>;
  info(pathname: string): Promise<{ data: { size?: number } | null; error: unknown }>;
}

export interface ArtifactBlobSupabaseClient {
  storage: {
    from(bucket: string): ArtifactBlobSupabaseBucket;
  };
}

export interface ArtifactBlobR2Object {
  size: number;
}

export interface ArtifactBlobR2ObjectBody extends ArtifactBlobR2Object {
  body: ReadableStream<Uint8Array>;
}

export interface ArtifactBlobR2Bucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<ArtifactBlobR2ObjectBody | null>;
  head(key: string): Promise<ArtifactBlobR2Object | null>;
}

export type ArtifactBlobSignedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function sha256HexRaw(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildArtifactStorageRef(kind: ArtifactBlobKind, sourceKey: string, sha256: string): string {
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) throw new Error("artifact_blob.invalid_source_key");
  if (!SHA256_PATTERN.test(sha256)) throw new Error("artifact_blob.invalid_sha256");
  const storageRef = `${ARTIFACT_BLOB_KEY_PREFIX}/${kind}/${sourceKey}/${sha256}.json`;
  if (SECRET_PATTERN.test(storageRef)) throw new Error("artifact_blob.insecure_ref");
  return storageRef;
}

export function isArtifactStorageRef(value: string): boolean {
  return ARTIFACT_REF_PATTERN.test(value) && !SECRET_PATTERN.test(value);
}

async function readArtifactBlobStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export class ArtifactBlobStore {
  constructor(private readonly transport: ArtifactBlobTransport) {}

  async put(input: ArtifactBlobUploadInput): Promise<ArtifactBlobStorageRef> {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    if (bytes.byteLength > ARTIFACT_BLOB_MAX_BYTES) throw new Error("artifact_blob.payload_too_large");
    const sha256 = sha256Hex(bytes);
    const storageRef = buildArtifactStorageRef(input.kind, input.sourceKey, sha256);
    const contentType = input.contentType ?? ARTIFACT_BLOB_DEFAULT_CONTENT_TYPE;
    const uploaded = await this.transport.put(storageRef, bytes, {
      access: ARTIFACT_BLOB_ACCESS,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
    if (!uploaded || uploaded.pathname !== storageRef) throw new Error("artifact_blob.pathname_mismatch");
    return { storageRef, sha256, size: bytes.byteLength, contentType, contractVersion: ARTIFACT_BLOB_CONTRACT_VERSION };
  }

  async get(storageRef: string): Promise<Buffer> {
    if (!isArtifactStorageRef(storageRef)) throw new Error("artifact_blob.invalid_ref");
    const result = await this.transport.get(storageRef, { access: ARTIFACT_BLOB_ACCESS, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("artifact_blob.not_found");
    return readArtifactBlobStream(result.stream);
  }

  async head(storageRef: string): Promise<{ size: number }> {
    if (!isArtifactStorageRef(storageRef)) throw new Error("artifact_blob.invalid_ref");
    const result = await this.transport.head(storageRef);
    if (!result || result.pathname !== storageRef) throw new Error("artifact_blob.not_found");
    return { size: result.size };
  }
}

function missingHeadResult(pathname: string): ArtifactBlobHeadResult {
  return { pathname: `${pathname}.missing`, size: 0 };
}

function isArtifactBlobHeadHit(result: ArtifactBlobHeadResult | null | undefined, pathname: string): boolean {
  return result !== null && result !== undefined && result.pathname === pathname;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const field of ["status", "statusCode", "httpStatusCode"]) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * True only for a genuine "this object does not exist" signal. Auth, bucket
 * configuration, provider, and network failures are deliberately excluded so the
 * read fallback never masks an operational error.
 */
export function isSupabaseObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim().toLowerCase() : "";
  const code = typeof record.code === "string" ? record.code.trim().toLowerCase() : "";
  if (message !== "object not found" && code !== "object_not_found" && code !== "objectnotfound") return false;
  const status = errorStatus(error);
  return status === null || status === 404;
}

function isVercelBlobNotFound(error: unknown): boolean {
  if (error instanceof BlobNotFoundError) return true;
  return (error as { name?: unknown })?.name === "BlobNotFoundError";
}

/**
 * Primary artifact transport selection. Vercel stays the default so existing
 * deployments are unchanged; Supabase is used only when `ARTIFACT_BLOB_PROVIDER`
 * explicitly selects it. When primary is Supabase and the read fallback is enabled,
 * `get`/`head` try Supabase first and fall through to Vercel only on not-found.
 */
export function resolveArtifactBlobProvider(
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobProvider {
  const raw = environment[ARTIFACT_BLOB_PROVIDER_ENV]?.trim().toLowerCase();
  if (!raw || raw === ARTIFACT_BLOB_PROVIDER_VERCEL) return ARTIFACT_BLOB_PROVIDER_VERCEL;
  if (raw === ARTIFACT_BLOB_PROVIDER_SUPABASE) return ARTIFACT_BLOB_PROVIDER_SUPABASE;
  if (raw === ARTIFACT_BLOB_PROVIDER_R2) return ARTIFACT_BLOB_PROVIDER_R2;
  throw new Error("artifact_blob.invalid_provider");
}

export function artifactBlobReadFallbackEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return explicitTrue(environment[ARTIFACT_BLOB_READ_FALLBACK_ENV]);
}

function parseArtifactBlobProvider(value: string, errorCode: string): ArtifactBlobProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === ARTIFACT_BLOB_PROVIDER_VERCEL) return ARTIFACT_BLOB_PROVIDER_VERCEL;
  if (normalized === ARTIFACT_BLOB_PROVIDER_SUPABASE) return ARTIFACT_BLOB_PROVIDER_SUPABASE;
  if (normalized === ARTIFACT_BLOB_PROVIDER_R2) return ARTIFACT_BLOB_PROVIDER_R2;
  throw new Error(errorCode);
}

export function resolveArtifactBlobFallbackProviders(
  environment: Record<string, string | undefined> = process.env,
  primary: ArtifactBlobProvider = resolveArtifactBlobProvider(environment),
): ArtifactBlobProvider[] {
  const raw = environment[ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]?.trim();
  const providers = raw
    ? raw.split(",").map((value) => parseArtifactBlobProvider(value, "artifact_blob.invalid_fallback_provider"))
    : artifactBlobReadFallbackEnabled(environment) && primary !== ARTIFACT_BLOB_PROVIDER_VERCEL
      ? [ARTIFACT_BLOB_PROVIDER_VERCEL]
      : [];
  const seen = new Set<ArtifactBlobProvider>();
  for (const provider of providers) {
    if (provider === primary || seen.has(provider)) throw new Error("artifact_blob.invalid_fallback");
    seen.add(provider);
  }
  return providers;
}

export function resolveArtifactBlobBucket(
  environment: Record<string, string | undefined> = process.env,
): string {
  const raw = environment[ARTIFACT_BLOB_BUCKET_ENV]?.trim();
  const bucket = raw && raw.length > 0 ? raw : ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT;
  if (!BUCKET_PATTERN.test(bucket)) throw new Error("artifact_blob.invalid_bucket");
  return bucket;
}

function createSupabaseServiceRoleClient(
  environment: Record<string, string | undefined> = process.env,
): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  const url = (environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = (environment.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("artifact_blob.supabase_not_configured");
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function createVercelArtifactBlobTransport(): ArtifactBlobTransport {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  return {
    async put(pathname, body, options) {
      const result = await vercelPut(pathname, body, options);
      return { pathname: result.pathname };
    },
    async get(pathname, options) {
      const result = await vercelGet(pathname, options);
      if (!result) return null;
      return {
        statusCode: result.statusCode,
        stream: result.stream,
        size: result.statusCode === 200 ? result.blob.size : null,
      };
    },
    async head(pathname) {
      try {
        const result = await vercelHead(pathname);
        return { pathname: result.pathname, size: result.size };
      } catch (error) {
        if (isVercelBlobNotFound(error)) return missingHeadResult(pathname);
        throw error;
      }
    },
  };
}

export interface SupabaseArtifactBlobTransportOptions {
  client: ArtifactBlobSupabaseClient;
  bucket?: string;
}

export function createSupabaseArtifactBlobTransport(
  options: SupabaseArtifactBlobTransportOptions,
): ArtifactBlobTransport {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  const bucket = options.bucket?.trim() && options.bucket.trim().length > 0
    ? options.bucket.trim()
    : ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT;
  if (!BUCKET_PATTERN.test(bucket)) throw new Error("artifact_blob.invalid_bucket");
  const objects = options.client.storage.from(bucket);

  return {
    async put(pathname, body, putOptions) {
      let uploaded: { data: { path: string } | null; error: unknown };
      try {
        uploaded = await objects.upload(pathname, body, {
          contentType: putOptions.contentType,
          upsert: true,
        });
      } catch {
        throw new Error("artifact_blob.supabase_put_failed");
      }
      if (uploaded.error) throw new Error("artifact_blob.supabase_put_failed");
      if (!uploaded.data || typeof uploaded.data.path !== "string") {
        throw new Error("artifact_blob.supabase_put_failed");
      }
      return { pathname: uploaded.data.path };
    },
    async get(pathname) {
      let downloaded: { data: Blob | null; error: unknown };
      try {
        downloaded = await objects.download(pathname);
      } catch {
        throw new Error("artifact_blob.supabase_get_failed");
      }
      if (downloaded.error) {
        if (isSupabaseObjectNotFound(downloaded.error)) return null;
        throw new Error("artifact_blob.supabase_get_failed");
      }
      if (!downloaded.data) return null;
      return {
        statusCode: 200,
        stream: downloaded.data.stream() as ReadableStream<Uint8Array>,
        size: downloaded.data.size,
      };
    },
    async head(pathname) {
      let info: { data: { size?: number } | null; error: unknown };
      try {
        info = await objects.info(pathname);
      } catch {
        throw new Error("artifact_blob.supabase_head_failed");
      }
      if (info.error) {
        if (isSupabaseObjectNotFound(info.error)) return missingHeadResult(pathname);
        throw new Error("artifact_blob.supabase_head_failed");
      }
      const size = info.data?.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return missingHeadResult(pathname);
      return { pathname, size };
    },
  };
}

export interface R2BindingArtifactBlobTransportOptions {
  bucket: ArtifactBlobR2Bucket;
}

export function createR2BindingArtifactBlobTransport(
  options: R2BindingArtifactBlobTransportOptions,
): ArtifactBlobTransport {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  return {
    async put(pathname, body, putOptions) {
      try {
        await options.bucket.put(pathname, body, {
          httpMetadata: { contentType: putOptions.contentType },
        });
        return { pathname };
      } catch {
        throw new Error("artifact_blob.r2_put_failed");
      }
    },
    async get(pathname) {
      try {
        const object = await options.bucket.get(pathname);
        if (!object) return null;
        return { statusCode: 200, stream: object.body, size: object.size };
      } catch {
        throw new Error("artifact_blob.r2_get_failed");
      }
    },
    async head(pathname) {
      try {
        const object = await options.bucket.head(pathname);
        if (!object) return missingHeadResult(pathname);
        return { pathname, size: object.size };
      } catch {
        throw new Error("artifact_blob.r2_head_failed");
      }
    },
  };
}

export interface R2S3ArtifactBlobTransportOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket?: string;
  region?: string;
  signedFetch?: ArtifactBlobSignedFetch;
}

function normalizeR2Endpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("artifact_blob.r2_not_configured");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("artifact_blob.r2_not_configured");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

function r2ObjectUrl(endpoint: URL, bucket: string, pathname: string): URL {
  const url = new URL(endpoint);
  const encodedKey = pathname.split("/").map(encodeURIComponent).join("/");
  const base = endpoint.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${encodeURIComponent(bucket)}/${encodedKey}`;
  return url;
}

async function r2ErrorCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const xml = text.match(/<Code>\s*([^<]+?)\s*<\/Code>/i)?.[1]?.trim();
    if (xml) return xml;
    const json = JSON.parse(text) as { Code?: unknown; code?: unknown };
    const code = typeof json.Code === "string" ? json.Code : typeof json.code === "string" ? json.code : null;
    return code?.trim() || null;
  } catch {
    return null;
  }
}

function isR2ObjectNotFoundCode(code: string | null): boolean {
  return code === "NoSuchKey" || code === "NoSuchObject" || code === "ObjectNotFound";
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function createR2SignedFetch(options: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}): ArtifactBlobSignedFetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const now = new Date();
    const timestamp = amzDate(now);
    const dateStamp = timestamp.slice(0, 8);
    const body = init.body;
    let payloadBytes: Uint8Array;
    if (body === undefined || body === null) payloadBytes = new Uint8Array();
    else if (typeof body === "string") payloadBytes = Buffer.from(body);
    else if (body instanceof Uint8Array) payloadBytes = body;
    else if (body instanceof ArrayBuffer) payloadBytes = new Uint8Array(body);
    else throw new Error("artifact_blob.r2_unsupported_body");

    const payloadHash = sha256HexRaw(payloadBytes);
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", timestamp);
    const signedHeaderNames = ["host", "x-amz-content-sha256", "x-amz-date"];
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers.get(name)?.trim() ?? ""}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname || "/",
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaderNames.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      sha256HexRaw(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, options.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    );
    return fetch(url, { ...init, method, headers, body });
  };
}

export function createR2S3ArtifactBlobTransport(
  options: R2S3ArtifactBlobTransportOptions,
): ArtifactBlobTransport {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  const bucket = options.bucket?.trim() || ARTIFACT_BLOB_SUPABASE_BUCKET_DEFAULT;
  if (!BUCKET_PATTERN.test(bucket)) throw new Error("artifact_blob.invalid_bucket");
  if (!options.accessKeyId.trim() || !options.secretAccessKey.trim()) {
    throw new Error("artifact_blob.r2_not_configured");
  }
  const endpoint = normalizeR2Endpoint(options.endpoint.trim());
  const signedFetch = options.signedFetch ?? createR2SignedFetch({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region?.trim() || "auto",
  });

  return {
    async put(pathname, body, putOptions) {
      try {
        const response = await signedFetch(r2ObjectUrl(endpoint, bucket, pathname), {
          method: "PUT",
          headers: { "content-type": putOptions.contentType },
          body: body as unknown as BodyInit,
        });
        if (!response.ok) throw new Error("r2_put_http_error");
        return { pathname };
      } catch {
        throw new Error("artifact_blob.r2_put_failed");
      }
    },
    async get(pathname) {
      try {
        const response = await signedFetch(r2ObjectUrl(endpoint, bucket, pathname), { method: "GET" });
        if (response.status === 404) {
          const code = await r2ErrorCode(response);
          if (isR2ObjectNotFoundCode(code)) return null;
          throw new Error("r2_get_ambiguous_404");
        }
        if (!response.ok || !response.body) throw new Error("r2_get_http_error");
        return { statusCode: 200, stream: response.body, size: contentLength(response) };
      } catch {
        throw new Error("artifact_blob.r2_get_failed");
      }
    },
    async head(pathname) {
      const url = r2ObjectUrl(endpoint, bucket, pathname);
      try {
        const response = await signedFetch(url, { method: "HEAD" });
        if (response.status === 404) {
          // S3 HEAD does not reliably return an error body. Probe a one-byte GET so
          // NoSuchKey can be distinguished from NoSuchBucket/auth/provider failures.
          const probe = await signedFetch(url, { method: "GET", headers: { range: "bytes=0-0" } });
          if (probe.status === 404) {
            const code = await r2ErrorCode(probe);
            if (isR2ObjectNotFoundCode(code)) return missingHeadResult(pathname);
          }
          throw new Error("r2_head_ambiguous_404");
        }
        if (!response.ok) throw new Error("r2_head_http_error");
        const size = contentLength(response);
        if (size === null) throw new Error("r2_head_missing_length");
        return { pathname, size };
      } catch {
        throw new Error("artifact_blob.r2_head_failed");
      }
    },
  };
}

function createR2S3TransportFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobTransport {
  const endpoint = environment[ARTIFACT_BLOB_R2_ENDPOINT_ENV]?.trim()
    || (environment[ARTIFACT_BLOB_R2_ACCOUNT_ID_ENV]?.trim()
      ? `https://${environment[ARTIFACT_BLOB_R2_ACCOUNT_ID_ENV]!.trim()}.r2.cloudflarestorage.com`
      : "");
  const accessKeyId = environment[ARTIFACT_BLOB_R2_ACCESS_KEY_ID_ENV]?.trim() || "";
  const secretAccessKey = environment[ARTIFACT_BLOB_R2_SECRET_ACCESS_KEY_ENV]?.trim() || "";
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("artifact_blob.r2_not_configured");
  return createR2S3ArtifactBlobTransport({
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: environment[ARTIFACT_BLOB_R2_REGION_ENV]?.trim() || "auto",
    bucket: resolveArtifactBlobBucket(environment),
  });
}

/**
 * Wraps a primary transport with read-only fallbacks. Writes go only to the
 * primary; `get`/`head` consult fallbacks in order only when the preceding
 * provider reports
 * not-found, so operational errors surface unchanged.
 */
export function createArtifactBlobFallbackTransport(options: {
  primary: ArtifactBlobTransport;
  fallback?: ArtifactBlobTransport;
  fallbacks?: ArtifactBlobTransport[];
}): ArtifactBlobTransport {
  const { primary } = options;
  const fallbacks = options.fallbacks ?? (options.fallback ? [options.fallback] : []);
  return {
    async put(pathname, body, putOptions) {
      return primary.put(pathname, body, putOptions);
    },
    async get(pathname, getOptions) {
      let result = await primary.get(pathname, getOptions);
      if (result) return result;
      for (const fallback of fallbacks) {
        result = await fallback.get(pathname, getOptions);
        if (result) return result;
      }
      return null;
    },
    async head(pathname) {
      let result = await primary.head(pathname);
      if (isArtifactBlobHeadHit(result, pathname)) return result;
      for (const fallback of fallbacks) {
        result = await fallback.head(pathname);
        if (isArtifactBlobHeadHit(result, pathname)) return result;
      }
      return result;
    },
  };
}

export interface ArtifactBlobTransportDependencies {
  vercelTransport?: () => ArtifactBlobTransport;
  supabaseClient?: (environment: Record<string, string | undefined>) => ArtifactBlobSupabaseClient;
  r2Binding?: ArtifactBlobR2Bucket;
  r2Transport?: (environment: Record<string, string | undefined>) => ArtifactBlobTransport;
}

function createProviderTransport(
  provider: ArtifactBlobProvider,
  environment: Record<string, string | undefined>,
  dependencies: ArtifactBlobTransportDependencies,
): ArtifactBlobTransport {
  if (provider === ARTIFACT_BLOB_PROVIDER_VERCEL) {
    return (dependencies.vercelTransport ?? createVercelArtifactBlobTransport)();
  }
  if (provider === ARTIFACT_BLOB_PROVIDER_SUPABASE) {
    const client = (dependencies.supabaseClient ?? createSupabaseServiceRoleClient)(environment);
    return createSupabaseArtifactBlobTransport({
      client,
      bucket: resolveArtifactBlobBucket(environment),
    });
  }
  if (dependencies.r2Binding) return createR2BindingArtifactBlobTransport({ bucket: dependencies.r2Binding });
  return (dependencies.r2Transport ?? createR2S3TransportFromEnvironment)(environment);
}

export function createArtifactBlobTransport(
  environment: Record<string, string | undefined> = process.env,
  dependencies: ArtifactBlobTransportDependencies = {},
): ArtifactBlobTransport {
  const provider = resolveArtifactBlobProvider(environment);
  const primary = createProviderTransport(provider, environment, dependencies);
  const fallbackProviders = resolveArtifactBlobFallbackProviders(environment, provider);
  if (fallbackProviders.length === 0) return primary;
  const fallbacks = fallbackProviders.map((fallbackProvider) =>
    createProviderTransport(fallbackProvider, environment, dependencies)
  );
  return createArtifactBlobFallbackTransport({ primary, fallbacks });
}

export function createArtifactBlobStore(
  transport: ArtifactBlobTransport = createArtifactBlobTransport(),
): ArtifactBlobStore {
  return new ArtifactBlobStore(transport);
}
