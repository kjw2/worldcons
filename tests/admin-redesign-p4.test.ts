import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AdminTabs } from "../components/admin-tabs";
import { actionAllowedForKind, parseAdminWorkActionBody } from "../lib/admin/p4/actions";
import { DEFAULT_ADMIN_WORK_FILTERS, adminWorkFiltersQuery, parseAdminWorkFilters } from "../lib/admin/p4/filters";
import { adminRedesignUiEnabled } from "../lib/admin/p4/flags";
import { adminStateLabel } from "../lib/admin/p4/labels";
import {
  ADMIN_WORK_QUERY_CONTRACT,
  filterAndSortAdminWorkItems,
  paginateAdminWorkItems,
  redactOperationalText,
} from "../lib/admin/p4/repository";
import type { AdminWorkItem } from "../lib/admin/p4/types";

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function item(id: string, patch: Partial<AdminWorkItem> = {}): AdminWorkItem {
  return {
    id,
    type: "execution",
    stage: "collect",
    title: `Work ${id}`,
    target: `run ${id}`,
    source: "test-source",
    owner: "operator",
    execution: adminStateLabel("queued"),
    lifecycle: adminStateLabel(),
    publication: adminStateLabel(),
    attention: true,
    attentionCode: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    slaDueAt: "2026-07-12T00:30:00.000Z",
    slaState: "breached",
    latestError: null,
    attempts: 0,
    compatibility: false,
    detailHref: `/admin/work/execution/${id}`,
    safeAction: "abort",
    actionDisabledReason: null,
    ...patch,
  };
}

test("P4 UI flag is explicit-true only and legacy tabs retain flag-off parity", () => {
  assert.equal(adminRedesignUiEnabled({}), false);
  assert.equal(adminRedesignUiEnabled({ ADMIN_REDESIGN_UI_ENABLED: "false" }), false);
  assert.equal(adminRedesignUiEnabled({ ADMIN_REDESIGN_UI_ENABLED: "1" }), false);
  assert.equal(adminRedesignUiEnabled({ ADMIN_REDESIGN_UI_ENABLED: "TRUE" }), true);

  const previous = process.env.ADMIN_REDESIGN_UI_ENABLED;
  try {
    delete process.env.ADMIN_REDESIGN_UI_ENABLED;
    const tabs = source("components/admin-tabs.tsx");
    assert.match(tabs, /운영 홈/);
    assert.match(tabs, /\/admin\/jobs/);
    process.env.ADMIN_REDESIGN_UI_ENABLED = "true";
    assert.equal(AdminTabs({ active: "dashboard" }), null);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_REDESIGN_UI_ENABLED;
    else process.env.ADMIN_REDESIGN_UI_ENABLED = previous;
  }

  const page = source("app/admin/page.tsx");
  assert.match(page, /if \(adminRedesignUiEnabled\(\)\)[\s\S]*AdminOperationsOverview/);
  assert.match(page, /const dashboard = await getAdminDashboardData\(\)/, "legacy dashboard must remain after the flag branch");
});

test("shell navigation covers new and retained deep links with mobile keyboard behavior", () => {
  const shell = source("components/admin-shell.tsx");
  for (const href of [
    "/admin", "/admin/work", "/admin/operations", "/admin/articles", "/admin/candidates",
    "/admin/glossary-candidates", "/admin/ingestion-runs", "/admin/jobs", "/admin/audit", "/admin/llm", "/admin/analytics",
  ]) assert.match(shell, new RegExp(href.replaceAll("/", "\\/")));
  assert.match(shell, /aria-current/);
  assert.match(shell, /Skip to administrator content/);
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /min-w-0 overflow-x-clip/);
  assert.match(shell, /aria-modal="true"/);
});

test("new pages preserve authentication redirects and flag-off compatibility redirects", () => {
  for (const file of ["app/admin/work/page.tsx", "app/admin/work/[kind]/[id]/page.tsx"]) {
    const contents = source(file);
    assert.match(contents, /isAuthorizedPageRequest/);
    assert.match(contents, /\/admin\/login\?next=/);
    assert.match(contents, /if \(!adminRedesignUiEnabled\(\)\) redirect\("\/admin\/jobs"\)/);
  }
});

test("work filters are bounded, allowlisted, and URL-shareable", () => {
  const parsed = parseAdminWorkFilters({
    owner: "operator",
    stage: "publish",
    source: "de-bverfg",
    type: "outbox",
    state: "pending",
    attention: "required",
    sla: "breached",
    age: "24h",
    sort: "sla",
    page: "99999",
    pageSize: "999",
  });
  assert.equal(parsed.page, 20);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.stage, "publish");
  assert.equal(parsed.type, "outbox");
  const query = adminWorkFiltersQuery(parsed);
  assert.match(query, /owner=operator/);
  assert.match(query, /stage=publish/);
  assert.match(query, /attention=required/);
  assert.match(query, /sort=sla/);

  const invalid = parseAdminWorkFilters({ stage: "delete", type: "payload", owner: "x\u0000y", page: "-2", pageSize: "1" });
  assert.equal(invalid.stage, undefined);
  assert.equal(invalid.type, undefined);
  assert.equal(invalid.owner, undefined);
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 10);
});

test("stable sort and pagination use deterministic type/id tie breakers", () => {
  const filters = { ...DEFAULT_ADMIN_WORK_FILTERS, pageSize: 2 };
  const items = [item("c"), item("a"), item("b")];
  const sorted = filterAndSortAdminWorkItems(items, filters);
  assert.deepEqual(sorted.map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(paginateAdminWorkItems(sorted, filters).items.map((entry) => entry.id), ["a", "b"]);
  const second = paginateAdminWorkItems(sorted, { ...filters, page: 2 });
  assert.deepEqual(second.items.map((entry) => entry.id), ["c"]);
  assert.equal(second.hasMore, false);
});

test("execution, lifecycle, and publication labels remain independent", () => {
  const article = item("article", {
    type: "article",
    execution: adminStateLabel(),
    lifecycle: adminStateLabel("source_text_ready / complete / approved"),
    publication: adminStateLabel("in_review"),
  });
  assert.equal(article.execution.value, "not linked");
  assert.equal(article.lifecycle.value, "source_text_ready / complete / approved");
  assert.equal(article.publication.value, "in_review");
  assert.notEqual(article.lifecycle.tone, article.publication.tone);
  const queue = source("components/admin-work-queue.tsx");
  assert.match(queue, /Execution state/);
  assert.match(queue, /Lifecycle state/);
  assert.match(queue, /Publication state/);
});

test("operational errors redact URLs, queries, tokens, and long values", () => {
  const redacted = redactOperationalText(`failed https://court.invalid/private?id=secret token=plain-token Bearer ${"x".repeat(32)}`) ?? "";
  assert.match(redacted, /\[redacted-url\]/);
  assert.doesNotMatch(redacted, /court\.invalid|secret|plain-token|Bearer x/);
  assert((redactOperationalText("x".repeat(600)) ?? "").length <= 310);
  const detail = source("lib/admin/p4/repository.ts");
  assert.doesNotMatch(detail, /select\([^)]*(payload_ref|raw_text|cleaned_text|original_url|canonical_url|summary_json|safe_metadata)/i);
  assert.match(detail, /latestError: redactOperationalText\(text\(row, "last_error_code"\)\)/);
  assert.match(detail, /latestError: redactOperationalText\(text\(row, "error_class"\)\)/);
});

test("canonical actions require bounded reason, explicit idempotency, and publication confirmation", () => {
  assert.equal(parseAdminWorkActionBody({ action: "retry", reason: "retry after operator review", confirmation: "acknowledged", idempotencyKey: "p4.retry.123456" }).ok, true);
  assert.equal(parseAdminWorkActionBody({ action: "retry", reason: "no", confirmation: "acknowledged", idempotencyKey: "short" }).ok, false);
  assert.equal(parseAdminWorkActionBody({ action: "publish", reason: "approved after human review", confirmation: "wrong", idempotencyKey: "p4.publish.123456" }).ok, false);
  assert.equal(parseAdminWorkActionBody({ action: "withdraw", reason: "source correction is required", confirmation: "withdraw", idempotencyKey: "p4.withdraw.123456" }).ok, true);
  assert.equal(actionAllowedForKind("execution", "abort"), true);
  assert.equal(actionAllowedForKind("execution", "publish"), false);
  assert.equal(actionAllowedForKind("outbox", "retry"), false);
});

test("every P4 action shares auth and CSRF enforcement and revalidates authoritative state", () => {
  const route = source("app/api/admin/work/[kind]/[id]/route.ts");
  const readRoute = source("app/api/admin/work/route.ts");
  assert.match(readRoute, /isAuthorizedRequest\(request\)/);
  assert.match(readRoute, /parseAdminWorkFilters/);
  assert.match(readRoute, /getAdminWorkQueueSnapshot/);
  assert.match(route, /adminMutationAuthFailureStatus\(request\)/);
  assert.match(route, /source_url_candidates[\s\S]*select\("id,status"\)/);
  assert.match(route, /article_publications_p3[\s\S]*select\("article_id,state,revision,version_id"\)/);
  assert.match(route, /\["in_review", "withdrawn"\]\.includes\(currentState\)/);
  assert.match(route, /currentState !== "published"/);
  assert.match(route, /adminCommandService\.abort/);
  assert.match(route, /adminCommandService\.retry/);
  assert.match(route, /articlePublicationService\.transition/);
  assert.match(route, /status: errorStatus\(code\)/);
});

test("queue query contract is bounded and bulk-loads attempts without N+1", () => {
  assert.equal(ADMIN_WORK_QUERY_CONTRACT.perRowQueries, 0);
  assert.equal(ADMIN_WORK_QUERY_CONTRACT.maxQueueQueries, 9);
  assert.equal(ADMIN_WORK_QUERY_CONTRACT.maxRowsPerDomain, 500);
  const repository = source("lib/admin/p4/repository.ts");
  assert.match(repository, /\.in\("run_id", runIds\)/);
  assert.match(repository, /Promise\.all\(\[\s*loadExecutionItems/);
  assert.match(repository, /\.limit\(limit\)/);
});

test("desktop/mobile, loading/empty/error, focus, and overflow states are present", () => {
  const queue = source("components/admin-work-queue.tsx");
  assert.match(queue, /md:hidden/);
  assert.match(queue, /hidden overflow-x-auto md:block/);
  assert.match(queue, /No work matches these filters/);
  assert.match(queue, /table-fixed/);
  assert.match(queue, /min-w-0/);
  assert.match(source("app/admin/work/loading.tsx"), /role="status"/);
  assert.match(source("app/admin/work/error.tsx"), /role="alert"/);
  assert.match(source("app/globals.css"), /\.admin-shell \*[\s\S]*letter-spacing: 0/);
});

test("specialized article actions and immutable source snapshot protections remain reachable", () => {
  const articlePage = source("app/admin/articles/[slug]/page.tsx");
  const reviewPanel = source("components/admin-article-review-panel.tsx");
  const summaryEditor = source("components/admin-summary-editor.tsx");
  const reviewApi = source("app/api/admin/articles/[articleRef]/review/route.ts");
  assert.match(articlePage, /AdminArticleReviewPanelLoader/);
  assert.match(reviewPanel, /AdminReviewActions/);
  assert.match(reviewPanel, /AdminSummaryEditor/);
  assert.match(reviewApi, /includeSourceText: true/);
  assert.match(summaryEditor, /manual-summary|\/summary/);
  assert.match(source("app/admin/layout.tsx"), /if \(!adminRedesignUiEnabled\(\)\) return children/);
});
