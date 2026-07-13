export const BVERFG_OFFICIAL_DETAIL_404 = "BVERFG_OFFICIAL_DETAIL_404";
export const BVERFG_LIVE_DISCOVERY_EMPTY = "BVERFG_LIVE_DISCOVERY_EMPTY";

const candidateTrackingLabels: Record<string, string> = {
  [BVERFG_OFFICIAL_DETAIL_404]: "공식 상세 페이지 확인 대기",
  [BVERFG_LIVE_DISCOVERY_EMPTY]: "공식 탐색 결과 없음",
};

export function candidateTrackingReasonText(code?: string | null) {
  if (!code) return "추적 사유 없음";
  return candidateTrackingLabels[code] ?? code;
}

export function isKnownCandidateTrackingReason(code?: string | null) {
  return Boolean(code && code in candidateTrackingLabels);
}
