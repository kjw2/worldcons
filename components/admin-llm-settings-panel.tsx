"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Plus, Save, Server, Trash2, TriangleAlert } from "lucide-react";
import {
  LLM_PROVIDER_IDS,
  type AdminLlmSettingsInput,
  type AdminLlmSettingsView,
  type ConfigurableLlmProvider,
  type LlmKeyView,
} from "@/lib/ai/llm-settings-types";

type KeyForm = LlmKeyView & {
  value?: string;
  delete?: boolean;
  isNew?: boolean;
};

type ProviderForm = {
  enabled: boolean;
  defaultModel: string;
  displayName: string;
  baseUrl: string;
  keys: KeyForm[];
};

type FormState = {
  summary: {
    provider: ConfigurableLlmProvider;
    model: string;
  };
  providers: Record<ConfigurableLlmProvider, ProviderForm>;
};

const PROVIDER_LABELS: Record<ConfigurableLlmProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
  "openai-compatible": "OpenAI Compatible",
};

const MODEL_PLACEHOLDERS: Record<ConfigurableLlmProvider, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  "openai-compatible": "gpt-4.1-mini",
};

function newKeyId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `new-${crypto.randomUUID()}`;
  return `new-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function viewToForm(view: AdminLlmSettingsView): FormState {
  return {
    summary: {
      provider: view.summary.provider,
      model: view.summary.model,
    },
    providers: Object.fromEntries(
      LLM_PROVIDER_IDS.map((provider) => [
        provider,
        {
          enabled: view.providers[provider].enabled,
          defaultModel: view.providers[provider].defaultModel,
          displayName: view.providers[provider].displayName ?? "",
          baseUrl: view.providers[provider].baseUrl ?? "",
          keys: view.providers[provider].keys.map((key) => ({ ...key })),
        },
      ]),
    ) as Record<ConfigurableLlmProvider, ProviderForm>,
  };
}

function formToPayload(form: FormState): AdminLlmSettingsInput {
  return {
    summary: {
      provider: form.summary.provider,
      model: form.summary.model,
    },
    providers: Object.fromEntries(
      LLM_PROVIDER_IDS.map((provider) => {
        const current = form.providers[provider];
        return [
          provider,
          {
            enabled: current.enabled,
            defaultModel: current.defaultModel,
            displayName: current.displayName,
            baseUrl: current.baseUrl,
            keys: current.keys
              .filter((key) => key.source === "database" || key.isNew)
              .map((key) => ({
                id: key.isNew ? undefined : key.id,
                label: key.label,
                value: key.value,
                delete: key.delete,
              })),
          },
        ];
      }),
    ) as AdminLlmSettingsInput["providers"],
  };
}

function statusText(provider: ProviderForm) {
  const activeKeys = provider.keys.filter((key) => !key.delete).length;
  if (!provider.enabled) return "비활성";
  if (activeKeys === 0) return "키 없음";
  return `${activeKeys}개 키`;
}

export function AdminLlmSettingsPanel({
  initialSettings,
  csrfToken,
}: {
  initialSettings: AdminLlmSettingsView;
  csrfToken: string;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [form, setForm] = useState<FormState>(() => viewToForm(initialSettings));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const activeSummaryProvider = form.providers[form.summary.provider];
  const canSave = settings.storageAvailable && settings.encryptionReady && !pending;
  const providerOptions = useMemo(() => LLM_PROVIDER_IDS.map((provider) => ({ provider, label: PROVIDER_LABELS[provider] })), []);

  function updateProvider(provider: ConfigurableLlmProvider, patch: Partial<ProviderForm>) {
    setForm((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [provider]: {
          ...current.providers[provider],
          ...patch,
        },
      },
    }));
  }

  function updateKey(provider: ConfigurableLlmProvider, keyId: string, patch: Partial<KeyForm>) {
    const current = form.providers[provider];
    updateProvider(provider, {
      keys: current.keys.map((key) => (key.id === keyId ? { ...key, ...patch } : key)),
    });
  }

  function addKey(provider: ConfigurableLlmProvider) {
    const current = form.providers[provider];
    updateProvider(provider, {
      keys: [
        ...current.keys,
        {
          id: newKeyId(),
          label: "API 키",
          maskedValue: "새 키",
          source: "database",
          canDelete: true,
          isNew: true,
          value: "",
        },
      ],
    });
  }

  function removeUnsavedKey(provider: ConfigurableLlmProvider, keyId: string) {
    const current = form.providers[provider];
    updateProvider(provider, {
      keys: current.keys.filter((key) => key.id !== keyId),
    });
  }

  async function saveSettings() {
    if (!canSave) return;
    setPending(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch("/api/admin/llm-settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(formToPayload(form)),
      });
      const payload = (await response.json().catch(() => ({}))) as { settings?: AdminLlmSettingsView; error?: string };
      if (!response.ok || !payload.settings) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setSettings(payload.settings);
      setForm(viewToForm(payload.settings));
      setMessage("LLM 설정을 저장했습니다.");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-court">자동요약</p>
            <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">기본 LLM</h2>
          </div>
          <span className="inline-flex min-h-8 items-center gap-2 rounded-md border border-rule bg-parchment px-3 text-xs font-semibold text-ink/68">
            <Server className="size-4" aria-hidden="true" />
            {settings.storageAvailable ? "DB 저장" : "저장소 미사용"}
          </span>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_auto]">
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            제공자
            <select
              value={form.summary.provider}
              onChange={(event) => {
                const provider = event.target.value as ConfigurableLlmProvider;
                setForm((current) => ({
                  ...current,
                  summary: {
                    provider,
                    model: current.providers[provider].defaultModel || MODEL_PLACEHOLDERS[provider],
                  },
                }));
              }}
              className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
            >
              {providerOptions.map((option) => (
                <option key={option.provider} value={option.provider}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            모델
            <input
              value={form.summary.model}
              onChange={(event) => setForm((current) => ({ ...current, summary: { ...current.summary, model: event.target.value } }))}
              placeholder={MODEL_PLACEHOLDERS[form.summary.provider]}
              className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
            />
          </label>
          <button
            type="button"
            onClick={saveSettings}
            disabled={!canSave}
            className="focus-ring mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/40 lg:mt-auto"
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            {pending ? "저장 중" : "설정 저장"}
          </button>
        </div>

        <div className="mt-4 rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm text-ink/68">
          현재 선택: {PROVIDER_LABELS[form.summary.provider]} · {form.summary.model || activeSummaryProvider.defaultModel || MODEL_PLACEHOLDERS[form.summary.provider]}
        </div>

        {!settings.storageAvailable || !settings.encryptionReady || message ? (
          <div className={`mt-4 rounded-md border p-3 text-sm ${isError || !settings.storageAvailable || !settings.encryptionReady ? "border-court/25 bg-court/5 text-court" : "border-mint/25 bg-mint/5 text-mint"}`}>
            <div className="flex items-center gap-2 font-semibold">
              {isError || !settings.storageAvailable || !settings.encryptionReady ? <TriangleAlert className="size-4" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
              {isError || !settings.storageAvailable || !settings.encryptionReady ? "확인 필요" : "저장 완료"}
            </div>
            <p className="mt-1 break-words">
              {message || settings.storageError || (!settings.encryptionReady ? "LLM_SETTINGS_SECRET 또는 서버 secret이 필요합니다." : "")}
            </p>
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        {LLM_PROVIDER_IDS.map((provider) => {
          const providerForm = form.providers[provider];
          return (
            <section key={provider} className="rounded-md border border-rule bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-court">{PROVIDER_LABELS[provider]}</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-normal text-ink">{statusText(providerForm)}</h2>
                </div>
                <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-parchment px-3 text-sm font-semibold text-ink/70">
                  <input
                    type="checkbox"
                    checked={providerForm.enabled}
                    onChange={(event) => updateProvider(provider, { enabled: event.target.checked })}
                    className="size-4 rounded border-rule text-court"
                  />
                  활성
                </label>
              </div>

              <div className="grid gap-3">
                {provider === "openai-compatible" ? (
                  <>
                    <label className="grid gap-1 text-sm font-medium text-ink/72">
                      표시 이름
                      <input
                        value={providerForm.displayName}
                        onChange={(event) => updateProvider(provider, { displayName: event.target.value })}
                        placeholder="OpenAI Compatible"
                        className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium text-ink/72">
                      Base URL
                      <input
                        value={providerForm.baseUrl}
                        onChange={(event) => updateProvider(provider, { baseUrl: event.target.value })}
                        placeholder="https://api.example.com/v1"
                        className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                      />
                    </label>
                  </>
                ) : null}
                <label className="grid gap-1 text-sm font-medium text-ink/72">
                  기본 모델
                  <input
                    value={providerForm.defaultModel}
                    onChange={(event) => updateProvider(provider, { defaultModel: event.target.value })}
                    placeholder={MODEL_PLACEHOLDERS[provider]}
                    className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                  />
                </label>
              </div>

              <div className="mt-4 grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase text-ink/50">API Keys</p>
                  <button
                    type="button"
                    onClick={() => addKey(provider)}
                    className="focus-ring inline-flex min-h-8 items-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/70 hover:bg-parchment"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    키 추가
                  </button>
                </div>

                {providerForm.keys.length === 0 ? (
                  <div className="rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm text-ink/58">저장된 키 없음</div>
                ) : null}

                {providerForm.keys.map((key) => (
                  <div key={key.id} className={`rounded-md border p-3 ${key.delete ? "border-court/25 bg-court/5" : "border-rule bg-parchment/35"}`}>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_auto]">
                      <label className="grid gap-1 text-xs font-semibold text-ink/58">
                        라벨
                        <input
                          value={key.label}
                          disabled={key.source === "environment" || key.delete}
                          onChange={(event) => updateKey(provider, key.id, { label: event.target.value })}
                          className="focus-ring h-9 rounded-md border border-rule bg-white px-3 text-sm font-medium text-ink disabled:bg-rule/35 disabled:text-ink/45"
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-ink/58">
                        {key.isNew ? "키" : "키 교체"}
                        <input
                          value={key.value ?? ""}
                          disabled={key.source === "environment" || key.delete}
                          type="password"
                          autoComplete="new-password"
                          onChange={(event) => updateKey(provider, key.id, { value: event.target.value })}
                          placeholder={key.isNew ? "API 키 입력" : key.maskedValue}
                          className="focus-ring h-9 rounded-md border border-rule bg-white px-3 text-sm font-medium text-ink disabled:bg-rule/35 disabled:text-ink/45"
                        />
                      </label>
                      {key.source === "environment" ? (
                        <span className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/58">
                          <KeyRound className="size-4" aria-hidden="true" />
                          환경변수
                        </span>
                      ) : key.isNew ? (
                        <button
                          type="button"
                          onClick={() => removeUnsavedKey(provider, key.id)}
                          className="focus-ring mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/62 hover:bg-parchment"
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          제거
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => updateKey(provider, key.id, { delete: !key.delete })}
                          className="focus-ring mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-court/25 bg-white px-3 text-xs font-semibold text-court hover:bg-court/5"
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          {key.delete ? "유지" : "삭제"}
                        </button>
                      )}
                    </div>
                    {!key.isNew ? <p className="mt-2 text-xs text-ink/50">{key.source === "database" ? key.maskedValue : "배포 환경변수에서 감지됨"}</p> : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
