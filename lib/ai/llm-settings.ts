import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getSupabaseAdmin, hasSupabaseConfig } from "@/lib/db/client";
import {
  LLM_PROVIDER_IDS,
  type AdminLlmSettingsInput,
  type AdminLlmSettingsView,
  type ConfigurableLlmProvider,
  type LlmKeyInput,
  type LlmProviderSettingsView,
} from "@/lib/ai/llm-settings-types";

interface StoredLlmKey {
  id: string;
  label: string;
  encryptedValue: string;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredProviderSettings {
  enabled?: boolean;
  defaultModel?: string;
  displayName?: string;
  baseUrl?: string;
  keys?: StoredLlmKey[];
}

interface StoredLlmSettings {
  version: 1;
  summary?: {
    provider?: ConfigurableLlmProvider;
    model?: string;
  };
  providers?: Partial<Record<ConfigurableLlmProvider, StoredProviderSettings>>;
}

export interface RuntimeLlmProviderSettings {
  enabled: boolean;
  defaultModel: string;
  displayName?: string;
  baseUrl?: string;
  apiKeys: string[];
}

export interface RuntimeLlmSettings {
  summary: {
    provider: ConfigurableLlmProvider;
    model: string;
  };
  providers: Record<ConfigurableLlmProvider, RuntimeLlmProviderSettings>;
}

const SETTINGS_ID = "default";
const ENCRYPTION_PREFIX = "v1";

const DEFAULT_MODELS: Record<ConfigurableLlmProvider, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  "openai-compatible": "gpt-4.1-mini",
};

const ENV_PROVIDER_KEYS: Record<ConfigurableLlmProvider, string[]> = {
  gemini: ["GEMINI_API_KEYS", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  "openai-compatible": ["OPENAI_COMPATIBLE_API_KEY"],
};

function parseCsvEnv(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function boundedText(value: unknown, fallback = "", max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function isProvider(value: unknown): value is ConfigurableLlmProvider {
  return typeof value === "string" && (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

function defaultProviderSettings(provider: ConfigurableLlmProvider): StoredProviderSettings {
  return {
    enabled: provider === "gemini" || provider === "openai",
    defaultModel: envDefaultModel(provider) || DEFAULT_MODELS[provider],
    displayName: provider === "openai-compatible" ? "OpenAI Compatible" : undefined,
    baseUrl: provider === "openai-compatible" ? process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() : undefined,
    keys: [],
  };
}

function defaultStoredSettings(): StoredLlmSettings {
  const envProvider = process.env.LLM_PROVIDER;
  const provider = isProvider(envProvider) ? envProvider : hasEnvKeys("gemini") ? "gemini" : "openai";
  return {
    version: 1,
    summary: {
      provider,
      model: envDefaultModel(provider) || DEFAULT_MODELS[provider],
    },
    providers: Object.fromEntries(LLM_PROVIDER_IDS.map((item) => [item, defaultProviderSettings(item)])) as Record<
      ConfigurableLlmProvider,
      StoredProviderSettings
    >,
  };
}

function envDefaultModel(provider: ConfigurableLlmProvider) {
  if (provider === "gemini") return process.env.GEMINI_SUMMARY_MODEL?.trim() || process.env.GEMINI_PINNED_MODEL?.trim();
  if (provider === "openai") return process.env.OPENAI_SUMMARY_MODEL?.trim();
  if (provider === "anthropic") return process.env.ANTHROPIC_SUMMARY_MODEL?.trim() || process.env.CLAUDE_SUMMARY_MODEL?.trim();
  return process.env.OPENAI_COMPATIBLE_SUMMARY_MODEL?.trim();
}

function envKeys(provider: ConfigurableLlmProvider) {
  const keys = ENV_PROVIDER_KEYS[provider].flatMap((name) => parseCsvEnv(process.env[name]));
  return unique(keys);
}

function hasEnvKeys(provider: ConfigurableLlmProvider) {
  return envKeys(provider).length > 0;
}

function encryptionSecret() {
  const candidates = [
    ["LLM_SETTINGS_SECRET", process.env.LLM_SETTINGS_SECRET],
    ["ADMIN_SESSION_SECRET", process.env.ADMIN_SESSION_SECRET],
    ["CRON_SECRET", process.env.CRON_SECRET],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
    ["ADMIN_PASSWORD", process.env.ADMIN_PASSWORD],
  ] as const;
  const found = candidates.find(([, value]) => value?.trim());
  if (found) return { source: found[0], value: found[1]!.trim() };
  if (process.env.NODE_ENV !== "production") return { source: "development-fallback", value: "worldcons-local-llm-settings-secret" };
  return null;
}

function encryptionKey() {
  const secret = encryptionSecret();
  return secret ? createHash("sha256").update(secret.value).digest() : null;
}

function encryptSecret(value: string) {
  const key = encryptionKey();
  if (!key) throw new Error("LLM_SETTINGS_SECRET or another server secret is required to store LLM API keys.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(value: string) {
  const key = encryptionKey();
  if (!key) throw new Error("LLM settings encryption secret is not configured.");
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== ENCRYPTION_PREFIX || !iv || !tag || !encrypted) throw new Error("Invalid encrypted LLM key payload.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function maskSecret(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "비어 있음";
  const tail = trimmed.slice(-4);
  return `•••• ${tail}`;
}

function storedKeyView(key: StoredLlmKey) {
  return {
    id: key.id,
    label: key.label,
    maskedValue: `•••• ${key.lastFour}`,
    source: "database" as const,
    canDelete: true,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

function envKeyViews(provider: ConfigurableLlmProvider) {
  return envKeys(provider).map((key, index) => ({
    id: `env-${provider}-${index + 1}`,
    label: index === 0 ? "환경변수" : `환경변수 ${index + 1}`,
    maskedValue: maskSecret(key),
    source: "environment" as const,
    canDelete: false,
    createdAt: null,
    updatedAt: null,
  }));
}

function mergeStoredSettings(settings?: StoredLlmSettings | null): StoredLlmSettings {
  const defaults = defaultStoredSettings();
  const incoming: Partial<StoredLlmSettings> = settings && settings.version === 1 ? settings : {};
  const providers = Object.fromEntries(
    LLM_PROVIDER_IDS.map((provider) => {
      const current = incoming.providers?.[provider] ?? {};
      const fallback = defaults.providers?.[provider] ?? defaultProviderSettings(provider);
      return [
        provider,
        {
          ...fallback,
          ...current,
          keys: Array.isArray(current.keys) ? current.keys : fallback.keys ?? [],
        },
      ];
    }),
  ) as Record<ConfigurableLlmProvider, StoredProviderSettings>;
  const summaryProvider: ConfigurableLlmProvider = isProvider(incoming.summary?.provider) ? incoming.summary.provider : defaults.summary?.provider ?? "openai";
  return {
    version: 1,
    summary: {
      provider: summaryProvider,
      model: boundedText(incoming.summary?.model, providers[summaryProvider]?.defaultModel || DEFAULT_MODELS[summaryProvider], 160),
    },
    providers,
  };
}

async function readStoredSettings() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return {
      hasDatabase: false,
      storageAvailable: false,
      settings: null,
      error: hasSupabaseConfig() ? "Supabase client is unavailable." : "Supabase 환경변수가 없어 설정 저장소를 사용할 수 없습니다.",
    };
  }

  const { data, error } = await supabase
    .from("llm_settings")
    .select("settings")
    .eq("id", SETTINGS_ID)
    .maybeSingle();

  if (error) {
    return {
      hasDatabase: true,
      storageAvailable: false,
      settings: null,
      error: error.message,
    };
  }

  return {
    hasDatabase: true,
    storageAvailable: true,
    settings: (data?.settings as StoredLlmSettings | null) ?? null,
    error: null,
  };
}

function providerView(provider: ConfigurableLlmProvider, settings: StoredProviderSettings): LlmProviderSettingsView {
  const databaseKeys = settings.keys ?? [];
  const environmentKeys = envKeyViews(provider);
  const enabled = settings.enabled !== false;
  return {
    enabled,
    defaultModel: boundedText(settings.defaultModel, envDefaultModel(provider) || DEFAULT_MODELS[provider], 160),
    displayName: boundedText(settings.displayName, provider === "openai-compatible" ? "OpenAI Compatible" : "", 120) || undefined,
    baseUrl: boundedText(settings.baseUrl, provider === "openai-compatible" ? process.env.OPENAI_COMPATIBLE_BASE_URL ?? "" : "", 500) || undefined,
    keys: [...databaseKeys.map(storedKeyView), ...environmentKeys],
    envKeyCount: environmentKeys.length,
    hasUsableKey: databaseKeys.length > 0 || environmentKeys.length > 0,
  };
}

export async function getAdminLlmSettingsView(): Promise<AdminLlmSettingsView> {
  const read = await readStoredSettings();
  const settings = mergeStoredSettings(read.settings);
  const secret = encryptionSecret();
  return {
    hasDatabase: read.hasDatabase,
    storageAvailable: read.storageAvailable,
    storageError: read.error,
    encryptionReady: Boolean(secret),
    encryptionSource: secret?.source ?? null,
    summary: {
      provider: settings.summary?.provider ?? "openai",
      model: settings.summary?.model ?? DEFAULT_MODELS.openai,
    },
    providers: Object.fromEntries(
      LLM_PROVIDER_IDS.map((provider) => [provider, providerView(provider, settings.providers?.[provider] ?? defaultProviderSettings(provider))]),
    ) as Record<ConfigurableLlmProvider, LlmProviderSettingsView>,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeStoredKeys(existing: StoredLlmKey[], inputs: LlmKeyInput[] | undefined) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const now = new Date().toISOString();
  const next: StoredLlmKey[] = [];

  for (const input of inputs ?? []) {
    const id = boundedText(input.id, "", 120);
    const value = boundedText(input.value, "", 20_000);
    if (input.delete === true) continue;
    if (id && byId.has(id) && !value) {
      const current = byId.get(id)!;
      next.push({
        ...current,
        label: boundedText(input.label, current.label, 120) || current.label,
        updatedAt: now,
      });
      continue;
    }
    if (!value) continue;
    const keyId = id && !id.startsWith("env-") ? id : randomUUID();
    next.push({
      id: keyId,
      label: boundedText(input.label, "API 키", 120) || "API 키",
      encryptedValue: encryptSecret(value),
      lastFour: value.slice(-4),
      createdAt: byId.get(keyId)?.createdAt ?? now,
      updatedAt: now,
    });
  }

  return next;
}

export async function saveAdminLlmSettings(input: AdminLlmSettingsInput) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase 설정이 없어 LLM 설정을 저장할 수 없습니다.");
  if (!encryptionSecret()) throw new Error("LLM_SETTINGS_SECRET or another server secret is required to store LLM API keys.");

  const read = await readStoredSettings();
  if (!read.storageAvailable) throw new Error(read.error ?? "LLM 설정 저장소를 사용할 수 없습니다.");

  const current = mergeStoredSettings(read.settings);
  const providers = Object.fromEntries(
    LLM_PROVIDER_IDS.map((provider) => {
      const incoming = input.providers?.[provider] ?? {};
      const previous = current.providers?.[provider] ?? defaultProviderSettings(provider);
      return [
        provider,
        {
          enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : previous.enabled !== false,
          defaultModel: boundedText(incoming.defaultModel, previous.defaultModel || DEFAULT_MODELS[provider], 160),
          displayName: provider === "openai-compatible" ? boundedText(incoming.displayName, previous.displayName ?? "OpenAI Compatible", 120) : undefined,
          baseUrl: provider === "openai-compatible" ? boundedText(incoming.baseUrl, previous.baseUrl ?? "", 500) : undefined,
          keys: normalizeStoredKeys(previous.keys ?? [], incoming.keys),
        },
      ];
    }),
  ) as Record<ConfigurableLlmProvider, StoredProviderSettings>;

  const summaryProvider = isProvider(input.summary?.provider) ? input.summary.provider : current.summary?.provider ?? "openai";
  const nextSettings: StoredLlmSettings = {
    version: 1,
    summary: {
      provider: summaryProvider,
      model: boundedText(input.summary?.model, providers[summaryProvider]?.defaultModel || DEFAULT_MODELS[summaryProvider], 160),
    },
    providers,
  };

  const { error } = await supabase.from("llm_settings").upsert(
    {
      id: SETTINGS_ID,
      settings: nextSettings,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) throw new Error(error.message);
  return getAdminLlmSettingsView();
}

function decryptKeys(keys: StoredLlmKey[] | undefined) {
  const values: string[] = [];
  for (const key of keys ?? []) {
    try {
      const value = decryptSecret(key.encryptedValue).trim();
      if (value) values.push(value);
    } catch {
      // Ignore keys encrypted with an old or missing secret; env fallback may still work.
    }
  }
  return values;
}

export async function getRuntimeLlmSettings(): Promise<RuntimeLlmSettings> {
  const read = await readStoredSettings();
  const settings = mergeStoredSettings(read.settings);
  const providers = Object.fromEntries(
    LLM_PROVIDER_IDS.map((provider) => {
      const current = settings.providers?.[provider] ?? defaultProviderSettings(provider);
      const apiKeys = unique([...decryptKeys(current.keys), ...envKeys(provider)]);
      return [
        provider,
        {
          enabled: current.enabled !== false,
          defaultModel: boundedText(current.defaultModel, envDefaultModel(provider) || DEFAULT_MODELS[provider], 160),
          displayName: boundedText(current.displayName, provider === "openai-compatible" ? "OpenAI Compatible" : "", 120) || undefined,
          baseUrl: boundedText(current.baseUrl, provider === "openai-compatible" ? process.env.OPENAI_COMPATIBLE_BASE_URL ?? "" : "", 500) || undefined,
          apiKeys,
        },
      ];
    }),
  ) as Record<ConfigurableLlmProvider, RuntimeLlmProviderSettings>;

  const provider = settings.summary?.provider ?? "openai";
  return {
    summary: {
      provider,
      model: boundedText(settings.summary?.model, providers[provider]?.defaultModel || DEFAULT_MODELS[provider], 160),
    },
    providers,
  };
}

export function providerLabel(provider: ConfigurableLlmProvider) {
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Claude";
  return "OpenAI Compatible";
}
