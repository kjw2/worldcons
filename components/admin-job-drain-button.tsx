"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Play, TriangleAlert } from "lucide-react";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function resultJobs(result: unknown) {
  if (!isRecord(result) || !Array.isArray(result.jobs)) return [];
  return result.jobs.filter(isRecord).slice(0, 5);
}

export function AdminJobDrainButton({
  csrfToken,
  endpoint = "/api/admin/jobs/run",
}: {
  csrfToken: string;
  endpoint?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function runWorker() {
    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ maxJobs: 2 }),
      });
      const payload: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      setResult(payload);
      router.refresh();
    } catch (workerError) {
      setError(workerError instanceof Error ? workerError.message : String(workerError));
    } finally {
      setPending(false);
    }
  }

  const resultRecord = isRecord(result) ? result : null;
  const jobs = resultJobs(result);

  return (
    <section className="rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">수동 처리</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">대기열 처리</h2>
          <p className="mt-2 text-sm leading-6 text-ink/62">대기 중인 작업을 최대 2건 claim해서 짧게 처리합니다.</p>
        </div>
        <button
          type="button"
          onClick={runWorker}
          disabled={pending}
          className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/40"
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          {pending ? "처리 중" : "대기열 처리"}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-court/25 bg-court/5 p-3 text-sm text-court">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4" aria-hidden="true" />
            처리 실패
          </div>
          <p className="mt-1 break-words">{error}</p>
        </div>
      ) : null}

      {resultRecord ? (
        <div className="mt-4 rounded-md border border-mint/25 bg-mint/5 p-3 text-sm text-ink/72">
          <div className="flex items-center gap-2 font-semibold text-mint">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            처리 결과
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[
              ["processed", numberField(resultRecord, "processed")],
              ["claimed", numberField(resultRecord, "claimed")],
              ["succeeded", numberField(resultRecord, "succeeded")],
              ["failed", numberField(resultRecord, "failed")],
            ].map(([label, value]) => (
              <span key={label} className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68">
                <span className="text-ink/45">{label}</span>
                <span>{Number(value).toLocaleString("ko-KR")}</span>
              </span>
            ))}
          </div>
          {jobs.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {jobs.map((job) => (
                <div key={textField(job, "id")} className="rounded-md border border-rule bg-white px-3 py-2 text-xs leading-5">
                  <div className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                    <span className="break-all">{textField(job, "jobType") || "job"}</span>
                    <span className="rounded-md border border-rule bg-parchment px-2 py-0.5 text-ink/60">{textField(job, "status") || "unknown"}</span>
                  </div>
                  {textField(job, "errorClass") ? <div className="mt-1 break-words text-court">{textField(job, "errorClass")}</div> : null}
                  {textField(job, "error") ? <div className="mt-1 break-words text-court">{textField(job, "error")}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
