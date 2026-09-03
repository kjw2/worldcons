import type { CaseBackfillRepository } from "@/lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillPassInput,
} from "@/lib/backfill/types";
import type { CrawlerRequestGovernor } from "@/lib/crawler/types";

const MAX_WAIT_CHUNK_MS = 5_000;

function requestOrigin(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("case_backfill.request_https_required");
  return parsed.origin.toLowerCase();
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export interface CaseBackfillRequestGovernorInput {
  repository: CaseBackfillRepository;
  snapshotId: string;
  phase: Extract<CaseBackfillPassInput["phase"], "discover" | "fetch">;
  authority: CaseBackfillAttemptAuthority;
  checkpoint: () => Promise<void>;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createCaseBackfillRequestGovernor(
  input: CaseBackfillRequestGovernorInput,
): CrawlerRequestGovernor {
  const sleep = input.sleep ?? abortableDelay;
  return {
    async acquire(url) {
      const origin = requestOrigin(url);
      for (;;) {
        await input.checkpoint();
        const result = await input.repository.acquireSourceRequestPermit({
          snapshotId: input.snapshotId,
          phase: input.phase,
          authority: input.authority,
          requestOrigin: origin,
          requestedLeaseSeconds: 90,
        });
        if (result.granted) {
          if (!result.permitId) throw new Error("case_backfill.request_permit_missing");
          let released = false;
          return {
            release: async () => {
              if (released) return;
              await input.repository.releaseSourceRequestPermit({
                permitId: result.permitId as string,
                authority: input.authority,
              });
              released = true;
            },
          };
        }
        const waitMs = Math.min(
          MAX_WAIT_CHUNK_MS,
          Math.max(25, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 1_000),
        );
        await sleep(waitMs, input.signal);
      }
    },
  };
}
