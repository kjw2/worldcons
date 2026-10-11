import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { SEARCH_DOCUMENT_COLUMNS, SEARCH_FTS_COLUMNS, type SearchProjectionDocument,
  type SearchProjectionFtsDocument } from "../search-projection/types";
import { sha256Canonical } from "./contracts";
import { e2eRows, type GenerationRow } from "./generation-state";

export interface SearchGenerationIdentity {
  articleId:string; generationId:string; generationSeq:number; versionId:string; versionRevision:number;
  publicationId:string; publicationRevision:number; publicationState:string; policyVersion:string;
  projectionInputHash:string; fencingToken:number;
}
export function searchIdentity(g: GenerationRow, fence: number): SearchGenerationIdentity {
  return { articleId:String(g.article_id),generationId:String(g.generation_id),generationSeq:Number(g.generation_seq),
    versionId:String(g.expected_version_id),versionRevision:Number(g.expected_version_revision),
    publicationId:String(g.expected_publication_id),publicationRevision:Number(g.expected_publication_revision),
    publicationState:String(g.expected_publication_state),policyVersion:String(g.policy_version),
    projectionInputHash:String(g.projection_input_hash),fencingToken:fence };
}
const identityColumns = ["generation_id","generation_seq","version_id","version_revision","publication_id",
  "publication_revision","publication_state","policy_version","projection_input_hash"];
function identityValues(i:SearchGenerationIdentity) { return [i.generationId,i.generationSeq,i.versionId,i.versionRevision,
  i.publicationId,i.publicationRevision,i.publicationState,i.policyVersion,i.projectionInputHash]; }
function body(row: Record<string,unknown>, columns: readonly string[]) {
  return Object.fromEntries(columns.map((column)=>[column,row[column]??null]));
}
export async function projectionFingerprints(document:SearchProjectionDocument|null, fts:SearchProjectionFtsDocument|null) {
  return { documentFingerprint:await sha256Canonical(document ? body(document as unknown as GenerationRow,SEARCH_DOCUMENT_COLUMNS) : null),
    ftsFingerprint:await sha256Canonical(fts ? body(fts as unknown as GenerationRow,SEARCH_FTS_COLUMNS) : null) };
}
export async function inspectSearchProjection(db:D1RuntimeDatabase,identity:SearchGenerationIdentity,
  document:SearchProjectionDocument|null,fts:SearchProjectionFtsDocument|null) {
  const [guards,docs,ftsRows] = await Promise.all([
    e2eRows(db,"SELECT * FROM e2e_search_generation_guards_v1 WHERE article_id=?",identity.articleId),
    e2eRows(db,"SELECT * FROM search_documents WHERE article_id=?",identity.articleId),
    e2eRows(db,"SELECT * FROM search_fts WHERE article_id=?",identity.articleId),
  ]);
  const guard=guards[0], values=identityValues(identity), fingerprints=await projectionFingerprints(document,fts);
  const actual=await projectionFingerprints(docs.length===1?docs[0] as unknown as SearchProjectionDocument:null,
    ftsRows.length===1?ftsRows[0] as unknown as SearchProjectionFtsDocument:null);
  const observation={documentCount:docs.length,ftsCount:ftsRows.length,...actual};
  if (!guard || identityColumns.some((column,index)=>String(guard[column])!==String(values[index]))
    || Number(guard.fencing_token)<identity.fencingToken || Number(guard.tombstone)!==Number(document===null)
    || guard.document_fingerprint!==fingerprints.documentFingerprint || guard.fts_fingerprint!==fingerprints.ftsFingerprint) return {matches:false,...observation};
  return {matches:document===null?docs.length===0&&ftsRows.length===0
    :docs.length===1&&ftsRows.length===1&&actual.documentFingerprint===fingerprints.documentFingerprint
      && actual.ftsFingerprint===fingerprints.ftsFingerprint,...observation};
}

export async function projectionMatches(db:D1RuntimeDatabase,identity:SearchGenerationIdentity,
  document:SearchProjectionDocument|null,fts:SearchProjectionFtsDocument|null) {
  return (await inspectSearchProjection(db,identity,document,fts)).matches;
}

/** Search guard CAS, both materializations and authorization cleanup are ONE batch. */
export async function applyGuardedSearchProjection(db:D1RuntimeDatabase,i:SearchGenerationIdentity,
  document:SearchProjectionDocument|null,fts:SearchProjectionFtsDocument|null,now:string) {
  if (!db.batch) throw new Error("e2e.search_batch_unavailable");
  if (!Number.isSafeInteger(i.generationSeq)||i.generationSeq<1||!Number.isSafeInteger(i.fencingToken)||i.fencingToken<1
    || (document===null)!==(fts===null) || (i.publicationState==="published")!==(document!==null)
    || (document && (document.article_id!==i.articleId || fts?.article_id!==i.articleId))) throw new Error("e2e.invalid_search_identity");
  const fingerprints=await projectionFingerprints(document,fts), token=crypto.randomUUID();
  const sameIdentity=identityColumns.map((column)=>`${column}=?`).join(" AND ");
  const statements=[db.prepare(`INSERT INTO e2e_search_commit_guards_v1 (token,assertion)
    VALUES (?,CASE WHEN NOT EXISTS (SELECT 1 FROM e2e_search_generation_guards_v1 WHERE article_id=?)
      OR EXISTS (SELECT 1 FROM e2e_search_generation_guards_v1 WHERE article_id=?
        AND (generation_seq<? OR (${sameIdentity} AND fencing_token<=?))) THEN 1 ELSE 0 END)`).bind(
      token,i.articleId,i.articleId,i.generationSeq,...identityValues(i),i.fencingToken),
    db.prepare("INSERT INTO e2e_search_write_authorizations_v1 (article_id,token) VALUES (?,?)").bind(i.articleId,token),
    db.prepare(`INSERT INTO e2e_search_generation_guards_v1 (article_id,${identityColumns.join(",")},fencing_token,
      tombstone,document_fingerprint,fts_fingerprint,updated_at) VALUES (${Array(15).fill("?").join(",")})
      ON CONFLICT(article_id) DO UPDATE SET ${[...identityColumns,"fencing_token","tombstone","document_fingerprint","fts_fingerprint","updated_at"].map(c=>`${c}=excluded.${c}`).join(",")}`).bind(
        i.articleId,...identityValues(i),i.fencingToken,Number(document===null),fingerprints.documentFingerprint,fingerprints.ftsFingerprint,now),
    db.prepare("DELETE FROM search_fts WHERE article_id=?").bind(i.articleId),
    db.prepare("DELETE FROM search_documents WHERE article_id=?").bind(i.articleId)];
  if (document && fts) statements.push(
    db.prepare(`INSERT INTO search_documents (${SEARCH_DOCUMENT_COLUMNS.join(",")}) VALUES (${SEARCH_DOCUMENT_COLUMNS.map(()=>"?").join(",")})`).bind(...SEARCH_DOCUMENT_COLUMNS.map(c=>document[c])),
    db.prepare(`INSERT INTO search_fts (${SEARCH_FTS_COLUMNS.join(",")}) VALUES (${SEARCH_FTS_COLUMNS.map(()=>"?").join(",")})`).bind(...SEARCH_FTS_COLUMNS.map(c=>fts[c])));
  statements.push(db.prepare("DELETE FROM e2e_search_write_authorizations_v1 WHERE article_id=? AND token=?").bind(i.articleId,token),
    db.prepare("DELETE FROM e2e_search_commit_guards_v1 WHERE token=?").bind(token));
  const results=await db.batch(statements);
  if (results.length!==statements.length || results.some(r=>r.success===false||r.error)) throw new Error("e2e.search_batch_failed");
  return fingerprints;
}
