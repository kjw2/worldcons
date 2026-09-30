import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";
import type { P5CompatibilityObservation } from "@/lib/admin/p5/types";

export const ADMIN_PUBLICATION_V4_READ_FLAG = "ADMIN_PUBLICATION_V4_READ_ENABLED";

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function articlePublicationV4ReadsEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[ADMIN_PUBLICATION_V4_READ_FLAG]);
}

export function observeArticlePublicationReadDecision(
  surface: P5CompatibilityObservation["surface"],
  environment: Record<string, string | undefined> = process.env,
) {
  const selected = articlePublicationV4ReadsEnabled(environment);
  recordCompatibilityObservation(
    { surface, domain: "projection", direction: "read", authority: selected ? "new" : "legacy", outcome: "selected" },
    { environment },
  );
  return selected;
}
