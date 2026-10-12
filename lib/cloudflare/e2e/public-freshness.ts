import { readPublicMetadataState } from "../search-projection/metadata-repair";
import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { ELIGIBLE_PUBLISHED_PREDICATE } from "../search-projection/d1-sync";
import { currentGenerations, e2eRows, hasE2ETable, type GenerationRow } from "./generation-state";

/** No per-result network calls and no cached eligibility. Failure is unavailable. */
export async function assertPublicSearchFreshness(core:D1RuntimeDatabase,search:D1RuntimeDatabase,ids:readonly string[]) {
  const unique=[...new Set(ids)];
  const generations=await currentGenerations(core,unique);
  const metadata=await readPublicMetadataState(core,unique,new Set(generations.keys()));
  const guards=new Map<string,GenerationRow>();
  if (unique.length && await hasE2ETable(search,"e2e_search_generation_guards_v1")) {
    for (let offset=0;offset<unique.length;offset+=80) {
      const part=unique.slice(offset,offset+80);
      for (const row of await e2eRows(search,`SELECT * FROM e2e_search_generation_guards_v1 WHERE article_id IN (${part.map(()=>"?").join(",")})`,...part)) guards.set(String(row.article_id),row);
    }
  }
  for(let offset=0;offset<metadata.size;offset+=80){
    const part=[...metadata.keys()].slice(offset,offset+80);
    const found=await e2eRows(search,`SELECT * FROM search_metadata_guards_v1 WHERE article_id IN (${part.map(()=>"?").join(",")})`,...part);
    for(const id of part){const row=found.find(r=>r.article_id===id),state=metadata.get(id)!;
      if(!row||Number(row.revision)!==Number(state.revision)||Number(row.fencing_token)!==Number(state.fencing_token)||Number(row.tombstone)!==0)throw new Error("e2e.public_metadata_pending");
    }
  }
  for (const id of unique) {
    const g=generations.get(id),guard=guards.get(id);
    if (!g&&!guard) continue; // Legacy corpus remains outside the opt-in cohort.
    if (!g||!guard||!g.input_current||g.expected_publication_state!=="published"||Number(guard.tombstone)!==0
      || guard.generation_id!==g.generation_id||Number(guard.generation_seq)!==Number(g.generation_seq)
      || guard.version_id!==g.expected_version_id||Number(guard.version_revision)!==Number(g.expected_version_revision)
      || guard.publication_id!==g.expected_publication_id||Number(guard.publication_revision)!==Number(g.expected_publication_revision)
      || guard.publication_state!==g.expected_publication_state||guard.policy_version!==g.policy_version
      || guard.projection_input_hash!==g.projection_input_hash) throw new Error("e2e.public_projection_pending");
  }
  // Revalidate role eligibility and numeric attempt ownership in bounded queries.
  const protectedIds=[...generations.keys()];
  for (let offset=0;offset<protectedIds.length;offset+=80) {
    const part=protectedIds.slice(offset,offset+80);
    const eligible=await e2eRows(core,`SELECT p.article_id,o.fencing_token FROM article_publications_p3 p
      JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
      JOIN e2e_generation_heads_v1 h ON h.article_id=p.article_id
      JOIN e2e_search_repair_outbox_v1 o ON o.generation_id=h.generation_id
      WHERE ${ELIGIBLE_PUBLISHED_PREDICATE} AND p.article_id IN (${part.map(()=>"?").join(",")})`,...part);
    for (const id of part) {
      const row=eligible.find(r=>r.article_id===id);
      if (!row||Number(row.fencing_token)!==Number(guards.get(id)!.fencing_token)) throw new Error("e2e.public_projection_pending");
    }
  }
  // Core B could commit while Search guards were being read. Check it again.
  if (unique.length) {
    const latestMetadata=await readPublicMetadataState(core,unique,new Set(generations.keys()));
    for(const [id,before] of metadata){const after=latestMetadata.get(id);if(before.revision!==after?.revision||before.fencing_token!==after?.fencing_token)throw new Error("e2e.public_metadata_changed");}
    const latest=await currentGenerations(core,unique);
    for (const id of unique) {
      const before=generations.get(id),after=latest.get(id);
      if (before?.generation_id!==after?.generation_id || (after&&!after.input_current)) throw new Error("e2e.public_generation_changed");
    }
  }
}

/** Public Core content comes from the approved immutable P3, never mutable drafts. */
export async function overlayPublicGenerationRows(core:D1RuntimeDatabase,rows:GenerationRow[]) {
  const ids=rows.map(row=>String(row.id)), generations=await currentGenerations(core,ids);
  const metadata=await readPublicMetadataState(core,ids,new Set(generations.keys()));
  if (!generations.size && !metadata.size) return rows;
  const legacyVersions=new Map<string,GenerationRow>();
  const legacyIds=[...metadata.keys()];
  for(let offset=0;offset<legacyIds.length;offset+=80){
    const part=legacyIds.slice(offset,offset+80);
    const found=await e2eRows(core,`SELECT v.* FROM article_publications_p3 p
      JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
      WHERE ${ELIGIBLE_PUBLISHED_PREDICATE} AND p.article_id IN (${part.map(()=>"?").join(",")})`,...part);
    for(const version of found)legacyVersions.set(String(version.article_id),version);
  }
  const versions=new Map<string,GenerationRow>();
  const valid=[...generations.values()].filter(g=>g.input_current&&g.expected_publication_state==="published");
  for (let offset=0;offset<valid.length;offset+=80) {
    const part=valid.slice(offset,offset+80);
    const found=await e2eRows(core,`SELECT v.* FROM article_content_versions_p3 v
      JOIN article_publications_p3 p ON p.version_id=v.id AND p.article_id=v.article_id
      WHERE ${ELIGIBLE_PUBLISHED_PREDICATE} AND v.id IN (${part.map(()=>"?").join(",")})`,...part.map(g=>g.expected_version_id));
    for (const version of found) versions.set(String(version.id),version);
  }
  const result:GenerationRow[]=[];
  const latest=await currentGenerations(core,ids);
  const latestMetadata=await readPublicMetadataState(core,ids,new Set(latest.keys()));
  for(const [id,before] of metadata){const after=latestMetadata.get(id);if(before.revision!==after?.revision||before.fencing_token!==after?.fencing_token)throw new Error("e2e.public_metadata_changed");}
  for (const row of rows) {
    const g=generations.get(String(row.id));
    const current=latest.get(String(row.id));
    if (g?.generation_id!==current?.generation_id || (current&&!current.input_current)) continue;
    if (!g && !metadata.has(String(row.id))) { result.push(row); continue; }
    const version=g ? (g.input_current&&g.expected_publication_state==="published" ? versions.get(String(g.expected_version_id)) : undefined) : legacyVersions.get(String(row.id));
    if (!version) continue;
    const approved={...row};
    for (const column of Object.keys(row)) if (column in version && !["id","created_at","updated_at","article_tags"].includes(column)) {
      const value=version[column];
      approved[column]=["summary_json","source_metadata","case_metadata_snapshot","case_identifiers_snapshot"].includes(column)
        && typeof value==="string" ? JSON.parse(value) : value;
    }
    result.push(approved);
  }
  return result;
}
