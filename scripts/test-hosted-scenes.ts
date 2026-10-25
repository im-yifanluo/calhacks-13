/** Verify published scene bytes and independent live subscribers against the deployed service. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DbConnection } from '../apps/web/src/module_bindings';
import { sceneReferences } from '../server/upload/scene-import.mjs';
const clients: DbConnection[] = [];
const until = async (fn: () => unknown, label: string) => { for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label); };
async function connect(){return new Promise<DbConnection>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Connection timeout')),20000);const c=DbConnection.builder().withUri('wss://maincloud.spacetimedb.com').withDatabaseName('jerry-memory-replay-phone-20261024').withCompression('none').onConnect(c=>c.subscriptionBuilder().onApplied(()=>{clearTimeout(timer);resolve(c);}).subscribeToAllTables()).onConnectError((_,e)=>{clearTimeout(timer);reject(e);}).build();clients.push(c);});}
try {
 const leader=await connect();
 if(process.argv.includes('--wait')) { for(let n=0;n<120;n++){const count=[...leader.db.memory.iter()].filter(m=>m.owner.toHexString().startsWith('c2002df0e7df')&&m.manifestUrl.includes('/media/imports/')&&m.status==='ready').length;if(count>=14)break;if(n%6===0)console.log('Waiting for scene publication:',count,'/14');await new Promise(r=>setTimeout(r,10000));} }
 const rows=[...leader.db.memory.iter()].filter(m=>m.owner.toHexString().startsWith('c2002df0e7df')&&m.manifestUrl.includes('/media/imports/')&&m.status==='ready');
 console.log('Ready owned scenes:',rows.map(m=>({id:String(m.id),title:m.title,manifestUrl:m.manifestUrl})));
 if(process.argv.includes('--list'))process.exitCode=0;
 else {
 assert.equal(rows.length,14,'Expected all fourteen published scenes');
 const root='/Users/jerryfan/Downloads/memories-2';
 const {readdir}=await import('node:fs/promises');const folders=await readdir(root);
 const report=[];
 for(const row of rows){const manifest=await (await fetch(row.manifestUrl)).json();const folder=await (async()=>{for(const f of folders){try{if(JSON.parse(await readFile(`${root}/${f}/memory.json`,'utf8')).title===row.title)return f;}catch{}}throw new Error('Local scene missing');})();
 const refs=sceneReferences(manifest);for(const ref of refs){const r=await fetch(new URL(ref,row.manifestUrl),{method:'HEAD'});assert.equal(r.status,200,ref);}
 const downloaded=Buffer.from(await(await fetch(new URL(manifest.background.url,row.manifestUrl))).arrayBuffer());const original=await readFile(`${root}/${folder}/${manifest.background.url}`);
 const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');assert.equal(hash(downloaded),hash(original));report.push({id:String(row.id),title:row.title,manifestUrl:row.manifestUrl,assets:refs.length,backgroundSha256:hash(downloaded)});console.log('PASS assets',row.title);
 }
 const guest=await connect();await leader.reducers.createParty({memoryId:rows[0].id,name:'Scene verification leader',device:'desktop'});const roomId=leader.db.player.identity.find(leader.identity!)!.roomId;const room=leader.db.room.id.find(roomId)!;
 await guest.reducers.joinRoom({joinCode:room.joinCode,name:'Scene verification guest',device:'phone'});
 await leader.reducers.setPaused({paused:true});await leader.reducers.seek({mediaUs:1000000n});await leader.reducers.setPlaybackSpeed({speed:0.5});
 await assert.rejects(guest.reducers.seek({mediaUs:2000000n}));
 await leader.reducers.setPose({hx:2,hy:1.6,hz:0,hqx:0,hqy:0,hqz:0,hqw:1,lx:0,ly:0,lz:0,rx:0,ry:0,rz:0});
 await until(()=>guest.db.player.identity.find(leader.identity!)?.hx===2&&guest.db.timeline.roomId.find(roomId)?.anchorMediaUs===1000000n&&guest.db.timeline.roomId.find(roomId)?.speed===0.5,'Shared timeline/pose not received');
 assert.equal(guest.db.timeline.roomId.find(roomId)!.paused,true);assert.equal([...guest.db.player.iter()].filter(p=>p.roomId===roomId&&p.online).length,2);
 const late=await connect();await late.reducers.joinRoom({joinCode:room.joinCode,name:'Late subscriber verification',device:'quest'});assert.equal(late.db.timeline.roomId.find(roomId)!.anchorMediaUs,1000000n);
 await mkdir('data/shared-scenes-verification',{recursive:true});await writeFile('data/shared-scenes-verification/report.json',JSON.stringify({scenes:report,websocketTests:{presence:true,timeline:true,speed:true,pose:true,leaderOnly:true,lateJoin:true},physicalHeadsetTest:false},null,2));
 console.log('PASS independent WebSocket clients: join, pause, seek, speed, pose, leader permissions, late join. This is not a physical headset test.');
 }
} finally {clients.forEach(c=>c.disconnect());}
