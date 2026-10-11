import { hasE2ETable } from "./generation-state";
import { allPredicates } from "./sql-predicates";
import { searchRepairReservation } from "./search-repair-reservation";
import { canonicalJson } from "@/lib/backfill/canonical-json";
import type { ArticlePublicationTransitionInput } from "@/lib/article-publication/types";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { SEARCH_PROJECTION_VERSION } from "@/lib/cloudflare/search-projection/types";
import { APPROVAL_HASH_SCHEMA, FTS_INPUT_VERSION, GENERATION_HASH_SCHEMA, PROJECTION_INPUT_SCHEMA,
  approvalContextDocument, approvalIdentity, sha256Canonical, STAGED_APPROVAL_POLICY, type E2EGenerationReceipt } from "./contracts";

type Row = Record<string, unknown>;
async function read(binding: D1RuntimeDatabase, sql: string, ...values: unknown[]): Promise<Row | null> {
  const result = await binding.prepare(sql).bind(...values).all<Row>();
  if (result.success === false || result.error) throw new Error("e2e.read_failed");
  return result.results?.[0] ?? null;
}

// SQL serializes sorted tags; these exact bytes are asserted INSIDE the commit.
// Tags can change without articles.updated_at changing.
const TAG_SNAPSHOT_SQL = `SELECT json_group_array(json_object(
  'tag_id',tag_id,'confidence',confidence,'slug',slug,'name',name,
  'normalized_name',normalized_name,'type',type)) AS snapshot FROM (
  SELECT at.tag_id,at.confidence,t.slug,t.name,t.normalized_name,t.type
  FROM article_tags at LEFT JOIN tags t ON t.id=at.tag_id
  WHERE at.article_id=? ORDER BY at.tag_id COLLATE BINARY)`;

export async function readGenerationReplay(binding: D1RuntimeDatabase, input: ArticlePublicationTransitionInput) {
  if (!input.e2eApproval) return undefined;
  const row = await read(binding, `SELECT g.*,r.context_hash,r.generation_created,o.outbox_id
    FROM e2e_generation_requests_v1 r JOIN e2e_generations_v1 g ON g.generation_id=r.generation_id
    LEFT JOIN e2e_search_repair_outbox_v1 o ON o.article_id=g.article_id AND o.generation_id=g.generation_id
    WHERE r.article_id=? AND r.idempotency_key=?`, input.articleId, input.idempotencyKey);
  const contextHash = await sha256Canonical(approvalContextDocument(input.e2eApproval));
  if (!row || row.context_hash !== contextHash || row.expected_publication_state !== input.targetState) {
    throw new Error("e2e.invalid_replay");
  }
  return receipt(row, Number(row.generation_created) === 1);
}

function receipt(row: Row, created: boolean): E2EGenerationReceipt {
  return { generationId: String(row.generation_id), generationSeq: Number(row.generation_seq),
    approvalKey: String(row.approval_key), approvalSnapshotHash: String(row.approval_snapshot_hash),
    projectionInputHash: String(row.projection_input_hash), created,
    ...(row.outbox_id ? { searchRepairOutboxId: String(row.outbox_id) } : {}) };
}

export async function prepareGenerationCommit(binding: D1RuntimeDatabase, input: ArticlePublicationTransitionInput,
  observed: { article: Row; p3Head: Row | null; v4Head: Row | null; publication: Row | null },
  committed: { version: Row; publicationId: string; publicationRevision: number; now: string }) {
  const approval = input.e2eApproval!;
  const { article, p3Head, v4Head, publication } = observed;
  const { version, publicationId, publicationRevision, now } = committed;
  const previous = await read(binding, `SELECT g.* FROM e2e_generation_heads_v1 h
    JOIN e2e_generations_v1 g ON g.generation_id=h.generation_id AND g.article_id=h.article_id
    WHERE h.article_id=?`, input.articleId);
  const tagSnapshot = String((await read(binding, TAG_SNAPSHOT_SQL, input.articleId))?.snapshot ?? "[]");
  const identity = await approvalIdentity(input.articleId, version, approval.policyVersion);
  const projectionInputHash = await sha256Canonical({ schema: PROJECTION_INPUT_SCHEMA,
    articleId: input.articleId, versionId: version.id, versionRevision: Number(version.revision),
    approvalSnapshotHash: identity.approvalSnapshotHash, publicationId, publicationRevision,
    publicationState: input.targetState, tags: JSON.parse(tagSnapshot), reviewState: article.review_state ?? null,
    projectionVersion: SEARCH_PROJECTION_VERSION, ftsInputVersion: FTS_INPUT_VERSION });
  const created = !previous || previous.approval_key !== identity.approvalKey
    || previous.projection_input_hash !== projectionInputHash;
  const seq = previous ? Number(previous.generation_seq) + Number(created) : 1;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("e2e.invalid_sequence");
  const generationId = created ? await sha256Canonical({ schema: GENERATION_HASH_SCHEMA,
    articleId: input.articleId, generationSeq: seq, approvalKey: identity.approvalKey,
    expectedVersionId: version.id, targetState: input.targetState, projectionInputHash }) : String(previous!.generation_id);
  const result: E2EGenerationReceipt = { generationId, generationSeq: seq,
    approvalKey: identity.approvalKey, approvalSnapshotHash: identity.approvalSnapshotHash, projectionInputHash, created };
  const token = crypto.randomUUID();
  const predicates: string[] = [];
  const values: unknown[] = [token];
  // Names come from DB SELECT *, never request input. Even operational fields
  // are compared: content hash equality does not waive snapshot freshness.
  const columns = Object.keys(article);
  if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column))) throw new Error("e2e.invalid_column");
  predicates.push(`EXISTS (SELECT 1 FROM articles WHERE ${allPredicates(columns.map((column) => '"'+column+'" IS ?'))})`);
  values.push(...columns.map((column) => article[column] ?? null));
  for (const [table, row, fields] of [
    ["article_version_heads_p3",p3Head,["current_version_id","current_revision"]],
    ["article_revision_heads_v4",v4Head,["current_version_id","current_revision"]],
    ["article_publications_p3",publication,["id","state","version_id","revision"]],
  ] as const) {
    predicates.push(`COALESCE((SELECT json_array(${fields.join(',')}) FROM ${table} WHERE article_id=?),'null')=?`);
    values.push(input.articleId, row ? JSON.stringify(fields.map((field) => row[field] ?? null)) : "null");
  }
  predicates.push("COALESCE((SELECT json_array(generation_id,generation_seq) FROM e2e_generation_heads_v1 WHERE article_id=?),'null')=?");
  values.push(input.articleId, previous ? JSON.stringify([previous.generation_id,previous.generation_seq]) : "null");
  predicates.push(`(${TAG_SNAPSHOT_SQL.replace(' AS snapshot','')})=?`);
  values.push(input.articleId, tagSnapshot);
  if (approval.policyVersion===STAGED_APPROVAL_POLICY) {
    predicates.push(`EXISTS (SELECT 1 FROM e2e_approval_evidence_v1 WHERE approval_key=? AND article_id=?
      AND approval_snapshot_hash=? AND source_content_hash=? AND policy_version=? AND evidence_ref=?
      AND source_artifact_ref=? AND pipeline_run_id=? AND discovery_candidate_id=?)`);
    values.push(identity.approvalKey,input.articleId,identity.approvalSnapshotHash,identity.sourceContentHash,
      approval.policyVersion,approval.evidenceRef,approval.sourceEvidenceRef,approval.pipelineRunId,approval.discoveryCandidateId);
  }
  // Fail before writes if future schema exceeds D1's 100-parameter budget.
  if (values.length > 100) throw new Error("e2e.guard_parameter_budget");
  const guard = binding.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion)
    VALUES (?,CASE WHEN ${allPredicates(predicates)} THEN 1 ELSE 0 END)`).bind(...values);
  const statements: D1RuntimePreparedStatement[] = [];
  if (created) {
    statements.push(binding.prepare(`INSERT INTO e2e_generations_v1
      (generation_id,article_id,generation_seq,source_key,source_content_hash,approval_key,
       approval_snapshot_hash,approval_hash_schema,projection_input_hash,projection_input_schema,
       expected_version_id,expected_version_revision,expected_publication_id,expected_publication_revision,
       expected_publication_state,approval_mode,policy_version,approval_evidence_ref,source_evidence_ref,
       pipeline_run_id,discovery_candidate_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      generationId,input.articleId,seq,version.source_key,identity.sourceContentHash,identity.approvalKey,
      identity.approvalSnapshotHash,APPROVAL_HASH_SCHEMA,projectionInputHash,PROJECTION_INPUT_SCHEMA,
      version.id,Number(version.revision),publicationId,publicationRevision,input.targetState,approval.mode,
      approval.policyVersion,approval.evidenceRef,approval.sourceEvidenceRef,approval.pipelineRunId ?? null,
      approval.discoveryCandidateId ?? null,now));
    statements.push(binding.prepare(`INSERT INTO e2e_generation_heads_v1 (article_id,generation_id,generation_seq,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET generation_id=excluded.generation_id,
      generation_seq=excluded.generation_seq,updated_at=excluded.updated_at
      WHERE e2e_generation_heads_v1.generation_id=? AND e2e_generation_heads_v1.generation_seq=?`).bind(
      input.articleId,generationId,seq,now,previous?.generation_id ?? "",previous?.generation_seq ?? 0));
    statements.push(binding.prepare(`INSERT INTO e2e_generation_progress_v1 (generation_id,state,updated_at)
      VALUES (?,'publication_committed',?)`).bind(generationId,now));
  }
  statements.push(binding.prepare(`INSERT INTO e2e_generation_requests_v1
    (article_id,idempotency_key,generation_id,context_hash,context_document,generation_created) VALUES (?,?,?,?,?,?)`).bind(
    input.articleId,input.idempotencyKey,generationId,await sha256Canonical(approvalContextDocument(approval)),canonicalJson(approvalContextDocument(approval)),Number(created)));
  const reservation = await searchRepairReservation(binding, { articleId: input.articleId,
    generationId,generationSeq: seq,versionId: String(version.id),versionRevision: Number(version.revision),
    publicationId,publicationRevision,publicationState: input.targetState,policyVersion: approval.policyVersion,
    projectionInputHash,evidenceRef: created ? approval.evidenceRef : String(previous!.approval_evidence_ref) }, now);
  statements.push(reservation.insert);
  result.searchRepairOutboxId = reservation.outboxId;
  if (created && previous) {
    // Break both transport and Consumer ownership of old work in the SAME
    // publication commit. Preserve verified rows/evidence as historical proof.
    statements.push(binding.prepare(`UPDATE e2e_search_repair_outbox_v1 SET status='superseded',
      fencing_token=fencing_token+1,dispatch_fence=dispatch_fence+1,
      claimed_by=NULL,lease_expires_at=NULL,dispatch_owner=NULL,dispatch_token=NULL,
      dispatch_lease_expires_at=NULL,last_error_code='e2e.generation_replaced',updated_at=?
      WHERE article_id=? AND generation_id<>? AND status NOT IN ('verified','superseded')`).bind(now,input.articleId,generationId));
    statements.push(binding.prepare(`UPDATE e2e_generation_progress_v1 SET state='superseded',updated_at=?
      WHERE generation_id=? AND state<>'completed_verified'`).bind(now,previous.generation_id));
  }
  const cleanup = binding.prepare("DELETE FROM e2e_commit_guards_v1 WHERE token=?").bind(token);
  const authorization = await hasE2ETable(binding,"e2e_core_write_authorizations_v1")
    ? binding.prepare("INSERT INTO e2e_core_write_authorizations_v1 (article_id,token) VALUES (?,?)").bind(input.articleId,token) : null;
  return { result, guard, authorization, statements, cleanup };
}
