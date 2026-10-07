/** Cloudflare D1-native P3 cache outbox delivery. Never acknowledge an event
 * until the main Worker has confirmed cache invalidation. Leases and tokens
 * make retries safe when Workers or Workflows are restarted.
 */
type OutboxRow = {id: string; lease_token: string; attempt_count: number; max_attempts: number};
type Statement = {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{success?: boolean;error?: string | null;results?: T[]}>;
};
export type CacheOutboxDatabase = {prepare(sql: string): Statement};

async function rows<T>(db: CacheOutboxDatabase, sql: string, ...args: unknown[]): Promise<T[]> {
  const result=await db.prepare(sql).bind(...args).all<T>();
  if(result.success===false || result.error || !Array.isArray(result.results)) throw new Error("cache_outbox.d1_failed");
  return result.results;
}

export async function runD1CacheOutboxDrain(
  db: CacheOutboxDatabase,
  revalidate: () => Promise<{revalidated: boolean}>,
  input: {limit?: number; now?: string; workerId?: string} = {},
) {
  const limit=Math.max(1,Math.min(Math.floor(input.limit??25),50));
  const now=input.now??new Date().toISOString();
  const workerId=input.workerId??`worldcons-ingest:${crypto.randomUUID()}`;
  const leaseUntil=new Date(Date.parse(now)+120_000).toISOString();
  const candidates=await rows<{id: string}>(db, `
    SELECT id FROM article_cache_outbox_p3
    WHERE (status='pending' AND available_at<=?)
       OR (status='processing' AND lease_expires_at<?)
    ORDER BY created_at,id LIMIT ?`,now,now,limit);
  const claimed:OutboxRow[]=[];
  for(const candidate of candidates){
    const token=crypto.randomUUID();
    const result=await rows<OutboxRow>(db, `
      UPDATE article_cache_outbox_p3 SET
        status='processing',attempt_count=attempt_count+1,
        lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND ((status='pending' AND available_at<=?)
        OR (status='processing' AND lease_expires_at<?))
      RETURNING id,lease_token,attempt_count,max_attempts`,
      workerId,token,leaseUntil,now,candidate.id,now,now);
    if(result.length===1) claimed.push(result[0]);
  }
  if(claimed.length===0) return {claimedCount:0,deliveredCount:0,failedCount:0,deadLetterCount:0};
  let errorCode: string | null=null;
  try{
    const outcome=await revalidate();
    if(!outcome?.revalidated) throw new Error("cache_outbox.revalidation_not_confirmed");
  }catch(error){
    errorCode=error instanceof Error && /revalidation_not_confirmed/.test(error.message)
      ? "cache_outbox.revalidation_not_confirmed" : "cache_outbox.revalidation_failed";
  }
  let deliveredCount=0,failedCount=0,deadLetterCount=0;
  for(const event of claimed){
    if(errorCode===null){
      const settled=await rows<{id:string}>(db, `
        UPDATE article_cache_outbox_p3 SET status='delivered',delivered_at=?,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
        RETURNING id`,now,now,event.id,workerId,event.lease_token);
      if(settled.length!==1) throw new Error("cache_outbox.lost_lease_on_delivery");
      deliveredCount++;
    }else{
      const dead=event.attempt_count>=event.max_attempts;
      const retryDelay=Math.min(3600,60*Math.pow(2,Math.min(event.attempt_count-1,6)));
      const retryAt=new Date(Date.parse(now)+retryDelay*1000).toISOString();
      const settled=await rows<{id:string}>(db, `
        UPDATE article_cache_outbox_p3 SET status=?,available_at=?,
          dead_lettered_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          last_error_code=?,updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
        RETURNING id`,dead?'dead_letter':'pending',retryAt,dead?now:null,errorCode,now,event.id,workerId,event.lease_token);
      if(settled.length!==1) throw new Error("cache_outbox.lost_lease_on_failure");
      failedCount++;
      if(dead)deadLetterCount++;
    }
  }
  return {claimedCount:claimed.length,deliveredCount,failedCount,deadLetterCount};
}
