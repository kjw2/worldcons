import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { SEARCH_PROJECTION_VERSION } from "../search-projection/types";
import { FTS_INPUT_VERSION, PROJECTION_INPUT_SCHEMA, sha256Canonical } from "./contracts";
import { CURRENT_GENERATION_SQL } from "./search-repair-dispatcher";

export type GenerationRow = Record<string, unknown>;
export async function e2eRows(db: D1RuntimeDatabase, sql: string, ...values: unknown[]) {
  const result = await db.prepare(sql).bind(...values).all<GenerationRow>();
  if (result.success === false || result.error || !Array.isArray(result.results)) throw new Error("e2e.read_unavailable");
  return result.results;
}
export async function hasE2ETable(db: D1RuntimeDatabase, name: string) {
  return (await e2eRows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",name))
    .some((row) => row.name === name);
}
export function generationProjectionHash(g: GenerationRow, tags: unknown, reviewState: unknown) {
  return sha256Canonical({ schema:PROJECTION_INPUT_SCHEMA,articleId:g.article_id,
    versionId:g.expected_version_id,versionRevision:Number(g.expected_version_revision),
    approvalSnapshotHash:g.approval_snapshot_hash,publicationId:g.expected_publication_id,
    publicationRevision:Number(g.expected_publication_revision),publicationState:g.expected_publication_state,
    tags,reviewState:reviewState ?? null,projectionVersion:SEARCH_PROJECTION_VERSION,ftsInputVersion:FTS_INPUT_VERSION });
}
export async function currentGenerations(db: D1RuntimeDatabase, ids: readonly string[]) {
  const found = new Map<string,GenerationRow>();
  if (!ids.length || !await hasE2ETable(db,"e2e_generation_heads_v1")) return found;
  for (let offset=0;offset<ids.length;offset+=80) {
    const part=ids.slice(offset,offset+80);
    const rows=await e2eRows(db,`SELECT g.*,a.review_state,
      CASE WHEN ${CURRENT_GENERATION_SQL} THEN 1 ELSE 0 END AS identity_current,
      (SELECT json_group_array(json_object('tag_id',tag_id,'confidence',confidence,'slug',slug,'name',name,
        'normalized_name',normalized_name,'type',type)) FROM (SELECT at.tag_id,at.confidence,t.slug,t.name,t.normalized_name,t.type
        FROM article_tags at LEFT JOIN tags t ON t.id=at.tag_id WHERE at.article_id=g.article_id ORDER BY at.tag_id COLLATE BINARY)) AS tag_snapshot
      FROM e2e_generation_heads_v1 h JOIN e2e_generations_v1 g ON g.generation_id=h.generation_id
      LEFT JOIN articles a ON a.id=g.article_id WHERE h.article_id IN (${part.map(()=>"?").join(",")})`,...part);
    for (const row of rows) {
      row.input_current=Number(row.identity_current)===1
        && (row.expected_publication_state!=="published"
          || !["needs_review","needs_triage","closed_private","rejected","blocked"].includes(String(row.review_state)))
        && await generationProjectionHash(row,JSON.parse(String(row.tag_snapshot)),row.review_state)===row.projection_input_hash;
      found.set(String(row.article_id),row);
    }
  }
  return found;
}
