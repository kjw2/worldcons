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
  gateway: GatewayAdminStatusView;
}

export interface GatewayTestStatus {
  status: "ok" | "failed";
  checkedAt: string;
  gatewayId: string;
  route: string;
  model?: string;
  durationMs: number;
  requestId?: string;
  errorCode?: string;
}

export interface GatewayAdminStatusView {
  backend: "cloudflare-ai-gateway";
  gatewayId: string;
  route: string;
  bindingAvailable: boolean;
  laneBackends: {
    G1: "direct-gemini" | "cloudflare-ai-gateway";
    G2: "direct-gemini" | "cloudflare-ai-gateway";
    G3: "direct-gemini" | "cloudflare-ai-gateway";
    G4: "direct-gemini" | "cloudflare-ai-gateway";
  };
  lastTest?: GatewayTestStatus;
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

