import type { ReferencedProvision } from "@/lib/db/types";

export function provisionReviewLabel(confidence?: ReferencedProvision["confidence"] | null) {
  return confidence === "medium" || confidence === "low" ? "조문 참조 검토 필요" : null;
}
