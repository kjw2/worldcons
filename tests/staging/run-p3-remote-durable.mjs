import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Strictly disposable P3 E2E. Never touches or names a production resource.
 * Creates three dedicated D1 databases, one R2 bucket and an isolated Worker,
 * runs actual durable handlers + BYOK Gateway, then removes every resource.
 */
const id=randomBytes(5).toString("hex");
const officialG1Mode=process.argv.includes("--official-g1");
const prefix="worldcons-p3-remote-"+id;
const token=randomBytes(32).toString("hex");
const resources={
  core:prefix+"-core",
  ingest:prefix+"-ingest",
  ops:prefix+"-ops",
  bucket:prefix+"-raw",
  worker:prefix+"-worker",
};
const tmp=join(process.cwd(),"tests","staging",".p3-durable-"+id);
const configFile=join(tmp,"wrangler.jsonc");
const wrangler=join(process.cwd(),"node_modules","wrangler","bin","wrangler.js");
mkdirSync(tmp,{recursive:true,mode:0o700});
const created={core:false,ingest:false,ops:false,bucket:false,worker:false};
const ids={};
let workerUrl="";
let failed=false;
const err=(message)=>{failed=true; console.log(JSON.stringify({step:"error",detail:message.slice(0,400)}));};

function command(args,timeout=90000) {
  const r=spawnSync(process.execPath,[wrangler,...args],{
    cwd:process.cwd(),encoding:"utf8",timeout,maxBuffer:12*1024*1024,
  });
  const all=String(r.stdout||"")+"\n"+String(r.stderr||"");
  return {ok:r.status===0,code:r.status,timeoutCode:r.error?.code||null,stdout:String(r.stdout||""),raw:all,
    safe:all.replaceAll(token,"[redacted]").replace(/P3_REMOTE_AUTH[^\r\n]*/g,"P3_REMOTE_AUTH: [redacted]")};
}
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
function requireResult(r,what) {
  if(!r.ok) throw new Error(what+": "+(r.safe.match(/(?:ERROR|Error|failed|invalid)[^\r\n]{0,230}/i)||[])[0]?.slice(0,250));
  return r;
}
function combinedMigration(dir) {
  const base=join(process.cwd(),"d1","worldcons_"+dir);
  const files=readdirSync(base).filter(f=>/^\d+.*\.sql$/i.test(f)).sort();
  const sql=files.map(f=>readFileSync(join(base,f),"utf8")).join("\n\n");
  const dest=join(tmp,dir+".sql");
  writeFileSync(dest,sql,{mode:0o600});
  return {dest,files:files.length,bytes:sql.length};
}
async function fetchOfficialG1() {
  const url="https://www.bverfg.de/e/rk20261015_2bvr173526";
  const response=await fetch(url,{
    headers:{"User-Agent":"WorldCons-P4-isolated-G1-canary/1.0"},
    signal:AbortSignal.timeout(25000),
  });
  if(!response.ok) throw Error("official German source unavailable: HTTP "+response.status);
  const html=await response.text();
  const text=html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&shy;|&#160;|&#xA0;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/\s+/g," ").trim();
  const position=text.indexOf("2 BvR 1735/26");
  const cleanedText=position>=0
    ?text.slice(Math.max(0,position-140),position+7500).trim():"";
  if(cleanedText.length<1000||cleanedText.length>20000
    ||!cleanedText.includes("Die Abschiebung der Beschwerdeführerin")
    ||!cleanedText.includes("längstens für die Dauer von sechs Monaten")) {
    throw Error("official German source does not contain expected judicial anchors");
  }
  console.log(JSON.stringify({step:"official-source",court:"BVerfG",case:"2 BvR 1735/26",
    http:response.status,sourceChars:cleanedText.length}));
  return {text:cleanedText,title:"Beschluss vom 15. Oktober 2026",url};
}
async function call(path, payload={}) {
  const started=Date.now();
  const response=await fetch(workerUrl+path,{
    method:"POST",
    headers:{"x-p3-remote-auth":token,"content-type":"application/json"},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(185000),
  });
  const raw=await response.text();
  let result;
  try {result=JSON.parse(raw);} catch {result={nonJson:true,bytes:raw.length};}
  if(!response.ok||!result.ok) {
    const kind=typeof result.error==="string" ? result.error
      : raw.trim()==="Not found" ? "worker_not_found_body"
      : raw.trim().startsWith("<") ? "html_edge_error" : "unclassified_edge_error";
    throw new Error(path+" http="+response.status+" kind="+kind+" contentType="+String(response.headers.get("content-type")||"none").slice(0,50));
  }
  return {http:response.status,ms:Date.now()-started,result};
}
function assess(lane,data,replay=false) {
  const r=data.result;
  if(!r.actualRemoteD1||r.publishedRows!==0||r.cacheOutboxRows!==0||r.humanApprovalRows!==0||r.errorLeaked) {
    throw Error(lane+" storage/publication invariants failed");
  }
  if(lane==="g1-429") {
    if(r.aiRequests!==1||r.summaryStored||!r.failure||r.failure!=="summary_gateway.request_failed 429") {
      throw Error("negative failure/retry outcome unexpected");
    }
    return;
  }
  if(!r.summaryStored||!r.schemaValid||!r.titleRetained||r.provider!=="cloudflare-ai-gateway") {
    throw Error(lane+" durable summary or provenance invalid");
  }
  if(officialG1Mode && lane==="g1" && r.legalAudit?.status==="block") {
    throw Error("official G1 legal audit blocked summary");
  }
  if(lane==="g4"&&(r.publishable!==false||r.reviewRequired!==true||r.reviewState!=="needs_review"||!r.actualRemoteR2)) {
    throw Error("G4 private hold or R2 verification invalid");
  }
  if(!replay&&lane==="g3"&&(r.admin?.succeeded!==1||r.admin?.failed!==0)) {
    throw Error("G3 admin job did not succeed");
  }
  if(replay&&r.aiRequests!==0) throw Error(lane+" replay generated unexpected AI calls");
}

try {
  const officialG1=officialG1Mode?await fetchOfficialG1():null;
  for(const dir of ["core","ingest","ops"]) {
    const result=command(["d1","create",resources[dir],"--location","apac"],95000);
    if(result.ok) {
      created[dir]=true;
      const match=result.raw.match(/database_id\s*=\s*["']?([0-9a-f-]{36})/i)
        ||result.raw.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
      if(!match) throw Error("created D1 "+dir+" but CLI did not report UUID");
      ids[dir]=match[1];
      console.log(JSON.stringify({step:"d1-created",kind:dir,name:resources[dir]}));
    } else throw Error("D1 "+dir+" creation failed ("+(result.timeoutCode||result.code)+"): "+result.safe.slice(-450));
  }
  const bucket=command(["r2","bucket","create",resources.bucket,"--location","apac"],95000);
  requireResult(bucket,"r2 bucket create");
  created.bucket=true;
  console.log(JSON.stringify({step:"r2-created",name:resources.bucket}));
  const config={
    name:resources.worker,
    main:"./../p3-remote-durable-worker.ts",
    compatibility_date:"2026-10-15",
    compatibility_flags:["nodejs_compat"],
    workers_dev:true,
    ai:{binding:"AI"},
    d1_databases:[
      {binding:"WORLDCONS_CORE",database_name:resources.core,database_id:ids.core},
      {binding:"WORLDCONS_INGEST",database_name:resources.ingest,database_id:ids.ingest},
      {binding:"WORLDCONS_OPS",database_name:resources.ops,database_id:ids.ops},
    ],
    r2_buckets:[{binding:"WORLDCONS_RAW",bucket_name:resources.bucket}],
    vars:{P3_REMOTE_AUTH:token},
  };
  writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});

  for(const dir of ["core","ingest","ops"]) {
    const mig=combinedMigration(dir);
    let result=command(["d1","execute","WORLDCONS_"+dir.toUpperCase(),"--remote","--config",configFile,"--file",mig.dest,"--yes"],165000);
    requireResult(result,"apply "+dir+" schema");
    console.log(JSON.stringify({step:"d1-schema",kind:dir,files:mig.files,bytes:mig.bytes,applied:true}));
  }

  let deploy=command(["deploy","--config",configFile,"--autoconfig=false"],145000);
  if(!deploy.ok&&/Worker does not exist on your account|code:\s*10007/i.test(deploy.raw)) {
    await wait(4200);
    deploy=command(["deploy","--config",configFile,"--autoconfig=false"],145000);
  }
  requireResult(deploy,"deploy isolated Worker");
  created.worker=true;
  const url=deploy.raw.match(/https:\/\/[a-zA-Z0-9._-]+\.workers\.dev/);
  if(!url)throw Error("deployed Worker did not return a workers.dev URL");
  workerUrl=url[0];
  console.log(JSON.stringify({step:"worker-deployed",name:resources.worker,url:workerUrl}));

  let seeded;
  for(let retry=0;retry<5;retry++){
    try{seeded=await call("/seed",officialG1?{officialG1}:{});break;}
    catch(error){if(retry===4)throw error;await wait(3400);}
  }
  console.log(JSON.stringify({step:"seed",...seeded.result}));
  for(const lane of officialG1Mode?["g1"]:["g1","g2","g3","g4"]) {
    const first=await call("/"+lane);
    assess(lane,first);
    console.log(JSON.stringify({step:"durable-run",...first.result,elapsedMs:first.ms}));
    const replay=await call("/"+lane);
    assess(lane,replay,true);
    console.log(JSON.stringify({step:"durable-replay",lane,aiRequests:replay.result.aiRequests,outcome:replay.result.outcome,admin:replay.result.admin||undefined}));
  }
  if(!officialG1Mode) {
    const negative=await call("/g1-429");
    assess("g1-429",negative);
    console.log(JSON.stringify({step:"negative-429",...negative.result}));
  }
  console.log(JSON.stringify({step:"verdict",realOfficialG1:officialG1Mode,
    allFourDurable:!officialG1Mode,replaySafe:true,privateHold:true,productionUntouched:true}));
} catch(error) {
  err(error instanceof Error?error.message:String(error));
} finally {
  if(workerUrl) {
    try {
      const r=await call("/cleanup-r2");
      console.log(JSON.stringify({step:"cleanup-r2",success:r.result.objectRemoved===true}));
    } catch(error) { err("R2 object cleanup: "+String(error).slice(0,220)); }
  }
  // Delete Worker *first* so no live binding can point to a deleted database.
  if(created.worker) {
    const res=command(["delete",resources.worker,"--force"],95000);
    console.log(JSON.stringify({step:"cleanup-worker",removed:res.ok,name:resources.worker}));
    if(!res.ok && created.worker)err("Worker deletion failed: "+res.safe.slice(-240));
  }
  if(created.bucket) {
    let res=command(["r2","bucket","delete",resources.bucket],95000);
    if(!res.ok&&created.bucket){await wait(2000);res=command(["r2","bucket","delete",resources.bucket],95000);}
    console.log(JSON.stringify({step:"cleanup-bucket",removed:res.ok||!created.bucket,name:resources.bucket}));
    if(!res.ok&&created.bucket)err("R2 bucket deletion failed: "+res.safe.slice(-260));
  }
  for(const dir of ["ops","ingest","core"]) {
    if(!created[dir]) continue;
    let res=command(["d1","delete",resources[dir],"--skip-confirmation"],95000);
    if(!res.ok&&created[dir]){await wait(2200);res=command(["d1","delete",resources[dir],"--skip-confirmation"],95000);}
    console.log(JSON.stringify({step:"cleanup-d1",kind:dir,removed:res.ok||!created[dir],name:resources[dir]}));
    if(!res.ok&&created[dir])err("D1 "+dir+" deletion failed: "+res.safe.slice(-260));
  }
  rmSync(tmp,{recursive:true,force:true});
}
if(failed)process.exitCode=1;
