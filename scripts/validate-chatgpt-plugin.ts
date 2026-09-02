import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pluginRoot = path.join(root, "plugins/worldcons-constitutional-cases");
const expectedName = "worldcons-constitutional-cases";
const expectedDisplayName = "헌법판례요약시스템";
const expectedEndpoint = "https://worldcons.vercel.app/api/mcp";

function readJson(relativePath: string) {
  const absolutePath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireFile(relativePath: string) {
  requireCondition(fs.statSync(path.join(pluginRoot, relativePath)).isFile(), `Missing plugin file: ${relativePath}`);
}

const manifest = readJson("plugins/worldcons-constitutional-cases/.codex-plugin/plugin.json");
const marketplace = readJson(".agents/plugins/marketplace.json");
const mcp = readJson("plugins/worldcons-constitutional-cases/.mcp.json");
const interfaceConfig = manifest.interface as Record<string, unknown>;
const server = (mcp.mcpServers as Record<string, Record<string, unknown>>).worldcons;
const marketplaceEntry = (marketplace.plugins as Array<Record<string, unknown>>).find(
  (entry) => entry.name === expectedName,
);

requireCondition(manifest.name === expectedName, "Plugin name must match its directory.");
requireCondition(/^\d+\.\d+\.\d+$/u.test(String(manifest.version)), "Plugin version must be strict semver.");
requireCondition(interfaceConfig.displayName === expectedDisplayName, "Canonical Korean plugin display name is required.");
requireCondition(Array.isArray(interfaceConfig.defaultPrompt) && interfaceConfig.defaultPrompt.length <= 3, "At most three starter prompts are allowed.");
requireCondition((interfaceConfig.defaultPrompt as string[]).every((prompt) => prompt.length <= 128), "Starter prompts must be at most 128 characters.");
requireCondition(server.type === "http" && server.url === expectedEndpoint, "Public plugin endpoint contract changed.");
requireCondition(!("headers" in server) && !("env" in server), "The public plugin must not require credentials.");
requireCondition(marketplaceEntry, "Marketplace entry is missing.");
requireCondition((marketplaceEntry.source as Record<string, unknown>).path === `./plugins/${expectedName}`, "Marketplace plugin path is invalid.");
requireCondition((marketplaceEntry.policy as Record<string, unknown>).installation === "AVAILABLE", "Plugin must remain installable.");

for (const assetField of ["composerIcon", "logo", "logoDark"] as const) {
  const assetPath = String(interfaceConfig[assetField]).replace(/^\.\//u, "");
  requireFile(assetPath);
}
requireFile("skills/constitutional-case-research/SKILL.md");
requireFile("skills/constitutional-case-research/references/citation-policy.md");
requireFile("skills/constitutional-case-research/references/source-coverage.md");

const serialized = JSON.stringify({ manifest, marketplace, mcp });
requireCondition(!/\[TODO:/u.test(serialized), "Plugin metadata contains a TODO placeholder.");
requireCondition(!/WORLD CONS/iu.test(serialized), "Legacy spaced English brand must not return.");

console.log(JSON.stringify({
  status: "ok",
  plugin: expectedName,
  displayName: expectedDisplayName,
  endpoint: expectedEndpoint,
  authentication: "none",
}));
