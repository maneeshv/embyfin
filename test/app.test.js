import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {handle} from '../src/worker.js';
import {one,all,run,now,byteRange,normalize,revision} from '../src/core.js';
import {startScan,scanStep,scanIntent} from '../src/scans.js';
import {catalog,video,personal,folders} from '../src/catalog.js';
import {claim,validJob,expireJobs,machine} from '../src/jobs.js';
import {machineToken,identity} from '../src/auth.js';
import {R2Source} from '../src/storage.js';
import {backupTick,backupState,requestBackup} from '../src/backup.js';
import {createHash} from 'node:crypto';

class D1 {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));}
  prepare(text){
    const stmt=this.db.prepare(text);let values=[];
    const query={bind(...args){values=args;return query;},async first(){return stmt.get(...values)||null;},async all(){return {results:stmt.all(...values).map(r=>({...r})),meta:{changes:0}};},async run(){const result=stmt.run(...values);return {results:[],meta:{changes:Number(result.changes)}};},text,values:()=>values};return query;
  }
  async batch(items){this.db.exec('BEGIN');try{const results=[];for(const item of items){const stmt=this.db.prepare(item.text);if(/^\s*(SELECT|WITH)\b/i.test(item.text))results.push({results:stmt.all(...item.values()).map(r=>({...r})),meta:{changes:0}});else{const r=stmt.run(...item.values());results.push({results:[],meta:{changes:Number(r.changes)}});}}this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class Bucket {
  constructor(){this.items=new Map();}
  async put(key,value){const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(await new Response(value).arrayBuffer());this.items.set(key,bytes);return {key};}
  async head(key){return this.items.has(key)?{key,size:this.items.get(key).length}:null;}
  async get(key){const bytes=this.items.get(key);return bytes?{key,size:bytes.length,body:new Response(bytes).body,json:()=>new Response(bytes).json()}:null;}
  async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.items.delete(key);}
  async list(){return {objects:[...this.items.keys()].map(key=>({key})),truncated:false};}
  async createMultipartUpload(key){const parts=[];return {uploadPart:async(n,bytes)=>{parts[n-1]=new Uint8Array(bytes);return {partNumber:n,etag:String(n)};},complete:async()=>this.put(key,new Blob(parts)),abort:async()=>{}};}
}
const object=(key,tag='1',bytes=10)=>({key,bytes,etag:`"${tag}"`,modified:'2026-09-01T00:00:00.000Z'});
async function fixture(){
  const env={DB:new D1(),POSTERS:new Bucket(),BACKUPS:new Bucket(),ASSETS:{fetch:()=>new Response('app')},APP_ORIGIN:'https://media.test',OWNER_EMAIL:'owner@example.com',SOURCE_BUCKET:'fixture',SOURCE_SCOPE:'',SOURCE_ENDPOINT:'https://account.r2.cloudflarestorage.com',SOURCE_ACCESS_KEY_ID:'test',SOURCE_SECRET_ACCESS_KEY:'test',MACHINE_SECRET:'x'.repeat(40)};
  await run(env.DB,"INSERT INTO sources VALUES('r2','r2','fixture','')");
  for(const [id,email,role]of [['owner','owner@example.com','owner'],['alice','alice@example.com','viewer'],['bob','bob@example.com','viewer']])await run(env.DB,'INSERT INTO users(id,email,subject,role,created_at) VALUES(?,?,?,?,?)',id,email,id,role,now());
  for(const [id,prefix]of [['family','family/'],['private','family-private/']])await run(env.DB,"INSERT INTO libraries(id,source_id,name,prefix,created_at,next_scan) VALUES(?,'r2',?,?,?,?)",id,id,prefix,now(),2147483647);
  await run(env.DB,"INSERT INTO grants VALUES('alice','family')");await run(env.DB,"INSERT INTO grants VALUES('bob','private')");
  const objects=[object('family/旅行 #50%_STRASSE.MP4'),object('family/nested/straße.mp4'),object('family-private/secret.mp4')];
  const source={list:async prefix=>({objects:objects.filter(o=>o.key.startsWith(prefix)),cursor:null}),head:async key=>objects.find(o=>o.key===key)||null};
  for(const id of ['family','private']){await startScan(env,id);await scanStep(env,source);await scanStep(env,source);}
  const alice={id:'alice',role:'viewer'},bob={id:'bob',role:'viewer'},v=await one(env.DB,"SELECT * FROM videos WHERE object_key='family/旅行 #50%_STRASSE.MP4'");
  return {env,source,objects,alice,bob,v};
}
const request=(env,user,path,data,headers={})=>handle(new Request(env.APP_ORIGIN+path,{method:data===undefined?'GET':'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','X-Embyfin-User':user,...headers},body:data===undefined?undefined:JSON.stringify(data)}),env,{},()=>({email:user+'@example.com',sub:user}));

test('Range contract handles full, suffix, open, clamped, malformed and multiple ranges',()=>{
  assert.equal(byteRange(null,10),null);assert.deepEqual(byteRange('bytes=2-',10),{start:2,end:9});assert.deepEqual(byteRange('bytes=-4',10),{start:6,end:9});assert.deepEqual(byteRange('bytes=4-100',10),{start:4,end:9});
  for(const input of ['bytes=10-','bytes=4-2','bytes=-0','bytes=-','bytes=0-1,5-6','invalid','bytes=999999999999999999999-'])assert.throws(()=>byteRange(input,10),e=>e.status===416);
  assert.throws(()=>byteRange('bytes=0-',0));
});
test('Unicode full folding, literal wildcards, exact storage identity and disjoint projections',async()=>{
  const {env,alice,bob,v}=await fixture();
  assert.equal(normalize('Straße Σς'),normalize('STRASSE σσ'));
  let result=await catalog(env,alice,new URLSearchParams({q:'%_strasse'}));assert.equal(result.total,1);assert.equal(result.items[0].id,v.id);assert.equal(result.items[0].path,'旅行 #50%_STRASSE.MP4');
  assert(!('object_key' in result.items[0]));assert(!('etag' in result.items[0]));
  assert.equal((await catalog(env,bob,new URLSearchParams({q:'旅行'}))).total,0);
  assert.equal((await catalog(env,alice,new URLSearchParams({q:'secret'}))).total,0);
  assert.deepEqual((await folders(env,alice,new URLSearchParams({library:'family'}))).items,[{name:'nested/',path:'nested/'}]);
  assert.equal((await folders(env,bob,new URLSearchParams({library:'family'}))).items.length,0);
  await assert.rejects(()=>video(env,bob,v.id),e=>e.status===404);
});
test('non-overlap, root-library conflict, and source freeze are database invariants',async()=>{
  const {env}=await fixture();
  await assert.rejects(()=>run(env.DB,"INSERT INTO libraries(id,source_id,name,prefix,created_at) VALUES('root','r2','Root','',0)"),/overlapping/);
  await assert.rejects(()=>run(env.DB,"UPDATE libraries SET prefix='changed/' WHERE id='family'"),/frozen/);
  await run(env.DB,"UPDATE libraries SET name='Renamed' WHERE id='family'");
  assert.equal((await one(env.DB,"SELECT name FROM libraries WHERE id='family'")).name,'Renamed');
});
test('multi-page and short non-final scans resume with no browser and unchanged scans do not re-enqueue',async()=>{
  const {env,source,v}=await fixture();let calls=0;
  const o=object('family/new.mp4');source.list=async(prefix,cursor)=>{calls++;return cursor?{objects:[o],cursor:null}:{objects:[o],cursor:'next'};};
  await startScan(env,'family');await scanStep(env,source);
  assert.equal((await one(env.DB,"SELECT cursor FROM scans WHERE status='listing'")).cursor,'next');
  await scanStep(env,source);await scanStep(env,source);await scanStep(env,source);
  assert.equal(calls,2);assert.equal((await one(env.DB,"SELECT count(*) n FROM videos WHERE object_key='family/new.mp4'")).n,1);
  assert.equal((await one(env.DB,'SELECT count(*) n FROM jobs WHERE video_id=?',v.id)).n,1);
});
test('interrupted source requests retain the cursor and overlapping ticks cannot duplicate work',async()=>{
  const {env,source}=await fixture();await startScan(env,'family');await run(env.DB,"UPDATE scans SET cursor='checkpoint' WHERE status='listing'");
  source.list=async()=>{throw Object.assign(Error(),{code:'source_network'});};await scanStep(env,source);
  assert.equal((await one(env.DB,"SELECT cursor FROM scans WHERE status='listing'")).cursor,'checkpoint');
  let calls=0;source.list=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {objects:[],cursor:null};};
  await Promise.all([scanStep(env,source),scanStep(env,source)]);assert.equal(calls,1);
});
test('failed listing never reconciles missing objects; expired cursors restart safely; paused runs stay paused',async()=>{
  const {env,source}=await fixture();await startScan(env,'family');
  source.list=async()=>{throw Object.assign(Error(),{code:'source_permission'});};await scanStep(env,source);
  assert.equal((await one(env.DB,'SELECT count(*) n FROM videos WHERE available=1')).n,3);
  await startScan(env,'family');await run(env.DB,"UPDATE scans SET cursor='expired' WHERE status='listing'");
  source.list=async()=>{throw Object.assign(Error(),{code:'invalid_cursor'});};await scanStep(env,source);
  assert.equal((await one(env.DB,"SELECT cursor FROM scans WHERE status='listing'")).cursor,null);
  await scanIntent(env,'family','pause');await run(env.DB,"UPDATE libraries SET next_scan=0 WHERE id='family'");await scanStep(env,source);
  assert.equal((await one(env.DB,"SELECT count(*) n FROM scans WHERE library_id='family' AND status='paused'")).n,1);
  await assert.rejects(()=>scanIntent(env,'family','start'),e=>e.code==='scan_paused');
});
test('missing reconciliation requires exact absence; failed HEAD preserves availability and history',async()=>{
  const {env,source,alice,v}=await fixture();await personal(env,alice,v,'favorite',{favorite:true});
  source.list=async()=>({objects:[],cursor:null});source.head=async()=>{throw Error('permission');};await startScan(env,'family');await scanStep(env,source);await scanStep(env,source);
  assert.equal((await one(env.DB,'SELECT available FROM videos WHERE id=?',v.id)).available,1);
  source.head=async()=>null;await startScan(env,'family');await scanStep(env,source);await scanStep(env,source);await scanStep(env,source);
  assert.equal((await one(env.DB,'SELECT available FROM videos WHERE id=?',v.id)).available,0);
  assert.equal((await one(env.DB,'SELECT favorite FROM user_video WHERE video_id=?',v.id)).favorite,1);
});
test('replacement clears current-revision history, preserves favorite, and fences delayed playback',async()=>{
  const {env,source,objects,alice,v}=await fixture();await personal(env,alice,v,'favorite',{favorite:true});
  const session=await personal(env,alice,v,'session',{revision:v.revision});
  await personal(env,alice,v,'progress',{revision:v.revision,generation:session.generation,sequence:1,position:8,ended:true});
  assert.equal((await catalog(env,alice,new URLSearchParams({section:'recent'}))).total,1);
  objects[0]=object(v.object_key,'replacement');await startScan(env,'family');await scanStep(env,source);
  const state=await one(env.DB,'SELECT * FROM user_video WHERE video_id=?',v.id);assert.equal(state.favorite,1);assert.equal(state.position,0);assert.equal(state.watched,0);assert.equal(state.last_watched,null);
  assert.equal((await catalog(env,alice,new URLSearchParams({section:'recent'}))).total,0);
  await assert.rejects(()=>personal(env,alice,v,'progress',{revision:v.revision,generation:session.generation,sequence:2,position:9}),e=>e.code==='stale_playback');
});
test('new playback sessions and increasing sequence reject out-of-order writes; favorites remain private',async()=>{
  const {env,alice,bob,v}=await fixture();const first=await personal(env,alice,v,'session',{revision:v.revision});const second=await personal(env,alice,v,'session',{revision:v.revision});
  await assert.rejects(()=>personal(env,alice,v,'progress',{...first,sequence:1,position:4}),e=>e.code==='stale_playback');
  await personal(env,alice,v,'progress',{...second,sequence:2,position:7});
  await assert.rejects(()=>personal(env,alice,v,'progress',{...second,sequence:1,position:2}),e=>e.code==='stale_playback');
  await personal(env,alice,v,'favorite',{favorite:true});assert.equal((await catalog(env,bob,new URLSearchParams({section:'favorites'}))).total,0);
});
test('HTTP routes deny guessed IDs, revocation, disabled users/libraries, CSRF and wrong-account writes',async()=>{
  const {env,v}=await fixture();
  for(const suffix of ['', '/poster','/media','/availability'])assert.equal((await request(env,'bob','/api/videos/'+v.id+suffix)).status,404);
  assert.equal((await request(env,'alice','/api/admin')).status,403);
  assert.equal((await request(env,'alice','/api/videos/'+v.id+'/favorite',{favorite:true},{Origin:'https://evil.test'})).status,403);
  assert.equal((await request(env,'alice','/api/videos/'+v.id+'/favorite',{favorite:true},{'X-Embyfin-User':'bob'})).status,403);
  await run(env.DB,"DELETE FROM grants WHERE user_id='alice'");assert.equal((await request(env,'alice','/api/videos/'+v.id)).status,404);
  await run(env.DB,"INSERT INTO grants VALUES('alice','family')");await run(env.DB,"UPDATE libraries SET enabled=0 WHERE id='family'");assert.equal((await request(env,'alice','/api/videos/'+v.id)).status,404);
  await run(env.DB,"UPDATE users SET enabled=0 WHERE id='alice'");assert.equal((await request(env,'alice','/api/session')).status,403);
});
test('Access-admitted unknown accounts and production fake headers do not gain access',async()=>{
  const {env}=await fixture();assert.equal((await request(env,'stranger','/api/session')).status,403);
  env.ACCESS_ISSUER='https://access.test';env.ACCESS_AUD='app';
  assert.equal((await handle(new Request(env.APP_ORIGIN+'/api/session',{headers:{'X-User':'owner','Cf-Access-Authenticated-User-Email':env.OWNER_EMAIL}}),env,{})).status,401);
});
test('Access assertions require signature, expected audience/issuer and expiry',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test';jwk.alg='RS256';
  const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[jwk]});
  try{const env={ACCESS_ISSUER:'https://signed-access.test',ACCESS_AUD:'app'};
    const token=await new SignJWT({email:'alice@example.com'}).setProtectedHeader({alg:'RS256',kid:'test'}).setSubject('alice').setIssuer(env.ACCESS_ISSUER).setAudience('app').setExpirationTime('2m').sign(privateKey);
    assert.equal((await identity(new Request('https://media.test',{headers:{'Cf-Access-Jwt-Assertion':token}}),env)).sub,'alice');
    await assert.rejects(()=>identity(new Request('https://media.test',{headers:{'Cf-Access-Jwt-Assertion':token}}),{...env,ACCESS_AUD:'other'}),e=>e.status===401);
  }finally{globalThis.fetch=old;}
});
test('native streaming returns real byte ranges, HEAD, validators and fails on replacement',async()=>{
  const {env,v}=await fixture();const bytes=new TextEncoder().encode('0123456789'),old=globalThis.fetch;
  let changed=false;globalThis.fetch=async req=>{
    const headers={'ETag':changed?'"new"':v.etag,'Last-Modified':new Date(v.modified).toUTCString(),'Content-Type':'video/mp4','Content-Length':'10'};
    if(req.method==='HEAD')return new Response(null,{headers});
    const range=byteRange(req.headers.get('Range'),10);
    if(range){headers['Content-Range']=`bytes ${range.start}-${range.end}/10`;headers['Content-Length']=String(range.end-range.start+1);return new Response(bytes.slice(range.start,range.end+1),{status:206,headers});}
    return new Response(bytes,{headers});
  };
  try{
    let r=await request(env,'alice',`/api/videos/${v.id}/media`,undefined,{Range:'bytes=-3'});assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 7-9/10');assert.equal(await r.text(),'789');assert.equal(r.headers.get('Cache-Control'),'private, no-store');
    r=await request(env,'alice',`/api/videos/${v.id}/media`,undefined,{Range:'bytes=50-'});assert.equal(r.status,416);assert.equal(r.headers.get('Content-Range'),'bytes */10');
    r=await request(env,'alice',`/api/videos/${v.id}/media`,undefined,{'If-None-Match':v.etag});assert.equal(r.status,304);
    r=await request(env,'alice',`/api/videos/${v.id}/media`,undefined,{'If-Match':'W/'+v.etag});assert.equal(r.status,412);
    r=await request(env,'alice',`/api/videos/${v.id}/media`,undefined,{'If-None-Match':'W/'+v.etag});assert.equal(r.status,304);
    changed=true;r=await request(env,'alice',`/api/videos/${v.id}/media`);assert.equal(r.status,409);
  }finally{globalThis.fetch=old;}
});
test('processor claims are singleton, paused libraries cannot claim, expired leases and stale callbacks are fenced',async()=>{
  const {env}=await fixture(),time=now();
  await run(env.DB,"INSERT INTO processor_runs(slot,token,status,started_at,deadline,lease_until,heartbeat,read_limit,job_seconds) VALUES(1,'run','active',?,?,?,?,?,120)",time,time+600,time+90,time,1024);
  const first=await claim(env,'run');assert(first);assert.equal(await claim(env,'run'),null);
  await assert.rejects(()=>validJob(env,'run',first.id,'wrong'),e=>e.code==='stale_job');
  await run(env.DB,"UPDATE processor_runs SET status='stopped' WHERE slot=1");await expireJobs(env);
  await assert.rejects(()=>validJob(env,'run',first.id,first.lease),e=>e.code==='stale_job');
  assert.equal((await one(env.DB,'SELECT state FROM jobs WHERE id=?',first.id)).state,'pending');
});
test('maintenance is independent of D1, gates browser and machine requests',async()=>{
  const {env}=await fixture();env.DB={prepare(){throw Error('D1 unavailable');}};await env.BACKUPS.put('control/maintenance.json','{}');
  assert.equal((await request(env,'alice','/api/session')).status,503);assert.equal((await request(env,'alice','/machine/claim',{})).status,503);
});
test('jobs reserve read budgets, validate uploaded artifacts, publish once, and reject stale completions',async()=>{
  const {env,source}=await fixture(),time=now();
  await run(env.DB,"INSERT INTO processor_runs(slot,token,status,started_at,deadline,lease_until,heartbeat,read_limit,job_seconds) VALUES(1,'run','active',?,?,?,?,?,120)",time,time+600,time+90,time,8);
  const job=await claim(env,'run'),token=await machineToken(env,'run',time+600),controller={heartbeat:async()=>{}};
  source.access=async()=>({url:'https://account.r2.cloudflarestorage.com/fixture',headers:{}});
  const call=(action,data,poster)=>machine(new Request(env.APP_ORIGIN+'/machine/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Job-Id':job.id,'X-Job-Lease':job.lease,'Content-Type':poster?'image/jpeg':'application/json',...(poster?{'Content-Length':String(poster.length)}:{})},body:poster||JSON.stringify(data||{})}),env,source,controller);
  assert.equal((await call('access',{start:0,end:4})).status,200);
  await assert.rejects(()=>call('access',{start:0,end:4}),e=>e.code==='read_budget_exceeded');
  await assert.rejects(()=>call('complete',{}),e=>e.code==='poster_missing');
  const jpeg=new Uint8Array([255,216,255,217]);await call('poster',{},jpeg);
  await call('complete',{duration:1,width:320,height:180,videoCodec:'h264',audioCodec:'aac',container:'mp4',elapsedMs:100,cpuMs:5,peakRss:1000,peakScratch:4});
  assert.equal((await one(env.DB,'SELECT enrichment FROM videos WHERE id=(SELECT video_id FROM jobs WHERE id=?)',job.id)).enrichment,'ready');
  await assert.rejects(()=>call('complete',{}),e=>e.code==='stale_job');
});
test('backup drains before export, stores streamed checksum only after copy, and restores with revoked users denied',async()=>{
  const {env,alice,v}=await fixture();await personal(env,alice,v,'favorite',{favorite:true});
  await assert.rejects(()=>requestBackup(env),e=>e.code==='backup_not_configured');assert.equal(await backupState(env),null);
  Object.assign(env,{CF_API_TOKEN:'operator',CF_ACCOUNT_ID:'account',CF_DATABASE_ID:'database',BACKUP_HOUR_UTC:'0'});
  const state=await requestBackup(env);assert.equal(state.status,'draining');let stops=0,requests=0;
  const controller={halt:async()=>{stops++;}},original=globalThis.fetch,exportText='-- consistent export\nSELECT 1;';
  globalThis.fetch=async url=>{requests++;return String(url).includes('api.cloudflare.com')?Response.json({success:true,result:{status:'complete',at_bookmark:'bookmark',result:{signed_url:'https://export.test/database.sql'}}}):new Response(exportText);};
  try{
    assert.equal(await backupTick(env,controller),true);assert.equal(requests,0);assert.equal(stops,1);
    state.started=now()-101;await env.BACKUPS.put('control/backup.json',JSON.stringify(state));
    assert.equal(await backupTick(env,controller),false);
    const complete=await backupState(env);assert.equal(complete.status,'complete');assert.equal(complete.lastComplete.bytes,new TextEncoder().encode(exportText).length);
    assert.equal(complete.lastComplete.sha256,createHash('sha256').update(exportText).digest('hex'));
    assert(await env.BACKUPS.head(complete.lastComplete.key+'.json'));
    env.DB.db.exec(readFileSync(new URL('../ops/recover.sql',import.meta.url),'utf8'));
    assert.equal((await one(env.DB,'SELECT favorite FROM user_video WHERE video_id=?',v.id)).favorite,1);
    assert.equal((await request(env,'alice','/api/session')).status,403);
    const checks=env.DB.db.prepare(readFileSync(new URL('../ops/verify-restore.sql',import.meta.url),'utf8')).all();
    assert(checks.filter(r=>r.record_type.endsWith('_must_be_zero')).every(r=>r.value===0));
  }finally{globalThis.fetch=original;}
});
test('10,000-item fixture retains bounded pages, exact folder scopes, and unknown duration last',async()=>{
  const {env,alice}=await fixture();
  env.DB.db.exec('BEGIN');const insert=env.DB.db.prepare(`INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen,duration)
    VALUES(?,'r2','family',?,?,'collection/',?,?,1,'2026-09-01T00:00:00Z','e','r',0,0,?)`);
  for(let i=0;i<10000;i++){const name=`Clip ${String(i).padStart(5,'0')}.mp4`;insert.run('bench-'+i,'family/collection/'+name,name,name.toLowerCase(),('collection/'+name).toLowerCase(),i%2?null:i+1);}env.DB.db.exec('COMMIT');
  const start=performance.now(),result=await catalog(env,alice,new URLSearchParams({q:'Clip 099',limit:'25',sort:'duration',direction:'asc'}));
  assert.equal(result.total,100);assert.equal(result.items.length,25);assert(result.items.every(v=>v.duration!==null));
  assert.equal((await catalog(env,alice,new URLSearchParams({folder:'collection/',recursive:'1'}))).total,10000);
  console.log(JSON.stringify({check:'10000_item_local_search',elapsedMs:Math.round(performance.now()-start)}));
});
