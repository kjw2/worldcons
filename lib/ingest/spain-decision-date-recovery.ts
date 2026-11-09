import {
  validateSpainOfficialDecisionDate,
  type SpainDateCheck,
  type SpainDetailHeading,
} from "@/lib/ingest/spain-decision-date";

export interface SpainRecoveryCoreRow {
  id: string;
  canonical_url?: string | null;
  original_url?: string | null;
  original_published_at?: string | null;
  fetched_at?: string | null;
  content_hash?: string | null;
  source_metadata?: string | null;
}

export interface SpainRecoveryPublishedVersionRow {
  article_id: string;
  version_id: string;
  canonical_url?: string | null;
  publication_revision?: number | string | null;
  version_revision?: number | string | null;
  version_original_published_at?: string | null;
  version_content_hash?: string | null;
  source_content_hash?: string | null;
  article_original_published_at?: string | null;
  article_fetched_at?: string | null;
}

export interface SpainOfficialDateEvidence {
  hjId: string;
  canonicalUrl: string;
  fetched: boolean;
  httpStatus?: number;
  rawFechaRegistro?: string;
  decisionDate?: string;
  /** Official BOE publication date; never the decision date. */
  boeDate?: string;
  ecli?: string;
  heading?: SpainDetailHeading;
  evidenceBasis?: "detail_heading" | "json_fecha_registro";
  ok: boolean;
  reason?: string;
  checks: SpainDateCheck[];
  warnings: string[];
}

export type SpainRecoveryStatus =
  | "repairable"
  | "already_dated"
  | "source_date_missing"
  | "source_date_invalid"
  | "hj_id_missing"
  | "official_fetch_failed";

export interface SpainCoreRepairProposal {
  articleId: string;
  canonicalUrl: string;
  hjId?: string;
  currentOriginalPublishedAt: string | null;
  proposedOriginalPublishedAt: string | null;
  status: SpainRecoveryStatus;
  reason?: string;
  evidence?: SpainOfficialDateEvidence;
  guard: {
    originalPublishedAtIsNull: boolean;
    fetchedAt: string | null;
    contentHash: string | null;
  };
  sqlPreview?: string;
}

export interface SpainVersionRepairProposal {
  articleId: string;
  versionId: string;
  canonicalUrl: string;
  hjId?: string;
  currentVersionOriginalPublishedAt: string | null;
  proposedOriginalPublishedAt: string | null;
  status: SpainRecoveryStatus;
  reason?: string;
  evidence?: SpainOfficialDateEvidence;
  guard: {
    versionOriginalPublishedAtIsNull: boolean;
    versionRevision: string | null;
    publicationRevision: string | null;
    versionContentHash: string | null;
    sourceContentHash: string | null;
  };
  action: "republish_required" | "none";
}

export interface SpainDateRecoveryPlan {
  schema: "worldcons.spain-decision-date-recovery.v1";
  mode: "dry-run";
  generatedAt: string;
  writes: 0;
  applySupported: false;
  officialFetchCount: number;
  core: { total: number; repairable: number; unresolved: number; rows: SpainCoreRepairProposal[] };
  versions: { total: number; repairable: number; unresolved: number; rows: SpainVersionRepairProposal[] };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sqlLiteral(value: string | null) {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

export function extractSpainHjId(row: Pick<SpainRecoveryCoreRow, "canonical_url" | "original_url" | "source_metadata"> | Pick<SpainRecoveryPublishedVersionRow, "canonical_url">) {
  const metadata = "source_metadata" in row ? row.source_metadata : null;
  if (typeof metadata === "string" && metadata) {
    try {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      const id = stringValue(parsed.hjId);
      if (id && /^\d+$/.test(id) && Number(id) > 0) return String(Number(id));
    } catch {
      // Fall through to URL identity.
    }
  }
  for (const value of [("canonical_url" in row ? row.canonical_url : null), ("original_url" in row ? row.original_url : null)]) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "hj.tribunalconstitucional.es") continue;
      const id = url.pathname.match(/\/(?:Resolucion\/(?:Show|GetDocumentResolucion|Api\/json))\/(\d+)(?:\/|$)/i)?.[1];
      if (id && Number(id) > 0) return String(Number(id));
    } catch {
      continue;
    }
  }
  return undefined;
}

export function spainOfficialUrl(hjId: string | number) {
  return `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${hjId}`;
}

export function spainOfficialJsonUrls(hjId: string | number) {
  return [
    `https://hj.tribunalconstitucional.es/HJ/Resolucion/Api/json/${hjId}`,
    `https://hj.tribunalconstitucional.es/Resolucion/Api/json/${hjId}`,
  ];
}

function proposedIso(decisionDate: string | undefined) {
  return decisionDate ? `${decisionDate}T00:00:00.000Z` : null;
}

function coreSqlPreview(row: SpainRecoveryCoreRow, proposed: string, now: string) {
  return `UPDATE articles SET original_published_at=${sqlLiteral(proposed)}, updated_at=${sqlLiteral(now)} WHERE id=${sqlLiteral(row.id)} AND original_published_at IS NULL AND fetched_at IS ${sqlLiteral(stringValue(row.fetched_at))} AND content_hash IS ${sqlLiteral(stringValue(row.content_hash))};`;
}

function statusForEvidence(evidence: SpainOfficialDateEvidence): SpainRecoveryStatus {
  if (!evidence.fetched) return "official_fetch_failed";
  if (evidence.ok && evidence.decisionDate) return "repairable";
  return evidence.reason === "FECHA_REGISTRO is missing." ? "source_date_missing" : "source_date_invalid";
}

export async function buildSpainDateRecoveryPlan(input: {
  coreRows: readonly SpainRecoveryCoreRow[];
  versionRows: readonly SpainRecoveryPublishedVersionRow[];
  fetchEvidence: (hjId: string, canonicalUrl: string) => Promise<SpainOfficialDateEvidence>;
  now?: string;
  maxOfficialFetches?: number;
}): Promise<SpainDateRecoveryPlan> {
  const now = input.now ?? new Date().toISOString();
  const maxOfficialFetches = Math.max(0, Math.trunc(input.maxOfficialFetches ?? 200));
  const cache = new Map<string, SpainOfficialDateEvidence>();
  let officialFetchCount = 0;

  const evidenceFor = async (hjId: string | undefined, canonicalUrl: string) => {
    if (!hjId) return undefined;
    const cached = cache.get(hjId);
    if (cached) return cached;
    if (officialFetchCount >= maxOfficialFetches) return undefined;
    officialFetchCount += 1;
    const evidence = await input.fetchEvidence(hjId, canonicalUrl);
    cache.set(hjId, evidence);
    return evidence;
  };

  const coreRows: SpainCoreRepairProposal[] = [];
  for (const row of input.coreRows) {
    const canonicalUrl = stringValue(row.canonical_url) ?? stringValue(row.original_url) ?? "";
    const currentOriginalPublishedAt = stringValue(row.original_published_at);
    const hjId = extractSpainHjId(row);
    const guard = { originalPublishedAtIsNull: currentOriginalPublishedAt === null, fetchedAt: stringValue(row.fetched_at), contentHash: stringValue(row.content_hash) };
    if (currentOriginalPublishedAt) {
      coreRows.push({ articleId: row.id, canonicalUrl, hjId, currentOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "already_dated", guard });
      continue;
    }
    if (!hjId) {
      coreRows.push({ articleId: row.id, canonicalUrl, currentOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "hj_id_missing", reason: "Canonical URL and source_metadata do not expose an official HJ id.", guard });
      continue;
    }
    const evidence = await evidenceFor(hjId, canonicalUrl || spainOfficialUrl(hjId));
    if (!evidence) {
      coreRows.push({ articleId: row.id, canonicalUrl: canonicalUrl || spainOfficialUrl(hjId), hjId, currentOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "official_fetch_failed", reason: "Official HJ evidence fetch budget exhausted.", guard });
      continue;
    }
    const status = statusForEvidence(evidence);
    const proposed = status === "repairable" ? proposedIso(evidence.decisionDate) : null;
    coreRows.push({
      articleId: row.id,
      canonicalUrl: canonicalUrl || spainOfficialUrl(hjId),
      hjId,
      currentOriginalPublishedAt,
      proposedOriginalPublishedAt: proposed,
      status,
      ...(evidence.reason ? { reason: evidence.reason } : {}),
      evidence,
      guard,
      ...(proposed ? { sqlPreview: coreSqlPreview(row, proposed, now) } : {}),
    });
  }

  const versionRows: SpainVersionRepairProposal[] = [];
  for (const row of input.versionRows) {
    const canonicalUrl = stringValue(row.canonical_url) ?? "";
    const currentVersionOriginalPublishedAt = stringValue(row.version_original_published_at);
    const hjId = extractSpainHjId({ canonical_url: row.canonical_url ?? null });
    const guard = {
      versionOriginalPublishedAtIsNull: currentVersionOriginalPublishedAt === null,
      versionRevision: stringValue(row.version_revision) ?? (row.version_revision === undefined || row.version_revision === null ? null : String(row.version_revision)),
      publicationRevision: stringValue(row.publication_revision) ?? (row.publication_revision === undefined || row.publication_revision === null ? null : String(row.publication_revision)),
      versionContentHash: stringValue(row.version_content_hash),
      sourceContentHash: stringValue(row.source_content_hash),
    };
    if (currentVersionOriginalPublishedAt) {
      versionRows.push({ articleId: row.article_id, versionId: row.version_id, canonicalUrl, hjId, currentVersionOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "already_dated", guard, action: "none" });
      continue;
    }
    if (!hjId) {
      versionRows.push({ articleId: row.article_id, versionId: row.version_id, canonicalUrl, currentVersionOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "hj_id_missing", reason: "Canonical URL does not expose an official HJ id.", guard, action: "none" });
      continue;
    }
    const evidence = await evidenceFor(hjId, canonicalUrl || spainOfficialUrl(hjId));
    if (!evidence) {
      versionRows.push({ articleId: row.article_id, versionId: row.version_id, canonicalUrl: canonicalUrl || spainOfficialUrl(hjId), hjId, currentVersionOriginalPublishedAt, proposedOriginalPublishedAt: null, status: "official_fetch_failed", reason: "Official HJ evidence fetch budget exhausted.", guard, action: "none" });
      continue;
    }
    const status = statusForEvidence(evidence);
    const proposed = status === "repairable" ? proposedIso(evidence.decisionDate) : null;
    versionRows.push({
      articleId: row.article_id,
      versionId: row.version_id,
      canonicalUrl: canonicalUrl || spainOfficialUrl(hjId),
      hjId,
      currentVersionOriginalPublishedAt,
      proposedOriginalPublishedAt: proposed,
      status,
      ...(evidence.reason ? { reason: evidence.reason } : {}),
      evidence,
      guard,
      action: status === "repairable" ? "republish_required" : "none",
    });
  }

  const coreRepairable = coreRows.filter((row) => row.status === "repairable").length;
  const versionRepairable = versionRows.filter((row) => row.status === "repairable").length;
  return {
    schema: "worldcons.spain-decision-date-recovery.v1",
    mode: "dry-run",
    generatedAt: now,
    writes: 0,
    applySupported: false,
    officialFetchCount,
    core: { total: coreRows.length, repairable: coreRepairable, unresolved: coreRows.length - coreRepairable, rows: coreRows },
    versions: { total: versionRows.length, repairable: versionRepairable, unresolved: versionRows.length - versionRepairable, rows: versionRows },
  };
}

export function evidenceFromOfficialPayload(hjId: string, canonicalUrl: string, payload: Record<string, unknown>, httpStatus = 200): SpainOfficialDateEvidence {
  const validation = validateSpainOfficialDecisionDate({ payload });
  const rawFechaRegistro = typeof payload.FECHA_REGISTRO === "string" ? payload.FECHA_REGISTRO : undefined;
  return {
    hjId: String(hjId),
    canonicalUrl,
    fetched: true,
    httpStatus,
    ...(rawFechaRegistro ? { rawFechaRegistro } : {}),
    ...(validation.decisionDate ? { decisionDate: validation.decisionDate } : {}),
    ...(validation.boeDate ? { boeDate: validation.boeDate } : {}),
    ...(validation.ecli ? { ecli: validation.ecli } : {}),
    evidenceBasis: validation.dateBasis ?? "json_fecha_registro",
    ok: validation.ok,
    ...(validation.reason ? { reason: validation.reason } : {}),
    checks: validation.checks,
    warnings: validation.warnings,
  };
}

/**
 * Builds verified date evidence from the authoritative official detail heading
 * and, when available, the HJ JSON payload used only for cross-checks.
 */
export function evidenceFromOfficialDetail(input: {
  hjId: string;
  canonicalUrl: string;
  html: string;
  payload?: Record<string, unknown> | null;
  httpStatus?: number;
}): SpainOfficialDateEvidence {
  const payload = input.payload ?? {};
  const validation = validateSpainOfficialDecisionDate({
    headingHtml: input.html,
    payload,
    expected: {
      resolutionType: payload.TIPO_RESOLUCION,
      resolutionNumber: payload.NUMERO_RESOLUCION,
      resolutionYear: payload.ANNO_RESOLUCION,
      hjId: input.hjId,
      ecli: payload.ECLI ?? payload.ecli,
    },
  });
  const rawFechaRegistro = typeof payload.FECHA_REGISTRO === "string" ? payload.FECHA_REGISTRO : undefined;
  return {
    hjId: String(input.hjId),
    canonicalUrl: input.canonicalUrl || spainOfficialUrl(input.hjId),
    fetched: true,
    httpStatus: input.httpStatus ?? 200,
    ...(rawFechaRegistro ? { rawFechaRegistro } : {}),
    ...(validation.decisionDate ? { decisionDate: validation.decisionDate } : {}),
    ...(validation.boeDate ? { boeDate: validation.boeDate } : {}),
    ...(validation.ecli ? { ecli: validation.ecli } : {}),
    ...(validation.heading ? { heading: validation.heading } : {}),
    evidenceBasis: validation.dateBasis ?? "detail_heading",
    ok: validation.ok,
    ...(validation.reason ? { reason: validation.reason } : {}),
    checks: validation.checks,
    warnings: validation.warnings,
  };
}

export interface FetchSpainOfficialDateEvidenceOptions {
  fetchImpl?: typeof fetch;
  delayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Disable the JSON cross-check fetch (detail heading only). */
  includeJson?: boolean;
  /** Disable the detail heading fetch (legacy JSON-only). */
  includeDetail?: boolean;
}

const SPAIN_OFFICIAL_USER_AGENT =
  "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)";

/**
 * Fetches the official detail heading and HJ JSON, then returns fail-closed date
 * evidence. The detail heading is authoritative; JSON is only a cross-check.
 * The exact same evidence object feeds the correction/restoration SHA256.
 */
export async function fetchSpainOfficialDateEvidence(
  hjId: string,
  canonicalUrl: string,
  options: FetchSpainOfficialDateEvidenceOptions = {},
): Promise<SpainOfficialDateEvidence> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 0));
  const timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs ?? 30_000));
  const headers = { "user-agent": options.userAgent ?? SPAIN_OFFICIAL_USER_AGENT };
  const sleep = () => new Promise((done) => setTimeout(done, delayMs));

  let html: string | undefined;
  let htmlStatus: number | undefined;
  if (options.includeDetail !== false) {
    try {
      const response = await fetchImpl(spainOfficialUrl(hjId), {
        headers: { ...headers, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      htmlStatus = response.status;
      const body = await response.text().catch(() => "");
      if (response.ok && body.trim()) html = body;
    } catch {
      html = undefined;
    } finally {
      if (delayMs > 0) await sleep();
    }
  }

  let payload: Record<string, unknown> | undefined;
  let jsonStatus: number | undefined;
  if (options.includeJson !== false) {
    for (const url of spainOfficialJsonUrls(hjId)) {
      try {
        const response = await fetchImpl(url, {
          headers: { ...headers, accept: "application/json,text/plain;q=0.8,*/*;q=0.5" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        jsonStatus = response.status;
        const body = await response.text().catch(() => "");
        if (response.ok && body.trim()) {
          const parsed = JSON.parse(body) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
            break;
          }
        }
      } catch {
        // Try the alternate official JSON path.
      } finally {
        if (delayMs > 0) await sleep();
      }
    }
  }

  const resolvedUrl = canonicalUrl || spainOfficialUrl(hjId);
  if (html) {
    return evidenceFromOfficialDetail({
      hjId,
      canonicalUrl: resolvedUrl,
      html,
      payload,
      httpStatus: htmlStatus ?? jsonStatus,
    });
  }
  if (payload) {
    const evidence = evidenceFromOfficialPayload(hjId, resolvedUrl, payload, jsonStatus);
    return {
      ...evidence,
      warnings: [
        ...evidence.warnings,
        "Official detail heading was unavailable; HJ JSON FECHA_REGISTRO was used.",
      ],
    };
  }
  return {
    hjId: String(hjId),
    canonicalUrl: resolvedUrl,
    fetched: false,
    ok: false,
    reason: "Official HJ detail heading and JSON are unavailable; no date was inferred.",
    checks: [],
    warnings: [],
  };
}
