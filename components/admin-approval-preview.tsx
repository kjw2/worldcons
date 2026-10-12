"use client";
import type {SummarySchemaOutput} from "@/lib/ai/schema";
export interface ApprovalPreview {
  articleId:string;slug:string;approvalSnapshotHash:string;requiresProtectedApproval:boolean;
  koreanTitle:string;originalTitle:string;canonicalUrl:string;cleanedText:string;summaryJson:SummarySchemaOutput;fetchedAt?:string|null;
}
export async function fetchApprovalPreview(input:{articleId?:string;slug?:string}):Promise<ApprovalPreview> {
  const query=new URLSearchParams();if(input.articleId)query.set("articleId",input.articleId);else if(input.slug)query.set("slug",input.slug);
  const response=await fetch("/api/admin/approval-preview?"+query,{credentials:"same-origin",cache:"no-store"});
  const value=await response.json();if(!response.ok||!value.preview)throw Error(value.error??"검토 자료를 읽지 못했습니다.");return value.preview;
}
export function AdminApprovalPreview({preview,onDismiss}:{preview:ApprovalPreview;onDismiss:()=>void}) {
  const summary=preview.summaryJson?.summary;
  let sourceUrl:string|null=null;try{const url=new URL(preview.canonicalUrl);if(url.protocol==="https:"&&!url.username&&!url.password)sourceUrl=url.href;}catch{}
  return <section className="my-3 grid gap-3 rounded-md border border-rule bg-parchment/35 p-3" aria-label="승인할 자료 확인">
    <p className="text-sm font-semibold">{preview.koreanTitle||preview.originalTitle}</p>
    <p className="text-xs text-ink/65">아래 원문·요약을 검토한 뒤 공개 버튼을 다시 누르세요. 이후 내용이 바뀌면 승인이 중단됩니다.</p>
    {sourceUrl?<a className="focus-ring text-sm underline" href={sourceUrl} target="_blank" rel="noopener noreferrer">공식 출처 열기</a>:null}
    <details><summary className="focus-ring cursor-pointer text-sm font-semibold">수집 원문 전체</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6">{preview.cleanedText}</pre></details>
    <div className="text-sm leading-6">{summary?.coreSummary?.map((text,index)=><p key={index}>{text}</p>)}</div>
    <details><summary className="focus-ring cursor-pointer text-sm font-semibold">요약의 모든 항목</summary><div className="grid gap-3 text-sm leading-6">
      {[['배경',summary?.background],['사건 구조',summary?.caseStructure],['법적 의미',summary?.implications],['실무 참고',summary?.practicalNotes]].map(([label,value])=><p key={label}><strong>{label}</strong>: {value}</p>)}
      {summary?.referencedProvisions?.map((item,index)=><p key={index}>{item.jurisdiction} {item.lawName} {item.article}: {item.description} ({item.confidence})</p>)}
      <p>관련 대상: {preview.summaryJson?.entities?.map(x=>x.name).join(', ')}</p><p>분류: {preview.summaryJson?.categories?.join(', ')}</p><p>주제: {preview.summaryJson?.tags?.join(', ')}</p>
    </div></details>
    {preview.summaryJson?.riskFlags?.length?<p role="alert" className="text-sm text-court">추가 검토 사항: {preview.summaryJson.riskFlags.join(', ')}. 승인 메모에 검토 근거를 남기세요.</p>:null}
    <button type="button" className="focus-ring justify-self-start text-xs underline" onClick={onDismiss}>검토 취소</button>
  </section>;
}
