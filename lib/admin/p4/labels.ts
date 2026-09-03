import type { AdminWorkStage, AdminWorkStateLabel, AdminWorkType } from "@/lib/admin/p4/types";

const failureStates = new Set(["failed", "aborted", "lease_expired", "dead_letter", "anomaly", "active"]);
const warningStates = new Set(["queued", "retry_wait", "needs_review", "in_review", "pending", "cancel_requested", "withdrawn"]);
const successStates = new Set(["succeeded", "complete", "approved", "published", "delivered", "fetched"]);
const infoStates = new Set(["running", "processing", "source_text_ready", "ready", "retrying"]);

const stateLabels: Record<string, string> = {
  "not linked": "연결 없음",
  unknown: "알 수 없음",
  recorded: "기록됨",
  queued: "대기",
  running: "실행 중",
  retry_wait: "재시도 대기",
  retrying: "재시도 중",
  succeeded: "성공",
  failed: "실패",
  aborted: "중단됨",
  abort_requested: "중단 요청",
  cancel_requested: "취소 요청",
  lease_expired: "임대 만료",
  shadowed: "호환 기록",
  source_text_ready: "원문 준비",
  not_ready: "준비 안 됨",
  ready: "준비됨",
  processing: "처리 중",
  complete: "완료",
  unreviewed: "미검토",
  approved: "승인됨",
  approved_for_processing: "처리 승인",
  needs_review: "검토 필요",
  in_review: "검토 중",
  draft: "초안",
  published: "공개됨",
  withdrawn: "철회됨",
  pending: "대기",
  delivered: "전달 완료",
  dead_letter: "영구 실패",
  fetched: "수집됨",
  ignored: "무시됨",
  active: "활성",
  anomaly: "이상",
  clear: "이상 없음",
  immutable: "변경 불가",
  none: "없음",
  metadata_only: "메타데이터만",
  cleaned: "요약 대기",
  summarizing: "요약 중",
  summarized: "요약 완료",
  failed_summary: "요약 실패",
  failed_fetch: "수집 실패",
};

const stageLabels: Record<AdminWorkStage, string> = {
  collect: "수집",
  process: "처리·요약",
  review: "검토",
  publish: "공개",
};

const typeLabels: Record<AdminWorkType, string> = {
  execution: "실행",
  article: "기사",
  candidate: "URL 후보",
  outbox: "캐시 전달",
  legacy: "호환 작업",
};

const actionLabels: Record<string, string> = {
  "ingest-and-summarize": "수집 후 요약",
  ingest: "수집 실행",
  summarize: "요약 실행",
  admin_bulk: "기사 일괄 작업",
  public_cache_revalidate: "공개 캐시 갱신",
  llm_test: "LLM 연결 시험",
  save_llm_settings: "LLM 설정 저장",
  job_cancel: "작업 취소",
  job_retry: "작업 재시도",
  refresh: "후보 갱신",
  ignore: "후보 무시",
  approve: "승인",
  "retry-summary": "요약 재시도",
  "approve-and-summarize": "요약 승인 후 실행",
  "resummarize-with-model": "선택 모델로 재요약",
  "publish-reviewed": "검토 완료 후 공개",
  "close-private": "비공개 종결",
  "retry-source-ingest": "수집원 재시도",
  manual_summary_edit: "요약 상세 수정",
  "p4.abort": "실행 중단",
  "p4.retry": "실행 재시도",
  "p4.candidate-retry": "후보 재등록",
  "p4.publish": "공개",
  "p4.withdraw": "공개 철회",
};

const eventTypeLabels: Record<string, string> = {
  admin_action: "관리자 작업",
  admin_review_action: "관리자 검토 작업",
};

export function adminStateText(value?: string | null) {
  const normalized = value?.trim() || "not linked";
  return normalized
    .split(" / ")
    .map((part) => stateLabels[part.toLowerCase()] ?? part)
    .join(" / ");
}

export function adminWorkStageText(stage: AdminWorkStage) {
  return stageLabels[stage];
}

export function adminWorkTypeText(type: AdminWorkType) {
  return typeLabels[type];
}

export function adminActionText(value?: string | null) {
  const normalized = value?.trim() || "";
  return actionLabels[normalized] ?? (normalized || "기록 없음");
}

export function adminEventTypeText(value?: string | null) {
  const normalized = value?.trim() || "";
  return eventTypeLabels[normalized] ?? (normalized || "기록 없음");
}

export function adminSlaText(value: "breached" | "due" | "healthy") {
  if (value === "breached") return "기한 초과";
  if (value === "due") return "기한 임박";
  return "정상";
}

export function adminStateLabel(value?: string | null): AdminWorkStateLabel {
  const normalized = value?.trim() || "not linked";
  const key = normalized.toLowerCase();
  return {
    value: normalized,
    tone: failureStates.has(key)
      ? "danger"
      : warningStates.has(key)
        ? "warning"
        : successStates.has(key)
          ? "success"
          : infoStates.has(key)
            ? "info"
            : "neutral",
  };
}

export function commandStage(commandType: string): AdminWorkStage {
  const value = commandType.toLowerCase();
  if (/publish|cache|outbox/.test(value)) return "publish";
  if (/review|article|glossary/.test(value)) return "review";
  if (/summar|derived|tag|llm|normaliz|verify/.test(value)) return "process";
  return "collect";
}

export function lifecycleStage(processing?: string | null, review?: string | null): AdminWorkStage {
  if (review && review !== "unreviewed") return "review";
  return processing && processing !== "not_ready" ? "process" : "collect";
}
