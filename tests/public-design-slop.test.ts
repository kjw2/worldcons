import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const publicDesignFiles = [
  "app/page.tsx",
  "app/search/page.tsx",
  "app/sources/page.tsx",
  "app/sources/[sourceKey]/page.tsx",
  "app/tags/page.tsx",
  "app/tags/[slug]/page.tsx",
  "app/glossary/page.tsx",
  "app/glossary/[slug]/page.tsx",
  "app/guide/page.tsx",
  "app/articles/[slug]/(detail)/page.tsx",
  "components/article-card.tsx",
  "components/article-grid.tsx",
  "components/infinite-article-feed.tsx",
  "components/navigation-progress.tsx",
  "components/public-site-header.tsx",
  "components/ui/section-heading.tsx",
  "components/ui/surface-card.tsx",
];

const publicDesignSource = publicDesignFiles.map(read).join("\n");

test("public design keeps high-confidence generated-UI slop patterns out", () => {
  assert.doesNotMatch(publicDesignSource, /archive-kicker/);
  // DESIGN.md forbids eyebrow/kicker labels, but only the archive-kicker class was
  // checked, so a SectionHeading eyebrow prop slipped past this gate.
  assert.doesNotMatch(publicDesignSource, /eyebrow/i);
  assert.doesNotMatch(publicDesignSource, /border-t-2 border-archive-accent/);
  assert.doesNotMatch(publicDesignSource, /backdrop-blur/);
  assert.doesNotMatch(publicDesignSource, /shadow-floating/);
  assert.doesNotMatch(publicDesignSource, /shadow-\[/);
  assert.doesNotMatch(publicDesignSource, /bg-gradient/);
  assert.doesNotMatch(publicDesignSource, /tracking-\[-0\.0[3-9]em\]/);
});

test("legal content surfaces prefer lists and document structure over repeated card grids", () => {
  const articleGrid = read("components/article-grid.tsx");
  const guide = read("app/guide/page.tsx");
  const detail = read("app/articles/[slug]/(detail)/page.tsx");

  assert.match(articleGrid, /border-y border-archive-line-strong bg-white/);
  assert.doesNotMatch(articleGrid, /md:grid-cols-2|xl:grid-cols-3/);
  assert.doesNotMatch(guide, /SurfaceCard|surfaceCardClassName/);
  assert.doesNotMatch(detail, /<SurfaceCard/);
});

test("navigation loading communicates state without glow glass or a floating status pill", () => {
  const progress = read("components/navigation-progress.tsx");
  assert.match(progress, /navigation-progress-bar h-full w-1\/2 bg-archive-accent/);
  assert.doesNotMatch(progress, /backdrop-blur|shadow-|rounded-full/);
  assert.doesNotMatch(progress, /top-\[calc\(var\(--chrome-header-height\)/);
});

test("DESIGN.md records the public anti-slop constraints", () => {
  const design = read("DESIGN.md");
  assert.match(design, /legal research archive/i);
  assert.match(design, /No gradients/i);
  assert.match(design, /Prefer lists, tables, definition lists/i);
  assert.match(design, /Avoid repeated same-size feature\/KPI card grids/i);
  assert.match(design, /Prefer borders and whitespace over shadows/i);
});
