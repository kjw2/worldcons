/** Dry-run provenance reconciliation; does not write Core or approve summaries. */
import {readFile,writeFile} from 'node:fs/promises';
import {revalidatedSentencia59Metadata,type P3RefreshCandidate} from '../../lib/admin/p4/p3-drift-refresh';
const snapshots=JSON.parse(await readFile('artifacts/e2e-p0-release/drift-review-snapshots.json','utf8'));
const sources=JSON.parse(await readFile('artifacts/e2e-p0-release/drift-official-source-probes.json','utf8'));
const id='d31eecc5-4e74-440f-ba6e-1561911bd68c';
const row=snapshots.rows.find((x:{id:string})=>x.id===id) as P3RefreshCandidate;
const probe=sources.probes.find((x:{articleId:string})=>x.articleId===id);
if(probe?.status!==200||!row)throw Error('recheck.provenance_missing');
const metadata=JSON.parse(revalidatedSentencia59Metadata(row,JSON.parse(probe.body),sources.at));
const report={schema:'worldcons.drift-provenance-recheck.v1',mode:'read_only',articleId:id,officialSourceHash:probe.bodyHash,
  proposedSourceMetadata:metadata,coreUpdated:false,p3Updated:false,summaryApproved:false,
  note:'Official identity/full-text gate passed. This prepared metadata is not a legal-meaning or summary approval; apply only through an optimistic authorized transition after content review.'};
await writeFile('artifacts/e2e-p0-release/drift-provenance-recheck.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({articleId:id,mode:'read_only',provenanceGatePassed:true,sourceRevalidation:metadata.sourceRevalidation,summaryApproved:false}));
