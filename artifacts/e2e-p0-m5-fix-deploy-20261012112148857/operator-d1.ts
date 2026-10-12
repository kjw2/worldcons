/** Administrative adapter for the existing WorldCons D1 databases; uses Wrangler's credential without printing it. */
import {readFile} from 'node:fs/promises';
import type {D1RuntimeDatabase,D1RuntimePreparedStatement} from '../../lib/cloudflare/d1/runtime-binding';
const account='c0975029797a404cd3ff402ee6a605b2',ids={worldcons_core:'0f4c41f0-778f-4ef4-860e-b0dad05f0984',worldcons_search:'1d74ebba-918b-4f8c-9c5c-9013479df809',worldcons_ingest:'0ccd27ff-fd16-4071-bc94-616690708c4e'};
export function operatorD1(name:keyof typeof ids):D1RuntimeDatabase {
 const query=async(batch:Array<{sql:string;params:unknown[]}>)=>{
  if(batch.length>100||batch.some(x=>x.params.length>100))throw Error('operator.d1_batch_budget');
  const config=await readFile('C:/Users/jaeth/AppData/Roaming/xdg.config/.wrangler/config/default.toml','utf8'),token=config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];if(!token)throw Error('operator.auth_missing');
  const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+ids[name]+'/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({batch})});
  const value=await response.json();if(!response.ok||!value.success||value.result.some((x:{success:boolean})=>!x.success))throw Error('operator.d1_failed:'+JSON.stringify(value.errors));return value.result;
 };
 const statement=(sql:string)=>{let params:unknown[]=[];return {sql,get params(){return params;},bind(...values:unknown[]){params=values;return this;},async all<T>(){return (await query([{sql,params}]))[0] as {success:boolean;results:T[];meta:Record<string,unknown>};},async run(){return (await query([{sql,params}]))[0];},async first<T>(){return ((await query([{sql,params}]))[0].results[0]??null) as T|null;}};};
 return {prepare:statement,async batch(statements:D1RuntimePreparedStatement[]){return query(statements.map(x=>({sql:(x as ReturnType<typeof statement>).sql,params:(x as ReturnType<typeof statement>).params})));}};
}
