import { createHash, createHmac } from "node:crypto";
export const ARTIFACT_BLOB_ACCESS = "private" as const;
export const ARTIFACT_BLOB_CONTRACT_VERSION = "worldcons-artifact-blob-v1";
export const ARTIFACT_BLOB_KEY_PREFIX = "artifacts";
export const ARTIFACT_BLOB_DEFAULT_CONTENT_TYPE = "application/json";
export const ARTIFACT_BLOB_MAX_BYTES = 4 * 1024 * 1024;

export const ARTIFACT_BLOB_PROVIDER_ENV = "ARTIFACT_BLOB_PROVIDER";
export const ARTIFACT_BLOB_BUCKET_ENV = "ARTIFACT_BLOB_BUCKET";
export const ARTIFACT_BLOB_PROVIDER_R2 = "r2" as const;
export const ARTIFACT_BLOB_BUCKET_DEFAULT = "worldcons-artifacts";
export const ARTIFACT_BLOB_R2_ACCOUNT_ID_ENV = "R2_ACCOUNT_ID";
export const ARTIFACT_BLOB_R2_ENDPOINT_ENV = "R2_ENDPOINT";
export const ARTIFACT_BLOB_R2_ACCESS_KEY_ID_ENV = "R2_ACCESS_KEY_ID";
export const ARTIFACT_BLOB_R2_SECRET_ACCESS_KEY_ENV = "R2_SECRET_ACCESS_KEY";
export const ARTIFACT_BLOB_R2_REGION_ENV = "R2_REGION";

export type ArtifactBlobKind = "fetch" | "normalization" | "article_raw";
export type ArtifactBlobProvider = typeof ARTIFACT_BLOB_PROVIDER_R2;

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

/** Cloudflare R2 is the sole artifact persistence authority. */
export function resolveArtifactBlobProvider(
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobProvider {
  const raw = environment[ARTIFACT_BLOB_PROVIDER_ENV]?.trim().toLowerCase();
  if (!raw || raw === ARTIFACT_BLOB_PROVIDER_R2) return ARTIFACT_BLOB_PROVIDER_R2;
  throw new Error("artifact_blob.invalid_provider");
}

export function resolveArtifactBlobBucket(
  environment: Record<string, string | undefined> = process.env,
): string {
  const raw = environment[ARTIFACT_BLOB_BUCKET_ENV]?.trim();
  const bucket = raw && raw.length > 0 ? raw : ARTIFACT_BLOB_BUCKET_DEFAULT;
  if (!BUCKET_PATTERN.test(bucket)) throw new Error("artifact_blob.invalid_bucket");
  return bucket;
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
  const bucket = options.bucket?.trim() || ARTIFACT_BLOB_BUCKET_DEFAULT;
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

export interface ArtifactBlobTransportDependencies {
  r2Binding?: ArtifactBlobR2Bucket;
  r2Transport?: (environment: Record<string, string | undefined>) => ArtifactBlobTransport;
}

export function createArtifactBlobTransport(
  environment: Record<string, string | undefined> = process.env,
  dependencies: ArtifactBlobTransportDependencies = {},
): ArtifactBlobTransport {
  resolveArtifactBlobProvider(environment);
  if (dependencies.r2Binding) return createR2BindingArtifactBlobTransport({ bucket: dependencies.r2Binding });
  return (dependencies.r2Transport ?? createR2S3TransportFromEnvironment)(environment);
}

export function createArtifactBlobStore(
  transport: ArtifactBlobTransport = createArtifactBlobTransport(),
): ArtifactBlobStore {
  return new ArtifactBlobStore(transport);
}
