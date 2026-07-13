import {
  ADMIN_WORK_AGES,
  ADMIN_WORK_ATTENTION,
  ADMIN_WORK_SLA,
  ADMIN_WORK_SCOPES,
  ADMIN_WORK_SORTS,
  ADMIN_WORK_STAGES,
  ADMIN_WORK_TYPES,
  type AdminWorkFilters,
} from "@/lib/admin/p4/types";
import type { SearchParams } from "@/lib/utils/search-params";

const SAFE_TEXT = /^[\p{L}\p{N}._:@/ -]+$/u;

export const DEFAULT_ADMIN_WORK_FILTERS: AdminWorkFilters = {
  scope: "all",
  attention: "all",
  sla: "all",
  age: "all",
  sort: "newest",
  page: 1,
  pageSize: 25,
};

function first(params: SearchParams, key: string) {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

function boundedText(value: string | undefined, max: number) {
  return value && value.length <= max && SAFE_TEXT.test(value) ? value : undefined;
}

function oneOf<T extends readonly string[]>(value: string | undefined, values: T, fallback?: T[number]) {
  return values.includes(value as T[number]) ? value as T[number] : fallback;
}

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function parseAdminWorkFilters(params: SearchParams): AdminWorkFilters {
  return {
    scope: oneOf(first(params, "scope"), ADMIN_WORK_SCOPES, "all") ?? "all",
    owner: boundedText(first(params, "owner"), 160),
    stage: oneOf(first(params, "stage"), ADMIN_WORK_STAGES),
    source: boundedText(first(params, "source"), 120),
    type: oneOf(first(params, "type"), ADMIN_WORK_TYPES),
    state: boundedText(first(params, "state"), 120),
    attention: oneOf(first(params, "attention"), ADMIN_WORK_ATTENTION, "all") ?? "all",
    sla: oneOf(first(params, "sla"), ADMIN_WORK_SLA, "all") ?? "all",
    age: oneOf(first(params, "age"), ADMIN_WORK_AGES, "all") ?? "all",
    sort: oneOf(first(params, "sort"), ADMIN_WORK_SORTS, "newest") ?? "newest",
    page: integer(first(params, "page"), 1, 1, 20),
    pageSize: integer(first(params, "pageSize"), 25, 10, 50),
  };
}

export function adminWorkFiltersQuery(filters: AdminWorkFilters, overrides: Partial<AdminWorkFilters> = {}) {
  const value = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (value.scope !== "all") params.set("scope", value.scope);
  if (value.owner) params.set("owner", value.owner);
  if (value.stage) params.set("stage", value.stage);
  if (value.source) params.set("source", value.source);
  if (value.type) params.set("type", value.type);
  if (value.state) params.set("state", value.state);
  if (value.attention !== "all") params.set("attention", value.attention);
  if (value.sla !== "all") params.set("sla", value.sla);
  if (value.age !== "all") params.set("age", value.age);
  if (value.sort !== "newest") params.set("sort", value.sort);
  if (value.page > 1) params.set("page", String(value.page));
  if (value.pageSize !== 25) params.set("pageSize", String(value.pageSize));
  return params.toString();
}
