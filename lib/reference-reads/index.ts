import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { createD1ReferenceReadRepository } from "@/lib/reference-reads/d1-repository";
import { mockReferenceReads } from "@/lib/reference-reads/mock-repository";
import type { ReferenceReadRepository } from "@/lib/reference-reads/types";

export * from "@/lib/reference-reads/mock-repository";
export * from "@/lib/reference-reads/shared";
export * from "@/lib/reference-reads/types";
export * from "@/lib/reference-reads/d1-repository";

/**
 * Cloudflare D1 is the only persistent reference-read authority. Local
 * environments without bindings use the in-memory fixture adapter.
 */
export function referenceReads(): ReferenceReadRepository {
  const core = getRuntimeD1Binding("worldcons_core");
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (core && ingest) {
    return createD1ReferenceReadRepository({
      binding: core,
      ingestBinding: ingest,
    });
  }
  return mockReferenceReads;
}
