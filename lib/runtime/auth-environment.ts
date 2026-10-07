export interface RuntimeAuthEnvironment {
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  CRON_SECRET?: string;
  WORLDCONS_PORTAL_TOKEN?: string;
  MASTERDASH_ADMIN_IDENTITIES?: string;
}

interface AuthEnvironmentGlobal {
  __worldconsAuthEnvironmentV1?: RuntimeAuthEnvironment;
}

function runtimeGlobal(): typeof globalThis & AuthEnvironmentGlobal {
  return globalThis as typeof globalThis & AuthEnvironmentGlobal;
}

export function setRuntimeAuthEnvironment(environment: RuntimeAuthEnvironment): void {
  runtimeGlobal().__worldconsAuthEnvironmentV1 = { ...environment };
}

export function getRuntimeAuthEnvironment(): RuntimeAuthEnvironment | null {
  return runtimeGlobal().__worldconsAuthEnvironmentV1 ?? null;
}

export function clearRuntimeAuthEnvironment(): void {
  delete runtimeGlobal().__worldconsAuthEnvironmentV1;
}
