import {
  D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE,
  D1_SHADOW_ADMIN_OPS_READ_SURFACE,
  D1_SHADOW_ARTICLE_READ_SURFACE,
  D1_SHADOW_REFERENCE_SURFACE,
} from "./config";
import { referenceReadShadowCoveredMethods } from "@/lib/reference-reads/shadow";
import { articleReadShadowCoveredMethods } from "@/lib/article-reads/shadow";
import { adminOpsReadShadowCoveredMethods } from "@/lib/admin/ops-read-repository/shadow";
import { adminAnalyticsReadShadowCoveredMethods } from "@/lib/admin/analytics-read-repository/shadow";

/**
 * M6.5 shadow parity coverage metadata.
 *
 * The comparable surface/method set is derived from the same
 * `*ShadowCoveredMethods()` exports the M6 wrappers own, so the report cannot
 * silently drift from the implemented shadow code. Deferred obligations (M7
 * search and the two admin RPC snapshots) are declared separately and can
 * never satisfy M6 parity coverage.
 */
export interface D1ShadowMethodCoverage {
  method: string;
  /** True when the method is implemented but explicitly deferred (no D1 parity). */
  deferred: boolean;
  /** BLocker obligation id when deferred, otherwise null. */
  deferredBlockerId: string | null;
}

export interface D1ShadowSurfaceCoverage {
  surface: string;
  methods: D1ShadowMethodCoverage[];
}

export interface D1ShadowGlobalBlocker {
  id: string;
  description: string;
}

/** Explicit obligations that keep the global `GO-D1-READ` gate blocked in M6.5. */
export const D1_SHADOW_GLOBAL_BLOCKERS: readonly D1ShadowGlobalBlocker[] = [
  {
    id: "search_m7",
    description: "M7 search/FTS5/Vectorize projection is not implemented or parity-tested",
  },
  {
    id: "rpc_admin_dashboard_snapshot",
    description: "`loadDashboardSnapshot` admin RPC has no migrated D1 equivalent (rpc_deferred)",
  },
  {
    id: "rpc_admin_analytics_health_snapshot",
    description: "`loadAnalyticsHealthSnapshot` admin RPC has no migrated D1 equivalent (rpc_deferred)",
  },
];

const DEFERRED_METHOD_BLOCKERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [D1_SHADOW_ADMIN_OPS_READ_SURFACE]: { loadDashboardSnapshot: "rpc_admin_dashboard_snapshot" },
  [D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE]: { loadAnalyticsHealthSnapshot: "rpc_admin_analytics_health_snapshot" },
};

/**
 * Methods that must stay direct authoritative/synchronous behavior and emit no
 * `worldcons.d1_shadow` event at all. They are listed for operator clarity only.
 */
export const D1_SHADOW_SYNC_METHODS: readonly { surface: string; method: string; treatment: string }[] = [
  {
    surface: D1_SHADOW_ADMIN_OPS_READ_SURFACE,
    method: "isConfigured",
    treatment: "synchronous authoritative; schedules no D1 work and emits no event",
  },
  {
    surface: D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE,
    method: "isConfigured",
    treatment: "synchronous authoritative; schedules no D1 work and emits no event",
  },
];

function covered(surface: string, methods: readonly string[]): D1ShadowSurfaceCoverage {
  const blockers = DEFERRED_METHOD_BLOCKERS[surface] ?? {};
  const sorted = [...methods].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    surface,
    methods: sorted.map((method) => ({
      method,
      deferred: Object.prototype.hasOwnProperty.call(blockers, method),
      deferredBlockerId: blockers[method] ?? null,
    })),
  };
}

/** The implemented M6 surfaces and every method each wrapper can emit. */
export function d1ShadowSurfaceCoverage(): D1ShadowSurfaceCoverage[] {
  return [
    covered(D1_SHADOW_REFERENCE_SURFACE, referenceReadShadowCoveredMethods()),
    covered(D1_SHADOW_ARTICLE_READ_SURFACE, articleReadShadowCoveredMethods()),
    covered(D1_SHADOW_ADMIN_OPS_READ_SURFACE, adminOpsReadShadowCoveredMethods()),
    covered(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE, adminAnalyticsReadShadowCoveredMethods()),
  ];
}

/** Every implemented, non-deferred surface+method that the M6 evidence gate scores. */
export function d1ShadowComparableMethods(): { surface: string; method: string }[] {
  const comparable: { surface: string; method: string }[] = [];
  for (const surface of d1ShadowSurfaceCoverage()) {
    for (const method of surface.methods) {
      if (!method.deferred) comparable.push({ surface: surface.surface, method: method.method });
    }
  }
  return comparable;
}

/** Every known surface name (deferred methods included). */
export function d1ShadowKnownSurfaces(): string[] {
  return d1ShadowSurfaceCoverage().map((surface) => surface.surface);
}

/** True when the surface is implemented and the method is a known member of it. */
export function isKnownD1ShadowSurfaceMethod(surface: string, method: string): boolean {
  return d1ShadowSurfaceCoverage().some(
    (entry) => entry.surface === surface && entry.methods.some((candidate) => candidate.method === method),
  );
}

/** True when the method is implemented but explicitly deferred from M6 parity. */
export function isDeferredD1ShadowMethod(surface: string, method: string): boolean {
  return d1ShadowSurfaceCoverage().some(
    (entry) =>
      entry.surface === surface &&
      entry.methods.some((candidate) => candidate.method === method && candidate.deferred),
  );
}
