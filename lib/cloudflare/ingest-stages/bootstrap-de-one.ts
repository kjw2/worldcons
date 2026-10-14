/**
 * WorldCons P2-M3 Germany — bounded ORDINARY staged bootstrap precondition.
 *
 * The genuine scheduled discovery bootstrap runs only on the dedicated daily
 * cron (`0 21 * * *`, 06:00 KST). To verify the Production ordinary (non-canary)
 * staged Germany path NOW — without waiting for the next natural tick, without
 * adding any public/unauthenticated route, and without bypassing the source
 * gate — an operator needs a bounded one-off that seeds the EXACT same ordinary
 * discovery job the scheduled cron would.
 *
 * This module is the pure, runtime-neutral, FAIL-CLOSED precondition that must
 * hold BEFORE that one-off seeds anything. It never reads the network or a
 * database; the caller supplies the live env-derived lists and rollout gate.
 *
 * The one-off is safe only when the country is genuinely staged-owned:
 *
 *  - the ingestion master switch is ON, the environment is `production`, and the
 *    `discovery` stage is enabled (otherwise the consumer would refuse the job);
 *  - the configured staged source allowlist and the legacy M8 crawler exclusion
 *    are **exact paired** (same length, same keys, same order, no blank/duplicate
 *    entries) — an unpaired split is an unsafe ownership state;
 *  - `de-bverfg` is present in BOTH lists (Germany is staged-owned, not
 *    M8-owned), so the ordinary `stages/ingest-discovery-request/de-bverfg/...`
 *    payload is a legitimate staged source and passes the per-source gate;
 *  - the protected E2E sources and the canary sources are never touched.
 *
 * US/FR/ES are never accepted: the only source this mode can seed is
 * `de-bverfg`, and the payload contract rejects every other source outright.
 */
import { evaluateOwnershipPairing } from "./paired-ownership";
import {
  isIngestStageEnabled,
  resolveIngestBootstrapSources,
  type IngestStageRolloutGate,
} from "./flags";
import { resolveM8CrawlerSourcePolicy } from "../async-pipeline/crawler-source-ownership";

/** The only source this ORDINARY bootstrap mode may ever seed. */
export const BOOTSTRAP_DE_ONE_SOURCE_KEY = "de-bverfg" as const;

/**
 * A source that must NEVER be staged-owned for this mode: the United States is
 * M8-owned and P2-M4 (manual-review gated) is not part of this Germany-only
 * ordinary bootstrap. FR/ES are the pre-existing legitimate staged cohort and
 * are expected to remain; only a US-in-staged state fails closed.
 */
export const BOOTSTRAP_DE_ONE_FORBIDDEN_STAGED_SOURCES = ["us-scotus"] as const;

export interface BootstrapDeOnePreconditionInput {
  /** Live rollout gate (master switch + environment + stage allowlist). */
  gate: IngestStageRolloutGate;
  /** Raw `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST`. */
  stagedAllowlistRaw: string | null | undefined;
  /** Raw `M8_CRAWLER_SOURCE_EXCLUDE`. */
  m8ExcludeRaw: string | null | undefined;
  /** The known native source keys (bounds the resolvers). */
  nativeSources: readonly string[];
}

export interface BootstrapDeOnePrecondition {
  ok: boolean;
  /** Named, fail-closed reason when not ok (stable `bootstrap_de_one.*` prefix). */
  reason: string | null;
  /** Resolved staged bootstrap sources (empty when the allowlist is invalid). */
  stagedSources: string[];
  /** Legacy M8-owned sources after the exclusion (empty when invalid). */
  effectiveM8Sources: string[];
  /** True when `de-bverfg` is staged-owned (present in both paired lists). */
  germanyStaged: boolean;
  /** True only when the discovery stage is enabled in production. */
  discoveryEnabled: boolean;
}

const DENY = (reason: string, partial: Partial<BootstrapDeOnePrecondition> = {}): BootstrapDeOnePrecondition => ({
  ok: false,
  reason,
  stagedSources: [],
  effectiveM8Sources: [],
  germanyStaged: false,
  discoveryEnabled: false,
  ...partial,
});

/**
 * Evaluates the fail-closed precondition for a one-off ordinary Germany
 * bootstrap. Returns `ok: true` only when the stage gate is fully open for
 * `discovery` in production, the two ownership lists are exact paired, and
 * `de-bverfg` is present in both; otherwise `ok: false` with a named reason and
 * NO side effect.
 */
export function evaluateBootstrapDeOnePrecondition(
  input: BootstrapDeOnePreconditionInput,
): BootstrapDeOnePrecondition {
  const discoveryEnabled = isIngestStageEnabled(input.gate, "discovery");

  // The staged allowlist must resolve to a real, recognized source set. An
  // unset/invalid allowlist resolves to `[]` (fail closed), never a widening.
  const stagedSources = resolveIngestBootstrapSources(input.stagedAllowlistRaw, input.nativeSources);
  const owner = resolveM8CrawlerSourcePolicy(input.m8ExcludeRaw, input.nativeSources);

  if (!input.gate.masterEnabled) return DENY("bootstrap_de_one.stages_disabled", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  if (!input.gate.productionEnvironment) return DENY("bootstrap_de_one.not_production", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  if (!input.gate.policy.valid) return DENY("bootstrap_de_one.stage_allowlist_invalid", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  if (!discoveryEnabled) return DENY("bootstrap_de_one.discovery_stage_disabled", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  if (stagedSources.length === 0) return DENY("bootstrap_de_one.staged_allowlist_empty", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  if (!owner.valid) return DENY("bootstrap_de_one.m8_exclude_invalid", { stagedSources, effectiveM8Sources: [], discoveryEnabled });

  // Ownership must be exact paired; otherwise the split is unsafe.
  const pairing = evaluateOwnershipPairing(stagedSources, owner.excluded);
  if (!pairing.paired) {
    return DENY(`bootstrap_de_one.ownership_not_paired_${pairing.reason}`, { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  }

  const germanyStaged = stagedSources.includes(BOOTSTRAP_DE_ONE_SOURCE_KEY) && owner.excluded.includes(BOOTSTRAP_DE_ONE_SOURCE_KEY);
  if (!germanyStaged) {
    return DENY("bootstrap_de_one.germany_not_staged", { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  }
  // A US staged-ownership state would mean this one-off is being run against a
  // P2-M4 country that is not part of this Germany-only ordinary bootstrap.
  const forbiddenPresent = BOOTSTRAP_DE_ONE_FORBIDDEN_STAGED_SOURCES.filter((source) => stagedSources.includes(source));
  if (forbiddenPresent.length > 0) {
    return DENY(`bootstrap_de_one.forbidden_staged_source:${forbiddenPresent.join("|")}`, { stagedSources, effectiveM8Sources: [...owner.effective], discoveryEnabled });
  }

  return {
    ok: true,
    reason: null,
    stagedSources,
    effectiveM8Sources: [...owner.effective],
    germanyStaged: true,
    discoveryEnabled: true,
  };
}
