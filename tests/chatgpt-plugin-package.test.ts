import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const pluginRoot = path.join(root, "plugins/worldcons-constitutional-cases");

function json(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("ChatGPT plugin package keeps the canonical identity and no-auth endpoint", () => {
  const manifest = json("plugins/worldcons-constitutional-cases/.codex-plugin/plugin.json");
  const mcp = json("plugins/worldcons-constitutional-cases/.mcp.json");

  assert.equal(manifest.name, "worldcons-constitutional-cases");
  assert.equal(manifest.interface.displayName, "헌법판례요약시스템");
  assert.equal(manifest.homepage, "https://worldcons.vercel.app/guide/chatgpt-plugin");
  assert.deepEqual(mcp, {
    mcpServers: {
      worldcons: {
        type: "http",
        url: "https://worldcons.vercel.app/api/mcp",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(manifest), /WORLD CONS/iu);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  assert.ok(manifest.interface.defaultPrompt.every((prompt: string) => prompt.length <= 128));
});

test("plugin assets, research skill, and repo marketplace entry are complete", () => {
  const manifest = json("plugins/worldcons-constitutional-cases/.codex-plugin/plugin.json");
  const marketplace = json(".agents/plugins/marketplace.json");
  const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === manifest.name);

  assert.equal(marketplace.interface.displayName, "헌법판례요약시스템");
  assert.equal(entry.source.path, "./plugins/worldcons-constitutional-cases");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.category, "Research");

  for (const relativePath of [
    manifest.interface.composerIcon,
    manifest.interface.logo,
    manifest.interface.logoDark,
    "./skills/constitutional-case-research/SKILL.md",
    "./skills/constitutional-case-research/references/citation-policy.md",
    "./skills/constitutional-case-research/references/source-coverage.md",
  ]) {
    assert.equal(fs.statSync(path.join(pluginRoot, relativePath)).isFile(), true, relativePath);
  }
});
