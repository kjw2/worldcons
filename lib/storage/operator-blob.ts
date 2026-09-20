import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ARTIFACT_BLOB_PROVIDER_ENV,
  ARTIFACT_BLOB_PROVIDER_R2,
  ArtifactBlobStore,
  createArtifactBlobStore,
  resolveArtifactBlobBucket,
  resolveArtifactBlobProvider,
  type ArtifactBlobTransport,
} from "@/lib/storage/blob";

export const ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV = "ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT";
export const ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_WRANGLER = "wrangler";
export const WORLDCONS_WRANGLER_BIN_ENV = "WORLDCONS_WRANGLER_BIN";

const execFileAsync = promisify(execFile);

export interface WranglerR2Runner {
  (args: string[]): Promise<void>;
}

export interface WranglerR2TransportOptions {
  bucket: string;
  runner?: WranglerR2Runner;
}

async function resolveWranglerBinary(
  environment: Record<string, string | undefined> = process.env,
) {
  const explicit = environment[WORLDCONS_WRANGLER_BIN_ENV]?.trim();
  if (explicit) {
    await access(explicit);
    return explicit;
  }
  if (process.platform === "win32") {
    const appData = environment.APPDATA?.trim();
    if (!appData) throw new Error("artifact_blob.r2_wrangler_not_configured");
    const globalShim = path.join(appData, "npm", "wrangler.cmd");
    await access(globalShim);
    return globalShim;
  }
  return "wrangler";
}

async function runWrangler(args: string[]) {
  try {
    const binary = await resolveWranglerBinary();
    if (process.platform === "win32") {
      await execFileAsync("cmd.exe", ["/d", "/c", binary, ...args], {
        cwd: process.cwd(),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    } else {
      await execFileAsync(binary, args, {
        cwd: process.cwd(),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  } catch {
    throw new Error("artifact_blob.r2_wrangler_command_failed");
  }
}

export { resolveWranglerBinary };

async function withTempFile<T>(name: string, fn: (file: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "worldcons-r2-"));
  const file = path.join(dir, name);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function objectPath(bucket: string, pathname: string) {
  return `${bucket}/${pathname}`;
}

export function createWranglerR2ArtifactBlobTransport(
  options: WranglerR2TransportOptions,
): ArtifactBlobTransport {
  if (typeof window !== "undefined") throw new Error("artifact_blob.server_only");
  const bucket = options.bucket.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)) throw new Error("artifact_blob.invalid_bucket");
  const runner = options.runner ?? runWrangler;
  const verifiedReads = new Map<string, Buffer>();

  function resultFromBytes(body: Buffer) {
    return {
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
      }),
      size: body.byteLength,
    };
  }

  return {
    async put(pathname, body, putOptions) {
      try {
        verifiedReads.delete(pathname);
        await withTempFile("put.json", async (file) => {
          await writeFile(file, body);
          await runner([
            "r2", "object", "put", objectPath(bucket, pathname),
            "--remote", "--file", file,
            "--content-type", putOptions.contentType,
            "--force",
          ]);
        });
        return { pathname };
      } catch {
        throw new Error("artifact_blob.r2_wrangler_put_failed");
      }
    },
    async get(pathname) {
      try {
        const cached = verifiedReads.get(pathname);
        if (cached) {
          verifiedReads.delete(pathname);
          return resultFromBytes(cached);
        }
        return await withTempFile("get.json", async (file) => {
          await runner([
            "r2", "object", "get", objectPath(bucket, pathname),
            "--remote", "--file", file,
          ]);
          const body = await readFile(file);
          return resultFromBytes(body);
        });
      } catch {
        throw new Error("artifact_blob.r2_wrangler_get_failed");
      }
    },
    async head(pathname) {
      try {
        return await withTempFile("head.json", async (file) => {
          await runner([
            "r2", "object", "get", objectPath(bucket, pathname),
            "--remote", "--file", file,
          ]);
          const body = await readFile(file);
          verifiedReads.set(pathname, body);
          return { pathname, size: body.byteLength };
        });
      } catch {
        throw new Error("artifact_blob.r2_wrangler_head_failed");
      }
    },
  };
}

export function createOperatorArtifactBlobStore(
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobStore {
  const provider = resolveArtifactBlobProvider(environment);
  const mode = environment[ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV]?.trim().toLowerCase();
  if (!mode) return createArtifactBlobStore();
  if (provider !== ARTIFACT_BLOB_PROVIDER_R2) {
    throw new Error("artifact_blob.r2_operator_requires_r2_provider");
  }
  if (mode !== ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_WRANGLER) {
    throw new Error("artifact_blob.invalid_r2_operator_transport");
  }
  return new ArtifactBlobStore(
    createWranglerR2ArtifactBlobTransport({ bucket: resolveArtifactBlobBucket(environment) }),
  );
}

export function r2WranglerOperatorModeEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return environment[ARTIFACT_BLOB_PROVIDER_ENV]?.trim().toLowerCase() === ARTIFACT_BLOB_PROVIDER_R2
    && environment[ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_ENV]?.trim().toLowerCase()
      === ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT_WRANGLER;
}
