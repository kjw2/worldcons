/**
 * M6.1 D1 reference-read shadow configuration.
 *
 * Every flag defaults OFF: with no environment at all the shadow seam does no
 * D1 read, no comparison and emits no event. The config is a pure value object
 * so tests can inject it deterministically; the Worker entry resolves it once
 * per request from `env` and stores it on the runtime slot below.
 *
 * This module imports no Node builtin and no Cloudflare type.
 */
export const D1_SHADOW_READ_ENV = "WORLDCONS_D1_SHADOW_READ_ENABLED";
export const D1_SHADOW_COMPARE_ENV = "WORLDCONS_D1_SHADOW_COMPARE_ENABLED";
export const D1_SHADOW_SURFACES_ENV = "WORLDCONS_D1_SHADOW_SURFACES";
export const D1_SHADOW_TIMEOUT_ENV = "WORLDCONS_D1_SHADOW_TIMEOUT_MS";
export const D1_SHADOW_MAX_ROWS_ENV = "WORLDCONS_D1_SHADOW_MAX_ROWS";
export const D1_SHADOW_MAX_IN_FLIGHT_ENV = "WORLDCONS_D1_SHADOW_MAX_IN_FLIGHT";
export const D1_SHADOW_SAMPLE_RATE_ENV = "WORLDCONS_D1_SHADOW_SAMPLE_RATE";

/** The only shadow surface implemented so far (M6.1 reference reads). */
export const D1_SHADOW_REFERENCE_SURFACE = "reference";

/** M6.3 bounded article-read shadow surface. */
export const D1_SHADOW_ARTICLE_READ_SURFACE = "article_read";

export const D1_SHADOW_DEFAULT_TIMEOUT_MS = 1500;
export const D1_SHADOW_DEFAULT_MAX_ROWS = 2000;
export const D1_SHADOW_DEFAULT_MAX_IN_FLIGHT = 2;
export const D1_SHADOW_DEFAULT_SAMPLE_RATE = 0.1;

export interface D1ShadowConfig {
  /** Run the background D1 read at all. */
  readEnabled: boolean;
  /** Compare the D1 read result to the authoritative result. Implies `readEnabled`. */
  compareEnabled: boolean;
  /** Allowed surfaces; the reference surface is the only implemented one. */
  surfaces: ReadonlySet<string>;
  timeoutMs: number;
  maxRows: number;
  maxInFlight: number;
  sampleRate: number;
}

export interface D1ShadowEnvironment {
  [key: string]: string | undefined;
}

function envValue(environment: D1ShadowEnvironment, key: string): string | undefined {
  const value = environment[key];
  return typeof value === "string" ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(1, parsed);
}

function parseSurfaces(value: string | undefined): ReadonlySet<string> {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return new Set([D1_SHADOW_REFERENCE_SURFACE]);
  const surfaces = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(surfaces.length > 0 ? surfaces : [D1_SHADOW_REFERENCE_SURFACE]);
}

/** Resolves the shadow config from an environment, fail-safe to fully-off defaults. */
export function resolveD1ShadowConfig(environment: D1ShadowEnvironment = {}): D1ShadowConfig {
  const readEnabled = parseBoolean(envValue(environment, D1_SHADOW_READ_ENV));
  const compareEnabled = readEnabled && parseBoolean(envValue(environment, D1_SHADOW_COMPARE_ENV));
  return {
    readEnabled,
    compareEnabled,
    surfaces: parseSurfaces(envValue(environment, D1_SHADOW_SURFACES_ENV)),
    timeoutMs: parsePositiveInteger(envValue(environment, D1_SHADOW_TIMEOUT_ENV), D1_SHADOW_DEFAULT_TIMEOUT_MS),
    maxRows: parsePositiveInteger(envValue(environment, D1_SHADOW_MAX_ROWS_ENV), D1_SHADOW_DEFAULT_MAX_ROWS),
    maxInFlight: parsePositiveInteger(envValue(environment, D1_SHADOW_MAX_IN_FLIGHT_ENV), D1_SHADOW_DEFAULT_MAX_IN_FLIGHT),
    sampleRate: parseSampleRate(envValue(environment, D1_SHADOW_SAMPLE_RATE_ENV), D1_SHADOW_DEFAULT_SAMPLE_RATE),
  };
}

interface WorldconsD1ShadowConfigGlobal {
  __worldconsD1ShadowConfigV1?: D1ShadowConfig;
}

function runtimeGlobal(): typeof globalThis & WorldconsD1ShadowConfigGlobal {
  return globalThis as typeof globalThis & WorldconsD1ShadowConfigGlobal;
}

export function setRuntimeD1ShadowConfig(config: D1ShadowConfig | null): void {
  const target = runtimeGlobal();
  if (config) target.__worldconsD1ShadowConfigV1 = config;
  else delete target.__worldconsD1ShadowConfigV1;
}

export function getRuntimeD1ShadowConfig(): D1ShadowConfig | null {
  return runtimeGlobal().__worldconsD1ShadowConfigV1 ?? null;
}
