export type WorldconsRuntimePlatform = "cloudflare-worker";

interface WorldconsRuntimeGlobal {
  __worldconsRuntimePlatformV1?: WorldconsRuntimePlatform;
}

function runtimeGlobal(): typeof globalThis & WorldconsRuntimeGlobal {
  return globalThis as typeof globalThis & WorldconsRuntimeGlobal;
}

export function setRuntimePlatform(platform: WorldconsRuntimePlatform | null): void {
  const target = runtimeGlobal();
  if (platform) target.__worldconsRuntimePlatformV1 = platform;
  else delete target.__worldconsRuntimePlatformV1;
}

export function runtimePlatform(): WorldconsRuntimePlatform | "node" {
  return runtimeGlobal().__worldconsRuntimePlatformV1 ?? "node";
}

export function isCloudflareWorkerRuntime(): boolean {
  return runtimePlatform() === "cloudflare-worker";
}
