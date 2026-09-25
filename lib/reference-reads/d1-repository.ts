import { D1_SHADOW_DEFAULT_MAX_ROWS } from "@/lib/cloudflare/d1/shadow/config";
import { runD1RuntimeRead } from "@/lib/cloudflare/d1/runtime-read";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { GlossaryTerm, IngestionRunRecord, SourceRecord, TagSummary } from "@/lib/db/types";
import {
  glossaryTermRowToRecord,
  sortGlossaryTerms,
  sourceRowToRecord,
  type SupabaseGlossaryTermRow,
  type SupabaseSourceRow,
} from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, ReferenceReadRepository, TagListOptions } from "@/lib/reference-reads/types";

/**
 * M6.1 D1-backed reference reads.
 *
 * This implements ONLY the methods M6.1 covers: `listSources`,
 * `listGlossaryTerms` and `getGlossaryTerm`, all over `worldcons_core`. The
 * remaining contract methods fail with an explicit typed error rather than
 * silently querying D1, because they are not part of the M6.1 shadow slice
 * (tags/jurisdiction counts/ingestion runs are deferred).
 *
 * Both adapters share the exact row mappers, so the only difference between the
 * Supabase result and the D1 result is the storage engine.
 */
export class D1ReferenceReadUnsupportedError extends Error {
  readonly code = "d1_reference_read.unsupported_method";
  readonly method: string;
  constructor(method: string) {
    super(`D1 reference reads do not support ${method} in M6.1`);
    this.name = "D1ReferenceReadUnsupportedError";
    this.method = method;
  }
}

export interface D1ReferenceReadDependencies {
  /** The `worldcons_core` binding. Resolved from the runtime slot when omitted. */
  binding?: D1RuntimeDatabase | null;
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

  function unsupported(method: string): Promise<never> {
    return Promise.reject(new D1ReferenceReadUnsupportedError(method));
  }

  return {
    listSources,
    listGlossaryTerms,
    getGlossaryTerm,
    listTags(options?: TagListOptions): Promise<TagSummary[]> {
      void options;
      return unsupported("listTags");
    },
    listJurisdictionArticleCounts(
      jurisdictions?: string[],
      options?: JurisdictionCountOptions,
    ): Promise<Record<string, number>> {
      void jurisdictions;
      void options;
      return unsupported("listJurisdictionArticleCounts");
    },
    listIngestionRuns(limit?: number): Promise<IngestionRunRecord[]> {
      void limit;
      return unsupported("listIngestionRuns");
    },
    getTagBySlug(slug: string): Promise<TagSummary | null> {
      void slug;
      return unsupported("getTagBySlug");
    },
  };
}
