import { createHash } from "node:crypto";
import { get as vercelGet, head as vercelHead, put as vercelPut } from "@vercel/blob";

export const ARTIFACT_BLOB_ACCESS = "private" as const;
export const ARTIFACT_BLOB_CONTRACT_VERSION = "worldcons-artifact-blob-v1";
export const ARTIFACT_BLOB_KEY_PREFIX = "artifacts";
export const ARTIFACT_BLOB_DEFAULT_CONTENT_TYPE = "application/json";
export const ARTIFACT_BLOB_MAX_BYTES = 4 * 1024 * 1024;

export type ArtifactBlobKind = "fetch" | "normalization" | "article_raw";

const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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
      const result = await vercelHead(pathname);
      return { pathname: result.pathname, size: result.size };
    },
  };
}

export function createArtifactBlobStore(
  transport: ArtifactBlobTransport = createVercelArtifactBlobTransport(),
): ArtifactBlobStore {
  return new ArtifactBlobStore(transport);
}
