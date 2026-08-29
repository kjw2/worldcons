import "dotenv/config";
import { getSupabaseAdmin } from "@/lib/db/client";
import { getCollectionControlState } from "@/lib/masterdash/store";
import { runIngest } from "@/lib/ingest/run";
import { ingestSourceOutcomeLine } from "@/lib/ingest/incremental";
import {
  evaluateWatchdog,
  evaluationViolationSignature,
  recordAdminOpsEvent,
  recordWatchdogEvents,
  type WatchdogEvaluation,
} from "@/lib/ops/watchdog";

const ISSUE_TITLE_PREFIX = "[무인운영] 수집 경고";
const COMPENSATION_MIN_INTERVAL_HOURS = 24;
const COMPENSATION_INFLIGHT_HOURS = 6;
const REPO = process.env.GITHUB_REPOSITORY ?? "kjw2/worldcons";

interface GitHubIssue {
  number: number;
  state: string;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}

async function githubApi<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "worldcons-ops-watchdog",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`github ${method} ${path}: ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
    return null;
  }
  return (await response.json()) as T;
}

function freshnessHoursLabel(seconds: number | null) {
  return seconds === null ? "-" : `${Math.floor(seconds / 3600)}h`;
}

function issueBody(evaluation: WatchdogEvaluation) {
  const lines = [
    `생성 시각: ${evaluation.generatedAt}`,
    `상태: 위반 ${evaluation.violations.length}건${evaluation.paused ? " (수집 일시정지 중)" : ""}`,
    "",
    "## 소스별 현황",
    "",
    "| 소스 | 마지막 실행 | 결과 | 신선도 | 신규/갱신/미수집 |",
    "|---|---|---|---|---|",
  ];
  for (const source of evaluation.sources) {
    lines.push(
      `| ${source.sourceKey} | ${source.lastRunStartedAt ?? "-"} | ${source.lastRunOutcome ?? source.lastRunStatus ?? "-"} | ${freshnessHoursLabel(source.freshnessSeconds)} | ${source.addedCount ?? "-"}/${source.refreshedCount ?? "-"}/${source.uncollectedCount ?? "-"} |`,
    );
  }
  lines.push("", "## 위반 사항", "");
  if (evaluation.violations.length === 0) {
    lines.push("- 없음");
  } else {
    for (const violation of evaluation.violations) {
      lines.push(`- [${violation.severity}] ${violation.key} — ${violation.summary}`);
    }
  }
  lines.push("", "관리자 페이지: https://worldcons.vercel.app/admin/ops", "미수집 후보: https://worldcons.vercel.app/admin/candidates");
  lines.push(`<!-- ops-signature:${evaluationViolationSignature(evaluation)} -->`);
  return lines.join("\n");
}

function issueSignature(issue: GitHubIssue | null) {
  const match = issue?.body?.match(/ops-signature:([a-zA-Z0-9:|_-]+)/);
  return match ? match[1] : null;
}

async function findOpenWatchdogIssue(): Promise<GitHubIssue | null> {
  const issues = await githubApi<GitHubIssue[]>("GET", "issues?state=open&per_page=100");
  return (issues ?? []).find((issue) => issue.title.startsWith(ISSUE_TITLE_PREFIX) && !issue.pull_request) ?? null;
}

async function manageIssue(evaluation: WatchdogEvaluation, now: Date): Promise<string | null> {
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set; skipping GitHub issue management.");
    return null;
  }
  const existing = await findOpenWatchdogIssue();
  if (evaluation.ok) {
    if (!existing) return null;
    await githubApi("POST", `issues/${existing.number}/comments`, {
      body: `자동 복구 확인 (${now.toISOString()}). 감지된 위반 사항이 해소되어 이슈를 닫습니다.`,
    });
    await githubApi("PATCH", `issues/${existing.number}`, { state: "closed" });
    await recordAdminOpsEvent({
      eventType: "watchdog_issue_closed",
      severity: "info",
      summary: `경고 이슈 #${existing.number} 자동 종료`,
      detail: { number: existing.number },
    });
    return `closed #${existing.number}`;
  }
  if (existing) {
    const signature = evaluationViolationSignature(evaluation);
    if (issueSignature(existing) === signature) {
      return `unchanged #${existing.number}`;
    }
    await githubApi("PATCH", `issues/${existing.number}`, { body: issueBody(evaluation) });
    await recordAdminOpsEvent({
      eventType: "watchdog_issue_updated",
      severity: evaluation.violations.some((violation) => violation.severity === "critical") ? "critical" : "warning",
      summary: `경고 이슈 #${existing.number} 상태 갱신`,
      detail: { number: existing.number, violationKeys: evaluation.violations.map((violation) => violation.key) },
    });
    return `updated #${existing.number}`;
  }
  const created = await githubApi<GitHubIssue>("POST", "issues", {
    title: `${ISSUE_TITLE_PREFIX} (${evaluation.violations.length}건)`,
    body: issueBody(evaluation),
  });
  if (!created) return null;
  await recordAdminOpsEvent({
    eventType: "watchdog_issue_filed",
    severity: "critical",
    summary: `경고 이슈 #${created.number} 신규 발행`,
    detail: { number: created.number, url: created.html_url, violationKeys: evaluation.violations.map((violation) => violation.key) },
  });
  return `filed #${created.number}`;
}

async function tryCompensate(evaluation: WatchdogEvaluation, now: Date): Promise<Record<string, unknown>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { action: "skipped", reason: "no-supabase" };
  if (evaluation.paused) return { action: "skipped", reason: "paused" };

  const lastCompletedMs = evaluation.lastCompletedRunAt ? Date.parse(evaluation.lastCompletedRunAt) : Number.NaN;
  if (!Number.isFinite(lastCompletedMs) || now.getTime() - lastCompletedMs < COMPENSATION_MIN_INTERVAL_HOURS * 3_600_000) {
    return { action: "skipped", reason: "recent-completed-run" };
  }

  const recentStart = new Date(now.getTime() - COMPENSATION_INFLIGHT_HOURS * 3_600_000).toISOString();
  const { data: recent } = await supabase.from("ingestion_runs").select("id").gte("started_at", recentStart).limit(1);
  if ((recent ?? []).length > 0) return { action: "skipped", reason: "recent-run-in-flight" };

  const control = await getCollectionControlState();
  if (control.available && control.paused) return { action: "skipped", reason: "paused" };

  try {
    const result = await runIngest({ limit: 5, refreshExisting: true });
    const outcomeLines = (result.results ?? []).map((sourceResult) => ingestSourceOutcomeLine(sourceResult));
    await recordAdminOpsEvent({
      eventType: "watchdog_compensation",
      severity: "warning",
      summary: "수집 실행 누락 감지로 보정 수집 실행 (limit 5/소스)",
      detail: { mode: result.mode, results: outcomeLines },
    });
    return { action: "ran", mode: result.mode, results: outcomeLines };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAdminOpsEvent({
      eventType: "watchdog_error",
      severity: "critical",
      summary: `보정 수집 실행 실패: ${message}`,
    });
    return { action: "failed", error: message };
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const compensate = process.argv.includes("--compensate");
  const now = new Date();

  const evaluation = await evaluateWatchdog(now);
  await recordWatchdogEvents(evaluation, now);

  let issueAction: string | null = null;
  if (!dryRun) {
    issueAction = await manageIssue(evaluation, now);
  }

  let compensation: Record<string, unknown> | null = null;
  if (compensate && !dryRun) {
    compensation = await tryCompensate(evaluation, now);
  }

  console.log(
    JSON.stringify({
      ok: evaluation.ok,
      generatedAt: evaluation.generatedAt,
      paused: evaluation.paused,
      violationCount: evaluation.violations.length,
      violationKeys: evaluation.violations.map((violation) => violation.key),
      issueAction,
      compensation,
    }),
  );
}

main()
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`watchdog failed: ${message}`);
    await recordAdminOpsEvent({ eventType: "watchdog_error", severity: "critical", summary: `워치독 실행 실패: ${message}` }).catch(() => undefined);
    process.exitCode = 1;
  });
