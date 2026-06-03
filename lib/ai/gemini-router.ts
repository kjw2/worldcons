import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SummaryResponseJsonSchema } from "@/lib/ai/schema";
import type { LlmCompletionResult, LlmMessage } from "@/lib/ai/client";

export type GeminiTaskType =
  | "Embedding"
  | "Classify"
  | "Extract"
  | "Translate"
  | "Summarize"
  | "General"
  | "Reasoning"
  | "Vision"
  | "LongContext";

export type GeminiSelectionStrategy = "GenerationFirstStrategy" | "MaxRemainingQuotaStrategy" | "StableFirstStrategy" | "PriorityFirstStrategy";

interface GeminiModelConfig {
  model: string;
  rpd: number;
  priority: number;
  stable: boolean;
  rpm: number;
  embedding?: boolean;
}

interface GeminiRoute {
  model: string;
  apiKey: string;
  keyLabel: string;
  routeKey: string;
}

interface GeminiRouteStateEntry {
  rpdUsed: number;
  rpmTimestamps: number[];
  dailyExhausted: boolean;
  cooldownUntil: number | null;
}

interface GeminiRouterState {
  version: number;
  day: string;
  routes: Record<string, GeminiRouteStateEntry>;
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface GeminiCatalogModel {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiModelCatalog {
  version: number;
  fetchedAt: number;
  models: GeminiCatalogModel[];
}

interface GeminiListModelsResponse {
  models?: GeminiCatalogModel[];
  nextPageToken?: string;
}

interface GeminiAttemptError {
  route: string;
  status?: number;
  message: string;
  retryable: boolean;
  tryNextRoute: boolean;
}

const STATE_VERSION = 1;
const MODEL_CATALOG_VERSION = 1;
const DEFAULT_RPM = 60;
const LONG_CONTEXT_CHARS = 100_000;
const COOLDOWN_SECONDS = 60;
const UNAVAILABLE_COOLDOWN_SECONDS = 24 * 60 * 60;
const DEFAULT_MODEL_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
const MODEL_CATALOG_RETRY_AFTER_MS = 5 * 60 * 1000;
const RECOVERABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const ROUTE_UNAVAILABLE_HTTP_STATUSES = new Set([404]);
const CREDENTIAL_HTTP_STATUSES = new Set([401, 403]);
const ROUTE_UNAVAILABLE_400_MARKERS = ["not found", "not supported", "unsupported", "not available"];
const DAILY_QUOTA_MARKERS = ["perday", "per day", "requests per day", "generaterequestsperday", "embedcontentrequestsperday"];
const MINUTE_QUOTA_MARKERS = ["perminute", "per minute", "requests per minute", "generaterequestsperminute", "embedcontentrequestsperminute"];
const GEMINI_3_MODELS = ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-3-flash-preview", "gemini-3.1-pro-preview"];
const GEMINI_25_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"];
const GEMINI_2_MODELS = ["gemini-2.0-flash-lite", "gemini-2.0-flash"];
const DEFAULT_TEXT_MODELS = [...GEMINI_3_MODELS, ...GEMINI_25_MODELS, ...GEMINI_2_MODELS];

const MODEL_CONFIGS: Record<string, GeminiModelConfig> = {
  "gemini-3.1-flash-lite": { model: "gemini-3.1-flash-lite", rpd: 200, priority: 10, stable: true, rpm: DEFAULT_RPM },
  "gemini-3.1-flash-lite-preview": { model: "gemini-3.1-flash-lite-preview", rpd: 200, priority: 11, stable: false, rpm: DEFAULT_RPM },
  "gemini-3-flash-preview": { model: "gemini-3-flash-preview", rpd: 100, priority: 20, stable: false, rpm: DEFAULT_RPM },
  "gemini-3.1-pro-preview": { model: "gemini-3.1-pro-preview", rpd: 50, priority: 30, stable: false, rpm: DEFAULT_RPM },
  "gemini-2.5-flash-lite": { model: "gemini-2.5-flash-lite", rpd: 1000, priority: 40, stable: true, rpm: DEFAULT_RPM },
  "gemini-2.5-flash": { model: "gemini-2.5-flash", rpd: 250, priority: 50, stable: true, rpm: DEFAULT_RPM },
  "gemini-2.5-pro": { model: "gemini-2.5-pro", rpd: 100, priority: 60, stable: true, rpm: DEFAULT_RPM },
  "gemini-2.0-flash-lite": { model: "gemini-2.0-flash-lite", rpd: 200, priority: 69, stable: true, rpm: DEFAULT_RPM },
  "gemini-2.0-flash": { model: "gemini-2.0-flash", rpd: 200, priority: 70, stable: true, rpm: DEFAULT_RPM },
  "gemini-embedding-001": { model: "gemini-embedding-001", rpd: 1000, priority: 80, stable: true, rpm: DEFAULT_RPM, embedding: true },
};

const TASK_CANDIDATES: Record<GeminiTaskType, string[]> = {
  Embedding: ["gemini-embedding-001"],
  Classify: DEFAULT_TEXT_MODELS,
  Extract: DEFAULT_TEXT_MODELS,
  Translate: DEFAULT_TEXT_MODELS,
  Summarize: DEFAULT_TEXT_MODELS,
  General: DEFAULT_TEXT_MODELS,
  Reasoning: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  Vision: ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  LongContext: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
};

let lastModelCatalogRefreshFailureAt = 0;
let modelCatalogRefreshPromise: Promise<GeminiModelCatalog | null> | null = null;
let memoryModelCatalogPath: string | null = null;
let memoryModelCatalog: GeminiModelCatalog | null = null;
let memoryRouterStatePath: string | null = null;
let memoryRouterState: GeminiRouterState | null = null;

function parseCsvEnv(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function hasAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function autoDiscoverGeminiModels() {
  return process.env.GEMINI_AUTO_DISCOVER_MODELS !== "false";
}

function modelCatalogTtlMs() {
  const value = Number(process.env.GEMINI_MODEL_CATALOG_TTL_MS ?? DEFAULT_MODEL_CATALOG_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MODEL_CATALOG_TTL_MS;
}

function defaultCacheDir() {
  const explicitCacheDir = process.env.GEMINI_CACHE_DIR?.trim();
  if (explicitCacheDir) return path.resolve(process.cwd(), explicitCacheDir);
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) return path.join(os.tmpdir(), "worldcons");
  return path.resolve(process.cwd(), ".cache");
}

function resolveStoragePath(explicitPath: string | undefined, defaultFileName: string) {
  const trimmed = explicitPath?.trim();
  if (trimmed) return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  return path.join(defaultCacheDir(), defaultFileName);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function modelCatalogPath() {
  return resolveStoragePath(process.env.GEMINI_MODEL_CATALOG_PATH, "gemini-model-catalog.json");
}

function loadModelCatalog(): GeminiModelCatalog | null {
  if (!autoDiscoverGeminiModels()) return null;

  const filePath = modelCatalogPath();
  const data = readJsonFile<GeminiModelCatalog>(filePath) ?? (memoryModelCatalogPath === filePath ? memoryModelCatalog : null);
  if (data) {
    if (data.version !== MODEL_CATALOG_VERSION || !Array.isArray(data.models) || !Number.isFinite(data.fetchedAt)) return null;
    return data;
  }
  return null;
}

function saveModelCatalog(catalog: GeminiModelCatalog) {
  memoryModelCatalogPath = modelCatalogPath();
  memoryModelCatalog = catalog;
  writeJsonFile(memoryModelCatalogPath, catalog);
}

function normalizeCatalogModelName(model: GeminiCatalogModel) {
  return (model.baseModelId || model.name || "").replace(/^models\//, "").trim();
}

function supportsGenerationMethod(model: GeminiCatalogModel, method: string) {
  return model.supportedGenerationMethods?.some((item) => item.toLowerCase() === method.toLowerCase()) ?? false;
}

function isTextGenerationModel(model: string) {
  const lowered = model.toLowerCase();
  return (
    lowered.startsWith("gemini-") &&
    !hasAny(lowered, [
      "embedding",
      "imagen",
      "veo",
      "lyria",
      "robotics",
      "tts",
      "live",
      "audio",
      "image",
      "banana",
      "computer-use",
      "deep-research",
    ])
  );
}

function modelGenerationValue(model: string) {
  const match = model.match(/^gemini-(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function modelStabilityRank(model: string) {
  const lowered = model.toLowerCase();
  if (lowered.endsWith("-latest")) return 1;
  if (lowered.includes("preview")) return 2;
  if (hasAny(lowered, ["experimental", "-exp"])) return 3;
  return 0;
}

function modelVariantRank(model: string, taskType: GeminiTaskType) {
  const lowered = model.toLowerCase();
  const proRank = lowered.includes("pro") ? 0 : lowered.includes("flash") ? 1 : 2;
  const flashRank = lowered.includes("flash") && !lowered.includes("flash-lite") ? 0 : lowered.includes("pro") ? 1 : 2;
  const liteRank = lowered.includes("flash-lite") ? 0 : lowered.includes("flash") ? 1 : lowered.includes("pro") ? 2 : 3;

  if (taskType === "Reasoning" || taskType === "LongContext") return proRank;
  if (taskType === "Vision") return flashRank;
  return liteRank;
}

function sortModelsForTask(models: string[], taskType: GeminiTaskType) {
  return [...models].sort((a, b) => {
    return (
      modelVariantRank(a, taskType) - modelVariantRank(b, taskType) ||
      modelStabilityRank(a) - modelStabilityRank(b) ||
      modelGenerationValue(b) - modelGenerationValue(a) ||
      a.localeCompare(b)
    );
  });
}

function discoveredTextModels(taskType: GeminiTaskType) {
  const catalog = loadModelCatalog();
  if (!catalog) return [];

  const models = catalog.models
    .filter((model) => supportsGenerationMethod(model, "generateContent"))
    .map(normalizeCatalogModelName)
    .filter(Boolean)
    .filter(isTextGenerationModel);

  return sortModelsForTask(unique(models), taskType);
}

async function fetchGeminiModelCatalog(apiKey: string): Promise<GeminiModelCatalog> {
  const timeoutMs = Number(process.env.GEMINI_MODEL_DISCOVERY_TIMEOUT_MS ?? 10_000);
  const models: GeminiCatalogModel[] = [];
  let pageToken = "";

  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Gemini model catalog failed: ${response.status} ${redact(responseText, 300)}`);

    const data = responseText ? (JSON.parse(responseText) as GeminiListModelsResponse) : {};
    models.push(...(data.models ?? []));
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }

  return { version: MODEL_CATALOG_VERSION, fetchedAt: Date.now(), models };
}

export async function refreshGeminiModelCatalog(force = false, options: GeminiRouteOptions = {}) {
  if (!autoDiscoverGeminiModels()) return null;

  const cached = loadModelCatalog();
  const isFresh = cached ? Date.now() - cached.fetchedAt < modelCatalogTtlMs() : false;
  if (!force && isFresh) return cached;
  if (!force && Date.now() - lastModelCatalogRefreshFailureAt < MODEL_CATALOG_RETRY_AFTER_MS) return cached;

  const apiKey = getGeminiApiKeys(options)[0];
  if (!apiKey) return cached;

  if (!modelCatalogRefreshPromise) {
    modelCatalogRefreshPromise = fetchGeminiModelCatalog(apiKey)
      .then((catalog) => {
        saveModelCatalog(catalog);
        return catalog;
      })
      .catch(() => {
        lastModelCatalogRefreshFailureAt = Date.now();
        return cached;
      })
      .finally(() => {
        modelCatalogRefreshPromise = null;
      });
  }

  return modelCatalogRefreshPromise;
}

function looksLikeVisionTask(text: string, lowered: string) {
  return (
    /\b(images?|vision|photos?|pictures?|diagrams?|charts?)\b/i.test(text) ||
    hasAny(lowered, ["이미지", "사진", "도표"])
  );
}

export function analyzeGeminiTaskType(messages: LlmMessage[]): GeminiTaskType {
  const text = messages.map((message) => message.content).join("\n");
  const lowered = text.toLowerCase();

  if (text.length >= LONG_CONTEXT_CHARS) return "LongContext";
  if (looksLikeVisionTask(text, lowered)) return "Vision";
  if (hasAny(lowered, ["분류", "classify", "category", "카테고리"])) return "Classify";
  if (hasAny(lowered, ["요약", "summarize", "summary"])) return "Summarize";
  if (hasAny(lowered, ["추출", "extract", "json", "필드", "파싱"])) return "Extract";
  if (hasAny(lowered, ["번역", "translate", "translation"])) return "Translate";
  if (hasAny(lowered, ["추론", "reason", "쟁점", "판단", "분석", "논증", "법리", "위헌"])) return "Reasoning";
  return "General";
}

interface GeminiRouteOptions {
  model?: string;
  models?: string[];
  apiKeys?: string[];
  selectionStrategy?: GeminiSelectionStrategy;
}

export function getGeminiModels(taskType: GeminiTaskType = "Summarize", options: GeminiRouteOptions = {}) {
  const explicitModel = options.model?.trim();
  if (explicitModel) return [explicitModel];
  if (options.models?.length) return unique(options.models.map((model) => model.trim()).filter(Boolean));

  const pinnedModel = process.env.GEMINI_PINNED_MODEL?.trim();
  if (pinnedModel) return [pinnedModel];

  const allowModelOverride = process.env.GEMINI_ALLOW_MODEL_OVERRIDE === "true";
  const explicitModels = parseCsvEnv(process.env.GEMINI_SUMMARY_MODELS);
  const primaryModel = process.env.GEMINI_SUMMARY_MODEL?.trim();
  const fallbackModels = TASK_CANDIDATES[taskType] ?? TASK_CANDIDATES.General;
  const discoveredModels = taskType === "Embedding" ? [] : discoveredTextModels(taskType);
  const taskModels = discoveredModels.length > 0 ? unique([...discoveredModels, ...fallbackModels.filter((model) => discoveredModels.includes(model))]) : fallbackModels;

  if (allowModelOverride && explicitModels.length > 0) return unique(explicitModels);
  if (allowModelOverride && primaryModel) return unique([primaryModel, ...taskModels]);
  return unique(taskModels);
}

export function getGeminiApiKeys(options: GeminiRouteOptions = {}) {
  const keys = options.apiKeys?.length
    ? options.apiKeys
    : ([...parseCsvEnv(process.env.GEMINI_API_KEYS), process.env.GEMINI_API_KEY?.trim()].filter(Boolean) as string[]);
  return unique(keys);
}

function getSelectionStrategy(options: GeminiRouteOptions = {}): GeminiSelectionStrategy {
  const value = options.selectionStrategy ?? process.env.GEMINI_SELECTION_STRATEGY;
  if (value === "StableFirstStrategy" || value === "PriorityFirstStrategy" || value === "MaxRemainingQuotaStrategy") return value;
  return "GenerationFirstStrategy";
}

function statePath() {
  return resolveStoragePath(process.env.GEMINI_ROUTER_STATE_PATH, "gemini-router-state.json");
}

function pacificDay() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function emptyState(): GeminiRouterState {
  return { version: STATE_VERSION, day: pacificDay(), routes: {} };
}

function loadState(): GeminiRouterState {
  const filePath = statePath();
  const data = readJsonFile<GeminiRouterState>(filePath) ?? (memoryRouterStatePath === filePath ? memoryRouterState : null);

  if (data) {
    if (data.version !== STATE_VERSION || data.day !== pacificDay() || typeof data.routes !== "object") {
      return emptyState();
    }
    return data;
  }
  return emptyState();
}

function saveState(state: GeminiRouterState) {
  const filePath = statePath();
  memoryRouterStatePath = filePath;
  memoryRouterState = state;
  writeJsonFile(filePath, state);
}

function configForModel(model: string): GeminiModelConfig {
  return MODEL_CONFIGS[model] ?? { model, rpd: Number(process.env.GEMINI_UNKNOWN_MODEL_RPD ?? 100), priority: 999, stable: false, rpm: DEFAULT_RPM };
}

function generationRank(model: string) {
  const generation = modelGenerationValue(model);
  return generation > 0 ? -generation : 9;
}

function entryForRoute(state: GeminiRouterState, route: GeminiRoute) {
  const entry = state.routes[route.routeKey] ?? {
    rpdUsed: 0,
    rpmTimestamps: [],
    dailyExhausted: false,
    cooldownUntil: null,
  };
  state.routes[route.routeKey] = entry;
  return entry;
}

function trimRpm(entry: GeminiRouteStateEntry) {
  const cutoff = Date.now() / 1000 - 60;
  entry.rpmTimestamps = entry.rpmTimestamps.filter((item) => Number.isFinite(item) && item >= cutoff);
}

function enforceLocalRpdLimit() {
  return process.env.GEMINI_ENFORCE_LOCAL_RPD_LIMITS === "true";
}

function remainingRpd(state: GeminiRouterState, route: GeminiRoute) {
  const entry = entryForRoute(state, route);
  const remaining = configForModel(route.model).rpd - entry.rpdUsed;
  return enforceLocalRpdLimit() ? Math.max(0, remaining) : Math.max(1, remaining);
}

function remainingRpm(state: GeminiRouterState, route: GeminiRoute) {
  const entry = entryForRoute(state, route);
  trimRpm(entry);
  return Math.max(0, configForModel(route.model).rpm - entry.rpmTimestamps.length);
}

function routeUnavailableReason(state: GeminiRouterState, route: GeminiRoute) {
  const entry = entryForRoute(state, route);
  const config = configForModel(route.model);
  trimRpm(entry);
  if (entry.dailyExhausted) return "daily quota marker from a Gemini 429 response";
  if (enforceLocalRpdLimit() && entry.rpdUsed >= config.rpd) return `local RPD guard ${entry.rpdUsed}/${config.rpd}`;
  if (entry.cooldownUntil && Date.now() / 1000 < entry.cooldownUntil) {
    return `cooldown until ${new Date(entry.cooldownUntil * 1000).toISOString()}`;
  }
  if (remainingRpm(state, route) <= 0) return `local RPM window ${entry.rpmTimestamps.length}/${config.rpm}`;
  return null;
}

function isRouteAvailable(state: GeminiRouterState, route: GeminiRoute) {
  return routeUnavailableReason(state, route) === null;
}

function buildGeminiRoutes(taskType: GeminiTaskType, options: GeminiRouteOptions = {}) {
  const keys = getGeminiApiKeys(options);
  const models = getGeminiModels(taskType, options);
  return models.flatMap((model) =>
    keys.map((apiKey, index) => ({
      model,
      apiKey,
      keyLabel: `key-${index + 1}`,
      routeKey: `${model}::key-${index + 1}`,
    })),
  );
}

function unavailableRoutesMessage(taskType: GeminiTaskType, options: GeminiRouteOptions = {}) {
  const keys = getGeminiApiKeys(options);
  if (keys.length === 0) return "No Gemini API key is configured.";

  const state = loadState();
  const routes = buildGeminiRoutes(taskType, options);
  const reasons = routes
    .map((route) => {
      const reason = routeUnavailableReason(state, route);
      return reason ? `${routeLabel(route)}: ${reason}` : null;
    })
    .filter(Boolean)
    .slice(0, 10);
  const suffix = reasons.length > 0 ? ` Reasons: ${reasons.join("; ")}${routes.length > reasons.length ? "; ..." : ""}` : "";

  return `No Gemini routes are locally available for ${taskType}. This is router state, not proof that the Gemini free quota is exhausted.${suffix}`;
}

export function getGeminiRoutes(taskType: GeminiTaskType = "Summarize", options: GeminiRouteOptions = {}) {
  const models = getGeminiModels(taskType, options);
  const state = loadState();
  const routes = buildGeminiRoutes(taskType, options);
  const available = routes.filter((route) => isRouteAvailable(state, route));
  const strategy = getSelectionStrategy(options);
  const modelOrder = new Map(models.map((model, index) => [model, index]));

  if (strategy === "PriorityFirstStrategy") {
    return available.sort((a, b) => (modelOrder.get(a.model) ?? 999) - (modelOrder.get(b.model) ?? 999));
  }

  if (strategy === "GenerationFirstStrategy") {
    return available.sort((a, b) => {
      return (
        generationRank(a.model) - generationRank(b.model) ||
        remainingRpd(state, b) - remainingRpd(state, a) ||
        remainingRpm(state, b) - remainingRpm(state, a) ||
        configForModel(a.model).priority - configForModel(b.model).priority ||
        (modelOrder.get(a.model) ?? 999) - (modelOrder.get(b.model) ?? 999)
      );
    });
  }

  if (strategy === "StableFirstStrategy") {
    return available.sort((a, b) => {
      const aConfig = configForModel(a.model);
      const bConfig = configForModel(b.model);
      return Number(!aConfig.stable) - Number(!bConfig.stable) || (modelOrder.get(a.model) ?? 999) - (modelOrder.get(b.model) ?? 999);
    });
  }

  return available.sort((a, b) => {
    return (
      remainingRpd(state, b) - remainingRpd(state, a) ||
      remainingRpm(state, b) - remainingRpm(state, a) ||
      (modelOrder.get(a.model) ?? 999) - (modelOrder.get(b.model) ?? 999)
    );
  });
}

function recordSuccess(route: GeminiRoute) {
  const state = loadState();
  const entry = entryForRoute(state, route);
  entry.rpdUsed += 1;
  entry.rpmTimestamps.push(Date.now() / 1000);
  trimRpm(entry);
  saveState(state);
}

function record429(route: GeminiRoute, responseText: string) {
  const state = loadState();
  const entry = entryForRoute(state, route);
  const lowered = responseText.toLowerCase();
  trimRpm(entry);

  const retryMatch = lowered.match(/retry\s+in\s+([0-9.]+)s/);
  const retryAfterSeconds = retryMatch ? Math.ceil(Number(retryMatch[1])) : null;

  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    entry.cooldownUntil = Date.now() / 1000 + Math.max(retryAfterSeconds, COOLDOWN_SECONDS);
  } else if (entry.rpmTimestamps.length >= configForModel(route.model).rpm || hasAny(lowered, MINUTE_QUOTA_MARKERS)) {
    entry.cooldownUntil = Date.now() / 1000 + COOLDOWN_SECONDS;
  } else if (hasAny(lowered, DAILY_QUOTA_MARKERS)) {
    entry.dailyExhausted = true;
  } else {
    entry.cooldownUntil = Date.now() / 1000 + COOLDOWN_SECONDS;
  }

  saveState(state);
}

function recordCooldown(route: GeminiRoute, seconds = COOLDOWN_SECONDS) {
  const state = loadState();
  const entry = entryForRoute(state, route);
  entry.cooldownUntil = Date.now() / 1000 + seconds;
  saveState(state);
}

function retryableStatus(status: number) {
  return status === 429 || RECOVERABLE_HTTP_STATUSES.has(status);
}

function shouldTryNextRoute(status: number) {
  return !CREDENTIAL_HTTP_STATUSES.has(status);
}

function isRouteUnavailableHttpError(status: number, responseText: string) {
  if (ROUTE_UNAVAILABLE_HTTP_STATUSES.has(status)) return true;
  return status === 400 && hasAny(responseText.toLowerCase(), ROUTE_UNAVAILABLE_400_MARKERS);
}

function redact(text: string, limit = 500) {
  return text
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1***")
    .replace(/(key=)[^&\s]+/gi, "$1***")
    .slice(0, limit);
}

function textFromGeminiResponse(data: GeminiApiResponse) {
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("")?.trim();
}

function routeLabel(route: GeminiRoute) {
  return `${route.model}/${route.keyLabel}`;
}

function buildGeminiPayload(messages: LlmMessage[]) {
  const systemPrompt = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const userPrompt = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n");

  return {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: SummaryResponseJsonSchema,
      temperature: Number(process.env.GEMINI_TEMPERATURE ?? 0.2),
    },
  };
}

async function callGeminiRoute(route: GeminiRoute, messages: LlmMessage[]) {
  const timeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? 30_000);
  let response: Response;

  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": route.apiKey,
      },
      body: JSON.stringify(buildGeminiPayload(messages)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    recordCooldown(route);
    const message = error instanceof Error ? error.message : String(error);
    const retryableError = new Error(`Gemini route ${routeLabel(route)} transport/timeout failure: ${redact(message, 200)}`) as Error & {
      retryable?: boolean;
      tryNextRoute?: boolean;
    };
    retryableError.retryable = true;
    retryableError.tryNextRoute = true;
    throw retryableError;
  }

  const responseText = await response.text();
  let data: GeminiApiResponse | null = null;
  try {
    data = responseText ? (JSON.parse(responseText) as GeminiApiResponse) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 429) {
      record429(route, responseText);
    } else if (isRouteUnavailableHttpError(response.status, responseText)) {
      recordCooldown(route, UNAVAILABLE_COOLDOWN_SECONDS);
    } else if (RECOVERABLE_HTTP_STATUSES.has(response.status)) {
      recordCooldown(route, COOLDOWN_SECONDS);
    }

    const apiMessage = data?.error?.message ?? responseText;
    const error = new Error(`Gemini route ${routeLabel(route)} failed: ${response.status} ${redact(apiMessage)}`) as Error & {
      status?: number;
      retryable?: boolean;
      tryNextRoute?: boolean;
    };
    error.status = response.status;
    error.retryable = retryableStatus(response.status);
    error.tryNextRoute = shouldTryNextRoute(response.status);
    throw error;
  }

  const text = data ? textFromGeminiResponse(data) : "";
  if (!text) {
    recordCooldown(route);
    const finishReason = data?.candidates?.[0]?.finishReason;
    const error = new Error(`Gemini route ${routeLabel(route)} returned empty text${finishReason ? ` (${finishReason})` : ""}.`) as Error & {
      retryable?: boolean;
      tryNextRoute?: boolean;
    };
    error.retryable = true;
    error.tryNextRoute = true;
    throw error;
  }

  recordSuccess(route);
  return text;
}

export async function completeGeminiJson(messages: LlmMessage[], options: GeminiRouteOptions = {}): Promise<LlmCompletionResult | null> {
  const taskType = (process.env.GEMINI_TASK_TYPE?.trim() as GeminiTaskType | undefined) || analyzeGeminiTaskType(messages);
  await refreshGeminiModelCatalog(false, options);
  const routes = getGeminiRoutes(taskType, options);
  if (routes.length === 0) {
    if (getGeminiApiKeys(options).length === 0 && process.env.NODE_ENV !== "production") {
      return null;
    }

    throw new Error(unavailableRoutesMessage(taskType, options));
  }

  const attempts: GeminiAttemptError[] = [];

  for (const route of routes) {
    try {
      return {
        content: await callGeminiRoute(route, messages),
        provider: "gemini",
        model: route.model,
      };
    } catch (error) {
      const typedError = error as Error & { status?: number; retryable?: boolean; tryNextRoute?: boolean };
      const retryable = Boolean(typedError.retryable);
      const tryNextRoute = typedError.tryNextRoute ?? retryable;
      attempts.push({
        route: routeLabel(route),
        status: typedError.status,
        message: typedError.message,
        retryable,
        tryNextRoute,
      });

      if (!tryNextRoute) break;
    }
  }

  throw new Error(`All Gemini routes failed: ${JSON.stringify(attempts)}`);
}
