"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Plus, Save, Server, Trash2, TriangleAlert } from "lucide-react";
import {
  LLM_PROVIDER_IDS,
  type AdminLlmSettingsInput,
  type AdminLlmSettingsView,
  type ConfigurableLlmProvider,
  type LlmKeyView,
  type LlmProviderSettingsView,
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

type LlmTestResponse = {
  error?: string;
  errorClass?: string;
  test?: {
    status?: "ok" | "failed";
    provider?: string;
    model?: string | null;
    durationMs?: number;
  };
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

function savedDatabaseKeyCount(provider: LlmProviderSettingsView) {
  return provider.keys.filter((key) => key.source === "database").length;
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
  const [testPending, setTestPending] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testIsError, setTestIsError] = useState(false);

  const activeSummaryProvider = form.providers[form.summary.provider];
  const activeSavedProvider = settings.providers[form.summary.provider];
  const activeModel = form.summary.model || activeSummaryProvider.defaultModel || MODEL_PLACEHOLDERS[form.summary.provider];
  const activeDbKeyCount = savedDatabaseKeyCount(activeSavedProvider);
  const canSave = settings.storageAvailable && settings.encryptionReady && !pending && !testPending;
  const canRunTest = !pending && !testPending && Boolean(activeModel.trim());
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

  async function testLlmSettings() {
    if (!canRunTest) return;
    setTestPending(true);
    setTestMessage(null);
    setTestIsError(false);

    try {
      const response = await fetch("/api/admin/llm-settings/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          provider: form.summary.provider,
          model: activeModel,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as LlmTestResponse;
      if (!response.ok || payload.test?.status !== "ok") {
        throw new Error([payload.error || `HTTP ${response.status}`, payload.errorClass].filter(Boolean).join(" · "));
      }
      setTestMessage(`${payload.test.provider ?? form.summary.provider} · ${payload.test.model ?? activeModel} · ${payload.test.durationMs ?? 0}ms`);
    } catch (error) {
      setTestIsError(true);
      setTestMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTestPending(false);
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

        <div className="mt-4 grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_auto_auto]">
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
          <button
            type="button"
            onClick={testLlmSettings}
            disabled={!canRunTest}
            className="focus-ring mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-rule bg-white px-4 text-sm font-semibold text-ink/72 transition hover:bg-parchment disabled:cursor-not-allowed disabled:bg-rule/40 disabled:text-ink/40 lg:mt-auto"
          >
            {testPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Server className="size-4" aria-hidden="true" />}
            {testPending ? "테스트 중" : "테스트 호출"}
          </button>
        </div>

        <div className="mt-4 rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm text-ink/68">
          <div className="break-words">
            현재 선택: {PROVIDER_LABELS[form.summary.provider]} · {activeModel}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-white px-2.5 font-semibold text-ink/62">
              DB 키 {activeDbKeyCount}개
            </span>
            <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-white px-2.5 font-semibold text-ink/62">
              환경 키 {activeSavedProvider.envKeyCount}개
            </span>
            <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 font-semibold ${activeSavedProvider.hasUsableKey ? "border-mint/25 bg-mint/10 text-mint" : "border-court/25 bg-court/5 text-court"}`}>
              {activeSavedProvider.hasUsableKey ? "호출 가능 키 있음" : "호출 가능 키 없음"}
            </span>
          </div>
        </div>

        {testMessage ? (
          <div className={`mt-4 rounded-md border p-3 text-sm ${testIsError ? "border-court/25 bg-court/5 text-court" : "border-mint/25 bg-mint/5 text-mint"}`}>
            <div className="flex items-center gap-2 font-semibold">
              {testIsError ? <TriangleAlert className="size-4" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
              {testIsError ? "테스트 실패" : "테스트 성공"}
            </div>
            <p className="mt-1 break-words">{testMessage}</p>
          </div>
        ) : null}

        {!activeSavedProvider.hasUsableKey ? (
          <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-900">
            테스트 호출은 서버에 저장된 키 또는 환경변수 키 기준으로 실행됩니다. 새 키를 입력했다면 먼저 저장하세요.
          </div>
        ) : null}

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
          const providerView = settings.providers[provider];
          const databaseKeyCount = savedDatabaseKeyCount(providerView);
          return (
            <section key={provider} className="rounded-md border border-rule bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-court">{PROVIDER_LABELS[provider]}</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-normal text-ink">{statusText(providerForm)}</h2>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 font-semibold text-ink/62">
                      DB {databaseKeyCount}
                    </span>
                    <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 font-semibold text-ink/62">
                      ENV {providerView.envKeyCount}
                    </span>
                    <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 font-semibold ${providerView.hasUsableKey ? "border-mint/25 bg-mint/10 text-mint" : "border-court/25 bg-court/5 text-court"}`}>
                      {providerView.hasUsableKey ? "usable" : "no key"}
                    </span>
                  </div>
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
