"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, EyeOff, Loader2, RefreshCcw, RotateCcw, Send } from "lucide-react";

type ReviewAction = "approve-and-summarize" | "retry-summary" | "resummarize-with-model" | "publish-reviewed" | "close-private" | "retry-source-ingest";

export interface SummaryModelOption {
  provider: "gemini" | "openai";
  model: string;
  label: string;
}

interface ReviewActionButton {
  action: ReviewAction;
  label: string;
  detail: string;
  icon: typeof CheckCircle2;
  disabled?: boolean;
  tone?: "primary" | "neutral" | "danger";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultMessage(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.review)) return "검토 결정을 저장했습니다.";
  const review = payload.review;

  if (review.status === "published") return "공개 처리했습니다.";
  if (review.status === "closed_private") return "비공개 종결했습니다.";
  if (review.status === "skipped") return typeof review.reason === "string" ? review.reason : "처리 조건을 충족하지 않습니다.";
  if (review.status === "not_found") return "자료를 찾을 수 없습니다.";
  if (isRecord(review.summarize)) {
    if (review.summarize.status === "summarized") {
      if (review.action === "resummarize-with-model" && typeof review.model === "string") return `${review.model} 모델로 재요약했습니다.`;
      return "검토 후 요약까지 완료했습니다.";
    }
    if (review.summarize.status === "failed") return typeof review.summarize.errorMessage === "string" ? review.summarize.errorMessage : "요약에 실패했습니다.";
    if (review.summarize.status === "skipped") return typeof review.summarize.reason === "string" ? review.summarize.reason : "요약 조건을 충족하지 않습니다.";
  }
  if (isRecord(review.ingest)) return "수집 재시도를 시작했습니다.";
  return "검토 결정을 저장했습니다.";
}

function buttonClass(tone: ReviewActionButton["tone"] = "neutral") {
  if (tone === "primary") return "border-mint/35 bg-mint px-3 py-2 text-white hover:bg-mint/90";
  if (tone === "danger") return "border-court/25 bg-court/5 px-3 py-2 text-court hover:bg-court/10";
  return "border-rule bg-white px-3 py-2 text-ink/72 hover:bg-parchment";
}

function modelKey(option: SummaryModelOption) {
  return `${option.provider}:${option.model}`;
}

export function AdminReviewActions({
  articleId,
  slug,
  status,
  hasSummary,
  hasPublishableText,
  isPublic,
  currentModel,
  modelOptions,
  secret,
}: {
  articleId?: string;
  slug: string;
  status: string;
  hasSummary: boolean;
  hasPublishableText: boolean;
  isPublic: boolean;
  currentModel?: string | null;
  modelOptions: SummaryModelOption[];
  secret?: string | null;
}) {
  const router = useRouter();
  const defaultModelOption = modelOptions.find((option) => option.model !== currentModel) ?? modelOptions[0] ?? null;
  const [note, setNote] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState(defaultModelOption ? modelKey(defaultModelOption) : "__custom__");
  const [customProvider, setCustomProvider] = useState<SummaryModelOption["provider"]>("gemini");
  const [customModel, setCustomModel] = useState("");
  const [pendingAction, setPendingAction] = useState<ReviewAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const selectedModelOption = modelOptions.find((option) => modelKey(option) === selectedModelKey);
  const manualResummaryModel =
    selectedModelKey === "__custom__"
      ? customModel.trim()
        ? { provider: customProvider, model: customModel.trim() }
        : null
      : selectedModelOption ?? null;

  const actions = useMemo<ReviewActionButton[]>(() => {
    const items: ReviewActionButton[] = [];

    if (status === "failed_summary") {
      items.push({
        action: "retry-summary",
        label: "재요약 실행",
        detail: "본문이 정상이라고 판단되면 같은 자료만 다시 요약합니다.",
        icon: RotateCcw,
        tone: "primary",
        disabled: !hasPublishableText,
      });
    }

    if (!hasSummary) {
      items.push({
        action: "approve-and-summarize",
        label: "요약 승인 후 실행",
        detail: "본문과 출처가 유효하다고 판단하고 공개 후보로 요약합니다.",
        icon: Send,
        tone: "primary",
        disabled: !hasPublishableText,
      });
    }

    if (hasSummary && !isPublic) {
      items.push({
        action: "publish-reviewed",
        label: "검토 완료 후 공개",
        detail: "요약과 원문 근거가 충분하다고 보고 공개 목록에 올립니다.",
        icon: CheckCircle2,
        tone: "primary",
      });
    }

    if (["metadata_only", "blocked", "timeout", "failed_fetch", "robots_disallowed"].includes(status)) {
      items.push({
        action: "retry-source-ingest",
        label: "수집원 재시도",
        detail: "같은 수집원에서 소량 재수집을 실행합니다.",
        icon: RefreshCcw,
      });
    }

    items.push({
      action: "close-private",
      label: "비공개 종결",
      detail: "공개하지 않기로 결정하고 검토 큐에서 제외합니다.",
      icon: EyeOff,
      tone: "danger",
    });

    return items;
  }, [hasPublishableText, hasSummary, isPublic, status]);

  async function runAction(action: ReviewAction, modelSelection?: Pick<SummaryModelOption, "provider" | "model"> | null) {
    if (pendingAction) return;

    const endpoint = secret ? `/api/admin/review?secret=${encodeURIComponent(secret)}` : "/api/admin/review";
    setPendingAction(action);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, articleId, slug, note, provider: modelSelection?.provider, model: modelSelection?.model }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const nextMessage = resultMessage(payload);
      setMessage(nextMessage);
      setIsError(/실패|충족하지|찾을 수|없어/.test(nextMessage));
      router.refresh();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="rounded-md border border-rule bg-white p-4">
      <div className="mb-3">
        <h3 className="text-base font-semibold tracking-normal text-ink">검토 결정</h3>
        <p className="mt-1 text-sm leading-6 text-ink/62">자료를 확인한 뒤 다음 절차를 선택합니다. 결정과 메모는 metadata에 저장됩니다.</p>
      </div>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-semibold text-ink/58">검토 메모</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          className="focus-ring min-h-24 w-full resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
          placeholder="예: 원문 링크와 추출 본문 확인. 헌법 쟁점 관련성이 있어 요약 승인."
        />
      </label>
      {hasSummary && isPublic ? (
        <div className="mb-4 border-t border-rule pt-4">
          <div className="mb-3">
            <h4 className="text-sm font-semibold tracking-normal text-ink">공개 자료 재요약</h4>
            <p className="mt-1 text-xs leading-5 text-ink/58">현재 공개 상태는 유지하고, 선택한 모델로 이 자료의 요약만 다시 생성합니다.</p>
            <p className="mt-1 text-xs leading-5 text-ink/58">현재 모델: {currentModel || "기록 없음"}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label>
              <span className="mb-1 block text-xs font-semibold text-ink/58">재요약 모델</span>
              <select
                value={selectedModelKey}
                onChange={(event) => setSelectedModelKey(event.target.value)}
                className="focus-ring h-10 w-full rounded-md border border-rule bg-parchment/35 px-3 text-sm font-semibold text-ink"
              >
                {modelOptions.map((option) => (
                  <option key={modelKey(option)} value={modelKey(option)}>
                    {option.label}
                  </option>
                ))}
                <option value="__custom__">직접 입력</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => runAction("resummarize-with-model", manualResummaryModel)}
              disabled={Boolean(pendingAction) || !manualResummaryModel}
              className={`focus-ring mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md border text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55 ${buttonClass("primary")}`}
            >
              {pendingAction === "resummarize-with-model" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCcw className="size-4" aria-hidden="true" />}
              {pendingAction === "resummarize-with-model" ? "재요약 중" : "선택 모델로 재요약"}
            </button>
          </div>
          {selectedModelKey === "__custom__" ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <label>
                <span className="mb-1 block text-xs font-semibold text-ink/58">제공자</span>
                <select
                  value={customProvider}
                  onChange={(event) => setCustomProvider(event.target.value as SummaryModelOption["provider"])}
                  className="focus-ring h-10 w-full rounded-md border border-rule bg-parchment/35 px-3 text-sm font-semibold text-ink"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold text-ink/58">모델명</span>
                <input
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  className="focus-ring h-10 w-full rounded-md border border-rule bg-parchment/35 px-3 text-sm font-semibold text-ink"
                  placeholder="예: gemini-2.5-flash-lite"
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map((item) => {
          const Icon = item.icon;
          const isPending = pendingAction === item.action;

          return (
            <button
              key={item.action}
              type="button"
              onClick={() => runAction(item.action)}
              disabled={Boolean(pendingAction) || item.disabled}
              title={item.disabled ? "추출 본문이 부족해 먼저 수집 또는 원문 확인이 필요합니다." : item.detail}
              className={`focus-ring min-h-20 rounded-md border text-left text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55 ${buttonClass(item.tone)}`}
            >
              <span className="flex items-center gap-2">
                {isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Icon className="size-4" aria-hidden="true" />}
                {isPending ? "처리 중" : item.label}
              </span>
              <span className="mt-1 block text-xs font-medium leading-5 opacity-75">{item.detail}</span>
            </button>
          );
        })}
      </div>
      {message ? <p className={`mt-3 text-sm leading-6 ${isError ? "text-court" : "text-mint"}`}>{message}</p> : null}
    </div>
  );
}
