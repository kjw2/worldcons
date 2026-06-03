export const LLM_PROVIDER_IDS = ["gemini", "openai", "anthropic", "openai-compatible"] as const;

export type ConfigurableLlmProvider = (typeof LLM_PROVIDER_IDS)[number];

export interface LlmKeyView {
  id: string;
  label: string;
  maskedValue: string;
  source: "database" | "environment";
  canDelete: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LlmProviderSettingsView {
  enabled: boolean;
  defaultModel: string;
  displayName?: string;
  baseUrl?: string;
  keys: LlmKeyView[];
  envKeyCount: number;
  hasUsableKey: boolean;
}

export interface LlmSummarySettingsView {
  provider: ConfigurableLlmProvider;
  model: string;
}

export interface AdminLlmSettingsView {
  hasDatabase: boolean;
  storageAvailable: boolean;
  storageError?: string | null;
  encryptionReady: boolean;
  encryptionSource?: string | null;
  summary: LlmSummarySettingsView;
  providers: Record<ConfigurableLlmProvider, LlmProviderSettingsView>;
  generatedAt: string;
}

export interface LlmKeyInput {
  id?: string;
  label?: string;
  value?: string;
  delete?: boolean;
}

export interface LlmProviderSettingsInput {
  enabled?: boolean;
  defaultModel?: string;
  displayName?: string;
  baseUrl?: string;
  keys?: LlmKeyInput[];
}

export interface AdminLlmSettingsInput {
  summary?: Partial<LlmSummarySettingsView>;
  providers?: Partial<Record<ConfigurableLlmProvider, LlmProviderSettingsInput>>;
}

