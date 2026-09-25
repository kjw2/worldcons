import { D1_SHADOW_DEFAULT_MAX_ROWS } from "@/lib/cloudflare/d1/shadow/config";
import {
  runD1RuntimeRead,
  type D1RuntimeReadOrder,
  type D1RuntimeReadPredicate,
} from "@/lib/cloudflare/d1/runtime-read";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { GlossaryTerm, IngestionRunRecord, SourceRecord, TagSummary } from "@/lib/db/types";
import { rangeStartIso } from "@/lib/utils/dates";
import {
  glossaryTermRowToRecord,
  ingestionRunRowToRecord,
  normalizeJurisdictions,
  normalizeTagListOptions,
  sortGlossaryTerms,
  sourceRowToRecord,
  tagRowToSummary,
  type NormalizedTagListOptions,
  type SupabaseGlossaryTermRow,
  type SupabaseIngestionRunRow,
  type SupabaseSourceRow,
  type SupabaseTagRow,
} from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, ReferenceReadRepository, TagListOptions } from "@/lib/reference-reads/types";

/**
 * M6.1 + M6.2 D1-backed reference reads.
 *
 * M6.1 covered `listSources`, `listGlossaryTerms` and `getGlossaryTerm` over
 * `worldcons_core`. M6.2 adds the four remaining reference methods:
 * `listTags`/`getTagBySlug` (also `worldcons_core.tags`), `listIngestionRuns`
 * (`worldcons_ingest.ingestion_runs`) and `listJurisdictionArticleCounts`
 * (`worldcons_core.articles`, grouped in memory). Every method is read-only and
 * bounded, and the row mappers are shared with the authoritative Supabase
 * adapter so the only difference between the two results is the storage engine.
 */
export class D1ReferenceReadUnsupportedError extends Error {
  readonly code = "d1_reference_read.unsupported_method";
  readonly method: string;
  constructor(method: string) {
    super(`D1 reference reads do not support ${method}`);
    this.name = "D1ReferenceReadUnsupportedError";
    this.method = method;
  }
}

/**
 * Raised when a bounded D1 shadow read observes more rows than `maxRows`.
 * The wrapper treats this as a skip, never as a partial comparison.
 */
export class D1ShadowTruncatedError extends Error {
  readonly code = "d1_shadow.truncated";
  readonly method: string;
  constructor(method: string) {
    super(`D1 shadow read for ${method} exceeded the bounded row limit`);
    this.name = "D1ShadowTruncatedError";
    this.method = method;
  }
}

export interface D1ReferenceReadDependencies {
  /** The `worldcons_core` binding. Resolved from the runtime slot when omitted. */
  binding?: D1RuntimeDatabase | null;
  /** The `worldcons_ingest` binding. Resolved from the runtime slot when omitted. */
  ingestBinding?: D1RuntimeDatabase | null;
  /** Bounded shadow read limit. */
  maxRows?: number;
}

function tableByName(schema = d1Schema): Map<string, D1TableDefinition> {
  return new Map(schema.tables.map((table) => [table.name, table]));
}

function requireCore(dependencies: D1ReferenceReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.binding ?? getRuntimeD1Binding("worldcons_core");
  if (!binding) throw new Error("worldcons_core D1 binding is not available");
  return binding;
}

function requireIngest(dependencies: D1ReferenceReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.ingestBinding ?? getRuntimeD1Binding("worldcons_ingest");
  if (!binding) throw new Error("worldcons_ingest D1 binding is not available");
  return binding;
}

function tagOrder(sort: NormalizedTagListOptions["sort"]): D1RuntimeReadOrder[] {
  if (sort === "name") return [{ column: "name", direction: "asc" }];
  if (sort === "latest") return [{ column: "latest_article_at", direction: "desc", nulls: "last" }];
  return [{ column: "article_count", direction: "desc" }];
}

/**
 * Mirrors the PostgREST `source_metadata->collection->>publishable = 'true'`
 * predicate: the canonical JSON text of `publishable` is compared as text, so a
 * JSON boolean `true` and the string `"true"` both count.
 */
function isPublishableMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const collection = (value as Record<string, unknown>).collection;
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return false;
  const publishable = (collection as Record<string, unknown>).publishable;
  return publishable === true || publishable === "true";
}

function boundedIngestionLimit(limit: number | undefined, maxRows: number): number {
  const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 20;
  if (requested <= 0) return 0;
  return Math.min(requested, maxRows + 1);
}

export function createD1ReferenceReadRepository(
  dependencies: D1ReferenceReadDependencies = {},
): ReferenceReadRepository {
  const maxRows = dependencies.maxRows ?? D1_SHADOW_DEFAULT_MAX_ROWS;
  const tables = tableByName();

  function requireTable(name: string): D1TableDefinition {
    const table = tables.get(name);
    if (!table) throw new Error(`D1 schema has no table ${name}`);
    return table;
  }

  async function listSources(): Promise<SourceRecord[]> {
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("sources"),
      orderBy: ["jurisdiction"],
      limit: maxRows,
    });
    return rows.map((row) => sourceRowToRecord(row as unknown as SupabaseSourceRow));
  }

  async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("glossary_terms"),
      orderBy: ["term"],
      limit: maxRows,
    });
    return sortGlossaryTerms(rows.map((row) => glossaryTermRowToRecord(row as unknown as SupabaseGlossaryTermRow)));
  }

  async function getGlossaryTerm(slug: string): Promise<GlossaryTerm | null> {
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("glossary_terms"),
      where: [{ column: "slug", value: slug }],
      orderBy: ["term"],
      limit: 1,
    });
    const term = rows.map((row) => glossaryTermRowToRecord(row as unknown as SupabaseGlossaryTermRow))[0];
    return term ?? null;
  }

  async function listTags(options: TagListOptions = {}): Promise<TagSummary[]> {
    const { type, sort, limit, minArticleCount } = normalizeTagListOptions(options);
    if (!limit) throw new Error("D1 listTags shadow requires an explicit bounded limit");
    const where: D1RuntimeReadPredicate[] = [];
    if (type) where.push({ column: "type", value: type });
    if (minArticleCount) where.push({ column: "article_count", op: "gte", value: minArticleCount });
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("tags"),
      where,
      orderBy: tagOrder(sort),
      limit: Math.min(limit, maxRows + 1),
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listTags");
    return rows.map((row) => tagRowToSummary(row as unknown as SupabaseTagRow));
  }

  async function getTagBySlug(slug: string): Promise<TagSummary | null> {
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("tags"),
      where: [{ column: "slug", value: slug }],
      limit: 1,
    });
    const tag = rows.map((row) => tagRowToSummary(row as unknown as SupabaseTagRow))[0];
    return tag ?? null;
  }

  async function listIngestionRuns(limit?: number): Promise<IngestionRunRecord[]> {
    const bounded = boundedIngestionLimit(limit, maxRows);
    if (bounded === 0) return [];
    const rows = await runD1RuntimeRead({
      binding: requireIngest(dependencies),
      table: requireTable("ingestion_runs"),
      orderBy: [{ column: "started_at", direction: "desc" }],
      limit: bounded,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listIngestionRuns");
    return rows.map((row) => ingestionRunRowToRecord(row as unknown as SupabaseIngestionRunRow));
  }

  async function listJurisdictionArticleCounts(
    jurisdictions: string[] = [],
    options: JurisdictionCountOptions = {},
  ): Promise<Record<string, number>> {
    const normalizedJurisdictions = normalizeJurisdictions(jurisdictions);
    const startIso = rangeStartIso(options.range);
    const where: D1RuntimeReadPredicate[] = [{ column: "status", value: "summarized" }];
    if (startIso) where.push({ column: "original_published_at", op: "gte", value: startIso });
    const rows = await runD1RuntimeRead({
      binding: requireCore(dependencies),
      table: requireTable("articles"),
      select: ["jurisdiction", "source_metadata"],
      where,
      orderBy: [],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listJurisdictionArticleCounts");

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const jurisdiction = typeof row.jurisdiction === "string" ? row.jurisdiction : null;
      if (!jurisdiction || !jurisdiction.trim()) continue;
      if (!isPublishableMetadata(row.source_metadata)) continue;
      counts[jurisdiction] = (counts[jurisdiction] ?? 0) + 1;
    }
    return normalizedJurisdictions.length
      ? Object.fromEntries(normalizedJurisdictions.map((jurisdiction) => [jurisdiction, counts[jurisdiction] ?? 0]))
      : counts;
  }

  return {
    listSources,
    listGlossaryTerms,
    getGlossaryTerm,
    listTags,
    getTagBySlug,
    listIngestionRuns,
    listJurisdictionArticleCounts,
  };
}
