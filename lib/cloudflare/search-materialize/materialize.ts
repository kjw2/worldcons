import {
  VECTOR_METADATA_INDEX_MANIFEST,
} from "@/lib/cloudflare/search-vector";
import {
  assessMetadataIndexes,
  applyVectorizeMaterialization,
  planVectorizeMaterialization,
  preflightVectorize,
  refusedVectorResult,
  vectorizeFailure,
  verifyVectorizeMaterialization,
  type VectorizeRestClient,
} from "./vectorize";
import { buildSearchMaterializationProjection } from "./build";
import { boundedMessage } from "./errors";
import {
  SEARCH_MATERIALIZE_D1_DATABASE,
  SEARCH_MATERIALIZE_VECTOR_INDEX,
  SEARCH_MATERIALIZE_VERSION,
  type BuildNarrowSearchSourceOptions,
  type D1CurrentState,
  type D1MaterializationResult,
  type D1PreApplySnapshot,
  type NarrowSearchSourceSnapshot,
  type SearchMaterializationGates,
  type SearchMaterializationProjection,
  type SearchMaterializationReport,
  type VectorizeMaterializationResult,
  type VectorizePreflight,
} from "./types";
import { buildNarrowSearchSource } from "./source";
import {
  d1ApplyFailure,
  d1DocumentStateHash,
  d1FtsStateHash,
  emptyD1Result,
  executeD1Statements,
  planD1Materialization,
  readD1CurrentState,
  readD1PreApplySnapshot,
  verifyD1Materialization,
  type D1RestClient,
} from "./d1";

export interface SearchMaterializationD1Deps {
  /** Bound-parameter read boundary. Always present. */
  query: D1RestClient["query"];
  /** Transactional per-batch write boundary. Required only for an explicit apply. */
  batch?: D1RestClient["batch"];
  batchSize?: number;
  /** Persists the pre-apply snapshot before the first write. */
  writeSnapshot?: (snapshot: D1PreApplySnapshot, path: string) => void;
  snapshotPath?: string;
}

export interface SearchMaterializationVectorizeDeps {
  client: VectorizeRestClient;
  upsertBatchSize?: number;
  deleteBatchSize?: number;
  mutationTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunSearchMaterializationOptions {
  source: BuildNarrowSearchSourceOptions;
  gates: SearchMaterializationGates;
  d1: SearchMaterializationD1Deps;
  vectorize?: SearchMaterializationVectorizeDeps;
}

export interface SearchMaterializationRun {
  report: SearchMaterializationReport;
  projection: SearchMaterializationProjection;
  snapshot: NarrowSearchSourceSnapshot;
}

function currentHashes(current: D1CurrentState): D1MaterializationResult["current"] {
  return {
    documentCount: current.documentCount,
    ftsCount: current.ftsCount,
    documentChecksumHash: d1DocumentStateHash(current.documents),
    ftsIdHash: d1FtsStateHash(current.ftsArticleIds),
  };
}

async function runD1(
  projection: SearchMaterializationProjection,
  gates: SearchMaterializationGates,
  deps: SearchMaterializationD1Deps,
  errors: string[],
): Promise<D1MaterializationResult> {
  const current = await readD1CurrentState(deps.query);
  const { statements, report: planReport } = planD1Materialization(
    projection.search.documents,
    projection.search.ftsDocuments,
    current,
    deps.batchSize,
  );
  const base = emptyD1Result({
    current: currentHashes(current),
    desired: { documentCount: projection.search.documents.length, ftsCount: projection.search.ftsDocuments.length },
    plan: planReport,
    state: planReport.statementCount === 0 ? "noop" : "dry-run",
  });

  if (!gates.applyD1) return base;
  if (gates.confirmSearchDb !== SEARCH_MATERIALIZE_D1_DATABASE) {
    errors.push("d1_confirmation_required: --apply-d1 requires --confirm-search-db=worldcons_search");
    return emptyD1Result({ ...base, state: "failed", errors: ["d1_confirmation_required"] });
  }
  if (typeof deps.batch !== "function") {
    errors.push("d1_apply_failed: no d1 write boundary was provided");
    return emptyD1Result({ ...base, state: "failed", errors: ["d1_apply_failed"] });
  }
  if (planReport.statementCount === 0) {
    const verification = await verifyD1Materialization(
      projection.search.documents,
      projection.search.ftsDocuments,
      current,
    );
    return emptyD1Result({ ...base, attempted: true, applied: false, verified: verification.ok, state: "noop", verification });
  }
  // A multi-batch apply is not globally atomic, so a persisted pre-apply snapshot
  // is mandatory: without it a partial failure could neither be detected nor
  // restored. Apply fails closed rather than writing without a rollback path.
  if (typeof deps.writeSnapshot !== "function" || deps.snapshotPath === undefined || deps.snapshotPath.length === 0) {
    errors.push("d1_apply_failed: an explicit pre-apply snapshot writer is required before a D1 apply");
    return emptyD1Result({ ...base, state: "failed", errors: ["d1_apply_failed"] });
  }

  try {
    const snapshot = await readD1PreApplySnapshot(deps.query);
    deps.writeSnapshot(snapshot, deps.snapshotPath);
  } catch (error) {
    // No write has started yet, so this is a failed apply, NOT a rollback
    // requirement: `rollback_required` is reserved for a partial write.
    const message = boundedMessage(error);
    errors.push(`d1_apply_failed: ${message}`);
    return emptyD1Result({ ...base, attempted: true, state: "failed", errors: [message] });
  }

  try {
    const batches = await executeD1Statements(deps.batch, statements, deps.batchSize);
    const after = await readD1CurrentState(deps.query);
    const verification = await verifyD1Materialization(
      projection.search.documents,
      projection.search.ftsDocuments,
      after,
    );
    if (!verification.ok) {
      throw new Error(`d1_verification_failed (${verification.issues.length} issues after ${batches} batches)`);
    }
    return emptyD1Result({
      ...base,
      attempted: true,
      applied: true,
      verified: true,
      state: "applied",
      current: currentHashes(after),
      snapshotPath: deps.snapshotPath ?? null,
      verification,
    });
  } catch (error) {
    const failed = d1ApplyFailure(error, emptyD1Result({ ...base, attempted: true }));
    return { ...failed, snapshotPath: deps.snapshotPath ?? null };
  }
}

async function runVectorize(
  projection: SearchMaterializationProjection,
  gates: SearchMaterializationGates,
  deps: SearchMaterializationVectorizeDeps,
  errors: string[],
): Promise<VectorizeMaterializationResult> {
  const desired = {
    recordCount: projection.vector.manifest.recordCount,
    hash: projection.vector.manifest.hash,
    missingCount: projection.vector.manifest.missingCount,
    staleCount: projection.vector.manifest.staleCount,
  };
  let preflight: VectorizePreflight;
  try {
    preflight = await preflightVectorize(deps.client);
  } catch (error) {
    const failed = vectorizeFailure(error, { desired });
    errors.push(failed.errors[0] ?? "vector_apply_failed");
    return failed;
  }
  const current = {
    vectorCount: preflight.vectorCount,
    idCount: preflight.vectorIds.length,
    idHash: "",
  };
  const assessment = assessMetadataIndexes(preflight.metadataIndexes);
  const metadataIndexes = {
    expected: VECTOR_METADATA_INDEX_MANIFEST.map((entry) => ({ ...entry })),
    present: assessment.present,
    missing: assessment.missing,
    wrongType: assessment.wrongType,
    created: [],
  };
  const { plan } = planVectorizeMaterialization(
    projection.vector.records,
    preflight,
    deps.upsertBatchSize,
    deps.deleteBatchSize,
  );

  if (!gates.applyVector) {
    return refusedVectorResult(preflight.index === null ? "needs_provision" : "dry-run", [], {
      config: preflight.index,
      current,
      desired,
      metadataIndexes,
      plan,
    });
  }
  if (gates.confirmVectorIndex !== SEARCH_MATERIALIZE_VECTOR_INDEX) {
    const message = "vector_confirmation_required: --apply-vector requires --confirm-vector-index=worldcons-search";
    errors.push(message);
    return refusedVectorResult("refused", [message], { config: preflight.index, current, desired, metadataIndexes, plan });
  }
  if (projection.vector.manifest.missingCount + projection.vector.manifest.staleCount > 0) {
    const message = "vector_completeness_refused: desired vector set has missing/stale embedding artifacts";
    errors.push(message);
    return refusedVectorResult("refused", [message], { config: preflight.index, current, desired, metadataIndexes, plan });
  }

  const needsProvision = preflight.index === null;
  if (needsProvision && !gates.provisionVectorIndex) {
    const message = "vector_confirmation_required: target index is absent; pass --provision-vector-index";
    errors.push(message);
    return refusedVectorResult("refused", [message], { current, desired, metadataIndexes, plan });
  }

  try {
    const applied = await applyVectorizeMaterialization({
      client: deps.client,
      records: projection.vector.records,
      preflight,
      provisionIndex: needsProvision && gates.provisionVectorIndex,
      createMetadataIndexes: true,
      upsertBatchSize: deps.upsertBatchSize,
      deleteBatchSize: deps.deleteBatchSize,
      mutationTimeoutMs: deps.mutationTimeoutMs,
      sleep: deps.sleep,
      now: deps.now,
    });
    const verification = await verifyVectorizeMaterialization({
      client: deps.client,
      records: projection.vector.records,
    });
    if (!verification?.ok) {
      throw new Error("vector_verification_failed");
    }
    return {
      ...applied,
      desired,
      current: { ...applied.current, vectorCount: verification.vectorCount },
      verified: true,
      verification,
    };
  } catch (error) {
    const failed = vectorizeFailure(error, { desired, current, metadataIndexes, plan });
    errors.push(failed.errors[0] ?? "vector_apply_failed");
    return failed;
  }
}

/**
 * Runs the operator-only remote materialization and returns a deterministic,
 * safe report. Dry-run by default: it performs read-only preflight and never
 * writes unless the matching gate pair is present. D1 and Vectorize are
 * independent, so a refused/incomplete vector apply does not roll back D1.
 */
export async function runSearchMaterialization(
  options: RunSearchMaterializationOptions,
): Promise<SearchMaterializationRun> {
  const snapshot = await buildNarrowSearchSource(options.source);
  const projection = buildSearchMaterializationProjection(snapshot);
  const errors: string[] = [];

  const d1 = await runD1(projection, options.gates, options.d1, errors);

  let vector: VectorizeMaterializationResult;
  if (options.vectorize === undefined) {
    vector = refusedVectorResult("skipped", []);
  } else {
    vector = await runVectorize(projection, options.gates, options.vectorize, errors);
  }

  const report: SearchMaterializationReport = {
    version: SEARCH_MATERIALIZE_VERSION,
    stage: "d1-search-materialize",
    dryRun: !options.gates.applyD1 && !options.gates.applyVector,
    source: {
      counts: snapshot.counts,
      publishedCount: projection.search.documents.length,
      fingerprint: snapshot.fingerprint,
      pageCount: snapshot.pageCount,
    },
    desired: projection.desired,
    d1,
    vector,
    omissions: {
      missingCount: projection.vector.manifest.missingCount,
      staleCount: projection.vector.manifest.staleCount,
    },
    blockedBy: ["search_m7"],
    ok:
      errors.length === 0 &&
      d1.state !== "failed" &&
      d1.state !== "rollback_required" &&
      vector.state !== "failed" &&
      vector.state !== "refused",
    errors,
  };
  return { report, projection, snapshot };
}
