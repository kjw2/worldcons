import { crawlUrl } from "@/lib/crawler/http-client";
import { crawlerUserAgent } from "@/lib/crawler/user-agents";

export interface RobotsResult {
  robotsUrl: string;
  status: number;
  allowed: boolean;
  matchedRule?: string;
  matchedDirective?: "allow" | "disallow";
  matchedUserAgent?: string;
  crawlDelaySeconds?: number;
  sitemapUrls: string[];
  userAgent: string;
  errorMessage?: string;
}

interface RobotsDocument {
  robotsUrl: string;
  status: number;
  text: string;
  sitemapUrls: string[];
  errorMessage?: string;
}

type RobotsRule = {
  directive: "allow" | "disallow";
  pattern: string;
  order: number;
};

type RobotsGroup = {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
};

const robotsCache = new Map<string, Promise<RobotsDocument>>();

function parseCrawlDelay(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeRulePattern(pattern: string) {
  return pattern.trim();
}

function robotsTarget(url: string) {
  const parsed = new URL(url);
  return `${parsed.pathname || "/"}${parsed.search || ""}`;
}

function ruleRegex(pattern: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

function ruleMatchLength(pattern: string) {
  return pattern.replace(/\$$/, "").replace(/\*/g, "").length;
}

function agentMatches(userAgent: string, token: string) {
  const normalizedToken = token.trim().toLowerCase();
  if (!normalizedToken) return false;
  if (normalizedToken === "*") return true;
  return userAgent.toLowerCase().includes(normalizedToken);
}

function parseRobotsGroups(text: string) {
  const groups: RobotsGroup[] = [];
  const sitemapUrls: string[] = [];
  let current: RobotsGroup | null = null;
  let currentHasRules = false;
  let order = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "sitemap" && value) {
      sitemapUrls.push(value);
      continue;
    }

    if (key === "user-agent") {
      if (!current || currentHasRules) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        currentHasRules = false;
      }
      if (value) current.userAgents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;

    if (key === "allow" || key === "disallow") {
      currentHasRules = true;
      const pattern = normalizeRulePattern(value);
      if (!pattern && key === "disallow") continue;
      current.rules.push({ directive: key, pattern, order: order++ });
      continue;
    }

    if (key === "crawl-delay") {
      currentHasRules = true;
      current.crawlDelaySeconds = parseCrawlDelay(value);
    }
  }

  return { groups, sitemapUrls };
}

function matchingGroups(groups: RobotsGroup[], userAgent: string) {
  const matched = groups
    .map((group) => {
      const matchedAgents = group.userAgents.filter((agent) => agentMatches(userAgent, agent));
      const score = matchedAgents.reduce((best, agent) => Math.max(best, agent === "*" ? 0 : agent.length), -1);
      return { group, matchedAgents, score };
    })
    .filter((match) => match.score >= 0);

  if (matched.length === 0) return [];
  const bestScore = Math.max(...matched.map((match) => match.score));
  return matched.filter((match) => match.score === bestScore);
}

export function parseRobotsTxt(text: string, url: string, userAgent = crawlerUserAgent()): RobotsResult {
  const parsedUrl = new URL(url);
  const robotsUrl = `${parsedUrl.origin}/robots.txt`;
  const { groups, sitemapUrls } = parseRobotsGroups(text);
  const matches = matchingGroups(groups, userAgent);
  const target = robotsTarget(url);
  const rules = matches.flatMap((match) => match.group.rules);
  const matchingRules = rules
    .filter((rule) => rule.pattern === "" || ruleRegex(rule.pattern).test(target))
    .sort((a, b) => {
      const lengthDiff = ruleMatchLength(b.pattern) - ruleMatchLength(a.pattern);
      if (lengthDiff !== 0) return lengthDiff;
      if (a.directive !== b.directive) return a.directive === "allow" ? -1 : 1;
      return a.order - b.order;
    });
  const winner = matchingRules[0];
  const matchedUserAgent = matches
    .flatMap((match) => match.matchedAgents)
    .sort((a, b) => b.length - a.length)[0];
  const crawlDelaySeconds = matches
    .map((match) => match.group.crawlDelaySeconds)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => b - a)[0];

  return {
    robotsUrl,
    status: 200,
    allowed: winner?.directive !== "disallow",
    matchedRule: winner?.pattern,
    matchedDirective: winner?.directive,
    matchedUserAgent,
    crawlDelaySeconds,
    sitemapUrls,
    userAgent,
  };
}

export function robotsDelayMs(robots: Pick<RobotsResult, "crawlDelaySeconds"> | null | undefined, defaultDelayMs = Number(process.env.CRAWLER_DELAY_MS ?? 2000)) {
  const robotsDelayMs = robots?.crawlDelaySeconds === undefined ? 0 : Math.max(1000, robots.crawlDelaySeconds * 1000);
  return Math.max(defaultDelayMs, robotsDelayMs);
}

export async function checkRobotsAllowed(url: string): Promise<RobotsResult> {
  const userAgent = crawlerUserAgent();
  if (process.env.CRAWLER_ROBOTS_ENABLED === "false") {
    return { robotsUrl: "", status: 0, allowed: true, sitemapUrls: [], userAgent };
  }

  const parsedUrl = new URL(url);
  const robotsUrl = `${parsedUrl.origin}/robots.txt`;
  const cached =
    robotsCache.get(robotsUrl) ??
    crawlUrl({ url: robotsUrl, timeoutMs: Math.min(Number(process.env.CRAWLER_TIMEOUT_MS ?? 30_000), 10_000) }).then((response) => {
      if (response.status >= 400 || !response.text) {
        return {
          robotsUrl,
          status: response.status,
          text: "",
          sitemapUrls: [],
          errorMessage: response.diagnostics?.errorMessage,
        };
      }

      const parsed = parseRobotsTxt(response.text, url, userAgent);
      return { robotsUrl, status: response.status, text: response.text, sitemapUrls: parsed.sitemapUrls };
    });

  robotsCache.set(robotsUrl, cached);
  const robots = await cached;
  if (robots.status >= 400 || robots.status === 0) {
    return {
      robotsUrl,
      status: robots.status,
      allowed: true,
      sitemapUrls: robots.sitemapUrls,
      userAgent,
      errorMessage: robots.errorMessage,
    };
  }

  const parsed = parseRobotsTxt(robots.text, url, userAgent);
  return { ...parsed, status: robots.status };
}

export async function getRobotsSitemaps(baseUrl: string) {
  const robots = await checkRobotsAllowed(baseUrl);
  return robots.sitemapUrls;
}
