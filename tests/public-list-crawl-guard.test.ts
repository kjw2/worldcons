import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { paginationControls } from "../lib/navigation/pagination";

test("pagination controls never emit a target at either boundary", () => {
  assert.deepEqual(paginationControls(1, 3), {
    previousPage: null,
    nextPage: 2,
    pages: [1, 2, 3],
  });
  assert.deepEqual(paginationControls(3, 3), {
    previousPage: 2,
    nextPage: null,
    pages: [1, 2, 3],
  });
  assert.deepEqual(paginationControls(2, 3), {
    previousPage: 1,
    nextPage: 3,
    pages: [1, 2, 3],
  });
});

test("a requested page past the end still links only to real pages", () => {
  const controls = paginationControls(550, 3);
  assert.equal(controls.previousPage, 3, "previous must clamp back to the last real page");
  assert.equal(controls.nextPage, null, "there is no next link at the end");
  assert.ok(controls.pages.length > 0);
  assert.ok(controls.pages.every((page) => page >= 1 && page <= 3));
});

test("disabled list pagination controls render non-links without href or prefetch", () => {
  const component = readFileSync(new URL("../components/article-list-view.tsx", import.meta.url), "utf8");
  assert.match(component, /if \(!href\) return <span aria-disabled="true"/u);
  assert.match(component, /return <IntentPrefetchLink href=\{href\} className=\{className\}>/u);
  assert.match(component, /<PaginationControl href=\{previousHref\}>/u);
  assert.match(component, /<PaginationControl href=\{nextHref\}>/u);
  assert.doesNotMatch(component, /href=\{hrefForPage\(paramsString, page - 1\)\}/u);
  assert.doesNotMatch(component, /href=\{hrefForPage\(paramsString, page \+ 1\)\}/u);
  assert.doesNotMatch(component, /pointer-events-none/u);
});

test("the list page proves tag out-of-range before any expensive list read", () => {
  const page = readFileSync(new URL("../app/list/page.tsx", import.meta.url), "utf8");
  const preflight = page.indexOf("tagHasMembershipAtOffset(filters.tag");
  const expensiveReads = page.indexOf("return Promise.all([");
  assert.ok(preflight > 0, "tag-filtered page>1 must run the membership preflight");
  assert.ok(expensiveReads > preflight, "the preflight must precede article/filter/popular reads");
  assert.match(page, /if \(pageHasMembership === false\) notFound\(\);/u);
  assert.match(page, /articles\.items\.length === 0\s*\?\s*0/u);
});
