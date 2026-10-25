/** Publish existing rendered scenes; no GPU or source-video placeholder is needed. */
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateManifest } from '../apps/web/src/loader';
import { sceneReferences } from '../server/upload/scene-import.mjs';
const [directory, accountFile, outputDirectory] = process.argv.slice(2);
if (!directory || !accountFile || !outputDirectory) throw new Error('Usage: npx tsx scripts/upload-rendered-scenes.ts SCENES ACCOUNT_JSON OUTPUT_DIRECTORY');
const api='https://memos.alightdell64.chatgpt.site';
const account=JSON.parse(await readFile(accountFile,'utf8'));
if (!account.personalKey?.startsWith('memos1.')) throw new Error('Account file needs personalKey');
await mkdir(outputDirectory,{recursive:true,mode:0o700});
async function request(path:string, body:any) {
  for(let attempt=0;;attempt++) {
    try {
      const r=await fetch(api+path,{method:'POST',headers:{Authorization:'Bearer '+account.personalKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
      const result=await r.json();
      if(!r.ok) throw new Error(`HTTP ${r.status}: ${result.error}`);
      return result;
    } catch(e) { if(attempt>=2)throw e; await new Promise(r=>setTimeout(r,1000*(attempt+1))); }
  }
}
const report:any[]=[];
for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(!item.isDirectory())continue;
  const root=await realpath(join(directory,item.name));
  const manifests:any[]=[]; const files=new Set<string>();
  for(const name of ['memory.json','memory.static.json']) {
    const m=JSON.parse(await readFile(join(root,name),'utf8')); validateManifest(m); manifests.push(m);
    files.add(name); for(const ref of sceneReferences(m))files.add(ref);
  }
  const sorted=[...files].sort(); const hash=createHash('sha256');
  for(const path of sorted) {
    const full=await realpath(join(root,path)); if(!full.startsWith(root+sep))throw new Error('Asset escapes scene folder');
    hash.update(path+'\0');hash.update(await readFile(full));
  }
  const digest=hash.digest('hex'), statePath=join(outputDirectory,item.name+'.json');
  let state:any;
  try {state=JSON.parse(await readFile(statePath,'utf8'));}catch{}
  if(state?.digest!==digest)state={digest,requestId:randomUUID()};
  await writeFile(statePath,JSON.stringify(state,null,2));
  const start=await request('/api/scenes/start',{requestId:state.requestId,title:manifests[0].title||item.name});
  console.log(`${item.name}: uploading ${files.size} rendered files`);
  for(const path of sorted) {
    const data=await readFile(join(root,path));
    const p=await request('/api/scenes/presign',{receipt:start.receipt,path,size:data.length});
    if(!p.stored) {
      const put=await fetch(p.putUrl,{method:'PUT',headers:p.headers,body:data,signal:AbortSignal.timeout(120000)});
      if(!put.ok&&put.status!==409)throw new Error(`${item.name}/${path}: upload HTTP ${put.status}`);
    }
  }
  const complete=await request('/api/scenes/complete',{receipt:start.receipt});
  if(complete.memory.status!=='ready')throw new Error('Scene did not reach ready');
  const manifestUrl=complete.manifestUrl;
  for(const path of sorted) {
    const head=await fetch(new URL(path,manifestUrl),{method:'HEAD',signal:AbortSignal.timeout(30000)});
    const original=await readFile(join(root,path));
    if(!head.ok||Number(head.headers.get('content-length'))!==original.length)throw new Error('Published asset length mismatch: '+path);
  }
  const background=manifests[0].background.url;
  const downloaded=Buffer.from(await (await fetch(new URL(background,manifestUrl))).arrayBuffer());
  if(!downloaded.equals(await readFile(join(root,background))))throw new Error('Published splat bytes differ');
  state={...state,folder:item.name,...complete,files:sorted.length,verifiedAt:new Date().toISOString()};
  await writeFile(statePath,JSON.stringify(state,null,2)); report.push(state);
  await writeFile(join(outputDirectory,'report.json'),JSON.stringify(report,null,2));
  console.log(`PASS ${item.name}: memory #${complete.memory.id}, ready, all assets reachable, splat bytes identical`);
}
