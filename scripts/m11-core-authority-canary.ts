import {
  readLifecycleViaCoreBoundary,
  readPublicationViaCoreBoundary,
  transitionLifecycleViaCoreBoundary,
  transitionPublicationViaCoreBoundary,
} from "@/lib/cloudflare/core-write/boundary-client";

const ARTICLE_ID = process.env.M11_CORE_CANARY_ARTICLE_ID?.trim()
  || "c11c0000-0000-4000-a000-000000000001";

async function main() {
  const lifecycle = await readLifecycleViaCoreBoundary(ARTICLE_ID);
  if (!lifecycle.ok) throw new Error(`lifecycle_read_${lifecycle.error.code}`);

  const transitionedLifecycle = await transitionLifecycleViaCoreBoundary({
    articleId: ARTICLE_ID,
    expectedRevision: lifecycle.data.revision,
    idempotencyKey: "m11c-live-lifecycle-v1",
    actorType: "summary_worker",
    actorId: "github-actions-m11c",
    source: "summary.resummary",
    reasonCode: "m11c.live_canary",
    processingState: "complete",
  });
  if (!transitionedLifecycle.ok) throw new Error(`lifecycle_transition_${transitionedLifecycle.error.code}`);

  const snapshot = await readPublicationViaCoreBoundary(ARTICLE_ID);
  if (!snapshot.ok) throw new Error(`publication_read_${snapshot.error.code}`);

  const input = {
    articleId: ARTICLE_ID,
    expectedVersionRevision: snapshot.data.versionRevision,
    expectedPublicationRevision: snapshot.data.publicationRevision,
    expectedLegacyUpdatedAt: snapshot.data.legacyUpdatedAt,
    idempotencyKey: "m11c-live-publication-v1",
    targetState: "published" as const,
    captureLegacy: true,
    actorType: "compatibility" as const,
    actorId: "github-actions-m11c",
    reason: "M11-C live D1 core/publication authority canary",
    requestId: process.env.GITHUB_RUN_ID ?? null,
    correlationId: "m11c-live-canary",
    provenanceActorType: "import" as const,
    provenanceActorId: "github-actions-m11c",
    safeMetadata: { m11CoreCanary: true },
  };
  const publication = await transitionPublicationViaCoreBoundary(input);
  if (!publication.ok) throw new Error(`publication_transition_${publication.error.code}`);
  const replay = await transitionPublicationViaCoreBoundary(input);
  if (!replay.ok || !replay.data.idempotent) throw new Error("publication_idempotency_failed");

  console.log(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    articleId: ARTICLE_ID,
    lifecycle: {
      fromRevision: lifecycle.data.revision,
      toRevision: transitionedLifecycle.data.revision,
      applied: transitionedLifecycle.data.applied,
    },
    publication: {
      versionRevision: publication.data.versionRevision,
      publicationRevision: publication.data.publicationRevision,
      state: publication.data.publicationState,
      versionCreated: publication.data.versionCreated,
      publicationApplied: publication.data.publicationApplied,
      replayIdempotent: replay.data.idempotent,
    },
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    schemaVersion: 1,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
