import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handle} from '#src/worker.js';

class D1 {
  constructor(){this.db=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())this.db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));}
  async batch(items){return Promise.all(items.map(item=>item.all()));}
  prepare(text){const stmt=this.db.prepare(text);let values=[];const query={bind(...args){values=args;return query;},async first(){return stmt.get(...values)||null;},async all(){return {results:stmt.all(...values)};},async run(){return {meta:{changes:Number(stmt.run(...values).changes)}};}};return query;}
}
function fixture(){
  const env={DB:new D1(),APP_ORIGIN:'https://media.test',OWNER_EMAIL:'owner@example.com',SOURCE_BUCKET:'fixture',SOURCE_SCOPE:'',ASSETS:{fetch:()=>new Response('app')},BACKUPS:{get:async()=>null,head:async()=>null}};
  env.DB.db.exec("INSERT INTO sources VALUES('r2','r2','fixture',''); INSERT INTO users(id,email,subject,role,created_at) VALUES('owner','owner@example.com','owner','owner',0),('viewer','viewer@example.com','viewer','viewer',0);");
  return env;
}
const request=(env,user,path,data,headers={})=>handle(new Request(env.APP_ORIGIN+path,{method:data===undefined?'GET':'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','X-Embyfin-User':user,...headers},body:data===undefined?undefined:JSON.stringify(data)}),env,{},()=>({email:user+'@example.com',sub:user}));

test('provider settings writes require owner and CSRF and return only sanitized provider state',async()=>{
  const env=fixture(),providers={editable:true,tmdb:{configured:true,source:'settings',status:'connected'},opensubtitles:{configured:false,source:'none',status:'disconnected'}};let updates=0;
  env.PROCESSOR={idFromName:()=> 'media',get:()=>({providerConfiguration:async()=>({credentials:{},providers}),updateProvider:async()=>{updates++;return {ok:true,providers};}})};
  const data={provider:'tmdb',action:'save',credentials:{token:'fixture-only-token'}};
  assert.equal((await request(env,'viewer','/api/admin/providers',data)).status,403);
  assert.equal((await request(env,'owner','/api/admin/providers',data,{Origin:'https://other.test'})).status,403);
  assert.equal(updates,0);
  const response=await request(env,'owner','/api/admin/providers',data);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,providers});
  assert.equal(updates,1);
});

import {ProviderSettings,providerEnvironment,sealProvider,openProvider} from '#src/providers.js';
import {SubtitleSession,subtitleProvider} from '#src/subtitle-auth.js';
const key=Buffer.alloc(32,7).toString('base64');
const jwt=()=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
function settingsFixture(env={}) {
  env={...env};if(!Object.hasOwn(env,'PROVIDER_ENCRYPTION_KEY'))env.PROVIDER_ENCRYPTION_KEY=key;
  const values=new Map(),storage={async get(k){return structuredClone(values.get(k));},async put(k,v){if(typeof k==='object'){for(const [name,value] of Object.entries(k))values.set(name,structuredClone(value));}else values.set(k,structuredClone(v));}};
  const subtitles=new SubtitleSession(env,storage),settings=new ProviderSettings(env,storage,subtitles);
  env.PROCESSOR={idFromName:()=> 'media',get:()=>({providerConfiguration:()=>settings.configuration(),updateProvider:data=>settings.update(data),subtitleSession:(rejected,snapshot)=>subtitles.get(rejected,snapshot)})};
  return {env,values,storage,subtitles,settings};
}
const save=(settings,provider,credentials)=>settings.update({provider,action:'save',credentials});
function mockProvider(t) {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    url=String(url);calls.push({url,options});assert.equal(options.redirect,'manual');
    if(url.endsWith('/authentication'))return Response.json({success:options.headers.Authorization!=='Bearer bad'});
    if(url.endsWith('/login'))return Response.json({token:jwt(),base_url:'vip-api.opensubtitles.com'});
    if(url.endsWith('/infos/user'))return Response.json({data:{user_id:123}});
    if(url.includes('/subtitles?'))return Response.json({data:[]});
    if(url.includes('/search/movie'))return Response.json({results:[]});
    throw Error('Unexpected test provider request');
  });
  return calls;
}

test('saved credentials and session bearer are encrypted, survive restart, and never enter public status',async t=>{
  const f=settingsFixture(),calls=mockProvider(t);
  const value={apiKey:'fixture-api-key',username:'fixture-user',password:'fixture-password'};
  const saved=await save(f.settings,'opensubtitles',value);
  assert.equal(saved.ok,true);
  assert.equal(saved.providers.opensubtitles.source,'settings');
  assert.equal(saved.providers.opensubtitles.status,'connected');
  const dump=JSON.stringify([...f.values]);
  for(const secret of [...Object.values(value),jwt()])assert(!dump.includes(secret),secret+' must not appear in durable storage');
  for(const secret of Object.values(value))assert(!JSON.stringify(saved).includes(secret));
  const restarted=new ProviderSettings(f.env,f.storage,new SubtitleSession(f.env,f.storage));
  assert.equal((await restarted.configuration()).credentials.OPENSUBTITLES_PASSWORD,value.password);
  const effective=await providerEnvironment(f.env);
  assert.equal(f.env.OPENSUBTITLES_PASSWORD,undefined);
  assert.deepEqual(await subtitleProvider(effective,'/subtitles?query=Arrival'),{data:[]});
  assert.equal(calls.filter(c=>c.url.endsWith('/login')).length,1);
  assert.equal(calls.at(-1).options.headers['Api-Key'],value.apiKey);
  assert.match(calls.at(-1).url,/vip-api/);
});

test('AES-GCM ciphertext is randomized, bound to provider, rejects tampering and wrong or missing keys',async()=>{
  const env={},wrongKey={};env.PROVIDER_ENCRYPTION_KEY=key;wrongKey.PROVIDER_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
  const first=await sealProvider(env,'tmdb',{token:'synthetic'}),second=await sealProvider(env,'tmdb',{token:'synthetic'});
  assert.notEqual(first.iv,second.iv);assert.notEqual(first.ciphertext,second.ciphertext);
  assert.deepEqual(await openProvider(env,'tmdb',first),{token:'synthetic'});
  const damaged={...first,ciphertext:(first.ciphertext[0]==='A'?'B':'A')+first.ciphertext.slice(1)};
  for(const [settings,purpose,record] of [[env,'tmdb',damaged],[env,'opensubtitles',first],[wrongKey,'tmdb',first],[{},'tmdb',first]])await assert.rejects(()=>openProvider(settings,purpose,record),e=>e.status===503);
});

test('deployment fallback, explicit disconnect, repair and failed replacement preserve intended configuration',async t=>{
  const f=settingsFixture({TMDB_READ_TOKEN:'deployment-token'});mockProvider(t);
  assert.equal((await f.settings.configuration()).providers.tmdb.source,'deployment');
  assert.equal((await save(f.settings,'tmdb',{token:'first-token'})).ok,true);
  const before=structuredClone(f.values.get('provider:tmdb'));
  assert.equal((await save(f.settings,'tmdb',{token:'bad'})).error,'provider_connection_failed');
  assert.deepEqual(f.values.get('provider:tmdb'),before);
  assert.equal((await save(f.settings,'tmdb',{token:''})).ok,true);
  assert.equal((await f.settings.configuration()).credentials.TMDB_READ_TOKEN,'first-token');
  const disconnected=await f.settings.update({provider:'tmdb',action:'disconnect'});
  assert.equal(disconnected.providers.tmdb.source,'disabled');
  assert.equal((await f.settings.configuration()).credentials.TMDB_READ_TOKEN,'');
  const restart=new ProviderSettings(f.env,f.storage,f.subtitles);
  assert.equal((await restart.configuration()).providers.tmdb.source,'disabled');
  f.values.set('provider:tmdb',{version:1,iv:'broken',ciphertext:'broken'});
  assert.equal((await restart.configuration()).credentials.TMDB_READ_TOKEN,'');
  assert.equal((await restart.configuration()).providers.tmdb.status,'error');
  assert.equal((await save(restart,'tmdb',{token:'replacement-token'})).ok,true);
  delete f.env.PROVIDER_ENCRYPTION_KEY;
  assert.equal((await restart.configuration()).providers.editable,false);
  assert.equal((await restart.configuration()).credentials.TMDB_READ_TOKEN,'');
  assert.equal((await restart.update({provider:'tmdb',action:'disconnect'})).ok,true);
});

test('partial edits retain secrets, concurrent provider changes survive, sensitive input is bounded',async t=>{
  const f=settingsFixture();mockProvider(t);
  const results=await Promise.all([save(f.settings,'tmdb',{token:'movie-token'}),save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'sub-user',password:'sub-pass'})]);
  assert(results.every(result=>result.ok));
  const c=await f.settings.configuration();assert(c.providers.tmdb.configured);assert(c.providers.opensubtitles.configured);
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'',username:'',password:''})).ok,true);
  assert.equal((await save(f.settings,'tmdb',{token:'x'.repeat(4097)})).error,'invalid_input');
  assert.equal((await save(f.settings,'tmdb',{token:33})).error,'invalid_input');
  assert.equal((await save(f.settings,'tmdb',{surprise:'value'})).error,'invalid_provider_credentials');
  assert.equal((await save(f.settings,'opensubtitles',{username:'bad\nuser'})).error,'invalid_input');
});

test('candidate testing and failed replacements cannot reset durable subtitle login limits',async t=>{
  const f=settingsFixture(),calls=mockProvider(t);
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'sub-user',password:'sub-pass'})).ok,true);
  const before=structuredClone(f.values.get('provider:opensubtitles'));
  assert.equal((await save(f.settings,'opensubtitles',{password:'changed'})).error,'subtitle_rate_limited');
  assert.deepEqual(f.values.get('provider:opensubtitles'),before);
  assert.deepEqual(await subtitleProvider(await providerEnvironment(f.env),'/subtitles?query=Arrival'),{data:[]});
  assert.equal(calls.filter(c=>c.url.endsWith('/login')).length,1);
  assert.equal(f.values.get('subtitleSession').attempts.length,1);
  await f.settings.update({provider:'opensubtitles',action:'disconnect'});
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'new-user',password:'new-pass'})).error,'subtitle_rate_limited');
  assert.equal(f.values.get('subtitleSession').attempts.length,1);
});

test('broken provider storage leaves assets, video catalog and settings repair available',async()=>{
  const env=fixture();let reads=0;
  env.PROCESSOR={idFromName:()=> 'media',get:()=>({providerConfiguration:async()=>{reads++;throw Error('private storage error');}})};
  assert.equal((await request(env,'owner','/')).status,200);
  assert.equal((await request(env,'owner','/api/videos')).status,200);
  assert.equal(reads,0);
  const session=await request(env,'owner','/api/session');assert.equal(session.status,200);assert.equal((await session.json()).features.metadata,false);
  const admin=await request(env,'owner','/api/admin');assert.equal(admin.status,200);assert.equal((await admin.json()).providers.tmdb.error,'provider_settings_unavailable');
});

test('test connection persists safe status without changing source or credentials, including rejection',async t=>{
  const f=settingsFixture({TMDB_READ_TOKEN:'deployment-token'});let accepted=true;
  t.mock.method(globalThis,'fetch',async()=>Response.json({success:accepted}));
  const checked=await f.settings.update({provider:'tmdb',action:'test'});
  assert.equal(checked.providers.tmdb.source,'deployment');
  assert.equal(checked.providers.tmdb.status,'connected');
  assert.equal((await f.settings.configuration()).providers.tmdb.status,'connected');
  accepted=false;
  assert.equal((await f.settings.update({provider:'tmdb',action:'test'})).error,'provider_connection_failed');
  assert.equal((await f.settings.configuration()).providers.tmdb.status,'error');
  assert.equal((await f.settings.configuration()).credentials.TMDB_READ_TOKEN,'deployment-token');
  accepted=true;
  assert.equal((await f.settings.update({provider:'tmdb',action:'test'})).ok,true);
  assert.equal((await f.settings.configuration()).providers.tmdb.status,'connected');
  f.env.TMDB_READ_TOKEN='different-deployment';
  assert.equal((await f.settings.configuration()).providers.tmdb.status,'configured');
});

test('testing saved subtitles retains an encrypted usable credential record',async t=>{
  const f=settingsFixture();mockProvider(t);
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'sub-user',password:'sub-pass'})).ok,true);
  const tested=await f.settings.update({provider:'opensubtitles',action:'test'});
  assert.equal(tested.providers.opensubtitles.status,'connected');
  assert.equal((await f.settings.configuration()).credentials.OPENSUBTITLES_PASSWORD,'sub-pass');
});

test('provider Retry-After cannot be bypassed by submitting changed candidate credentials',async t=>{
  const f=settingsFixture();let seconds=1_900_000_000,logins=0;
  t.mock.method(Date,'now',()=>seconds*1000);
  t.mock.method(globalThis,'fetch',async()=>{logins++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});});
  const first={apiKey:'sub-key',username:'sub-user',password:'sub-pass'};
  assert.equal((await save(f.settings,'opensubtitles',first)).error,'subtitle_rate_limited');
  seconds+=5;
  assert.equal((await save(f.settings,'opensubtitles',{...first,password:'new-pass'})).error,'subtitle_rate_limited');
  assert.equal(logins,1);
});

test('owner HTTP settings enable actual movie searches without exposing credentials or mutating deployment bindings',async t=>{
  const f=settingsFixture(fixture()),calls=mockProvider(t);
  f.env.DB.db.exec("INSERT INTO libraries(id,source_id,name,prefix,created_at) VALUES('library','r2','Movies','movies/',0); INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) VALUES('movie','r2','library','movies/Arrival.mkv','Arrival.mkv','','arrival.mkv','arrival.mkv',123,'2026-01-01','etag','rev1',0,0);");
  const response=await request(f.env,'owner','/api/admin/providers',{provider:'tmdb',action:'save',credentials:{token:'fixture-secret-token'}});
  assert.equal(response.status,200);assert(!(await response.text()).includes('fixture-secret-token'));
  const state=await request(f.env,'owner','/api/admin');const stateText=await state.text();assert(!stateText.includes('fixture-secret-token'));assert(!stateText.includes('credentials'));
  const search=await request(f.env,'owner','/api/videos/movie/movie/search?q=Arrival');
  assert.equal(search.status,200);assert.deepEqual(await search.json(),{items:[]});
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer fixture-secret-token');
  assert.equal(f.env.TMDB_READ_TOKEN,undefined);
  const before=calls.length;
  assert.equal((await request(f.env,'viewer','/api/videos/movie/movie/search?q=Arrival')).status,404);
  assert.equal(calls.length,before);
  const rows=f.env.DB.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for(const {name} of rows)assert(!JSON.stringify(f.env.DB.db.prepare(`SELECT * FROM "${name}"`).all()).includes('fixture-secret-token'));
});

test('encrypted cached tokens renew after restart using settings credentials',async t=>{
  let seconds=1_900_000_000;t.mock.method(Date,'now',()=>seconds*1000);
  const f=settingsFixture(),calls=mockProvider(t),candidate={apiKey:'sub-key',username:'sub-user',password:'sub-pass'};
  assert.equal((await save(f.settings,'opensubtitles',candidate)).ok,true);
  const first=jwt(),overrides=(await f.settings.configuration()).credentials;
  seconds+=3541;
  const restarted=new SubtitleSession(f.env,f.storage),renewed=await restarted.get('',overrides);
  assert.notEqual(renewed.token,first);assert.equal(calls.filter(c=>c.url.endsWith('/login')).length,2);
  assert(!JSON.stringify([...f.values]).includes(renewed.token));
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{username:candidate.username,password:candidate.password});
});

test('lost encryption keys fail closed but replacing credentials repairs a cached session without resetting limits',async t=>{
  let seconds=1_900_000_000;t.mock.method(Date,'now',()=>seconds*1000);
  const f=settingsFixture();mockProvider(t);
  const candidate={apiKey:'sub-key',username:'sub-user',password:'sub-pass'};
  assert.equal((await save(f.settings,'opensubtitles',candidate)).ok,true);
  f.env.PROVIDER_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
  assert.equal((await f.settings.configuration()).providers.opensubtitles.status,'error');
  seconds+=2;
  assert.equal((await save(f.settings,'opensubtitles',candidate)).ok,true);
  assert.equal(f.values.get('subtitleSession').attempts.length,2);
  assert.equal((await f.settings.configuration()).providers.opensubtitles.status,'connected');
});

test('malformed connection responses cannot replace saved credentials or expose provider response bodies',async t=>{
  const f=settingsFixture();let invalid=false;
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(String(url).endsWith('/login'))return Response.json({token:jwt(),base_url:'api.opensubtitles.com'});
    return Response.json(invalid?{data:{private:'upstream-sensitive-text'}}:{data:{user_id:123}});
  });
  const value={apiKey:'sub-key',username:'sub-user',password:'sub-pass'};
  assert.equal((await save(f.settings,'opensubtitles',value)).ok,true);
  const before=structuredClone(f.values.get('provider:opensubtitles'));invalid=true;
  const result=await save(f.settings,'opensubtitles',{});
  assert.equal(result.error,'provider_connection_failed');
  assert.deepEqual(f.values.get('provider:opensubtitles'),before);
  assert(!JSON.stringify(result).includes('upstream-sensitive-text'));
});

test('failed candidate provider cooldown preserves the original session across restart without bypassing login limits',async t=>{
  let seconds=1_900_000_000,logins=0;t.mock.method(Date,'now',()=>seconds*1000);
  const f=settingsFixture();let reject=false;
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(String(url).endsWith('/login')){logins++;return reject?new Response('{}',{status:429,headers:{'Retry-After':'120'}}):Response.json({token:jwt(),base_url:'api.opensubtitles.com'});}
    return Response.json(String(url).endsWith('/infos/user')?{data:{user_id:123}}:{data:[]});
  });
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'sub-user',password:'sub-pass'})).ok,true);
  const old=(await f.settings.configuration()).credentials;seconds+=2;reject=true;
  assert.equal((await save(f.settings,'opensubtitles',{password:'wrong-password'})).error,'subtitle_rate_limited');
  assert.deepEqual(await subtitleProvider(await providerEnvironment(f.env),'/subtitles?query=Arrival'),{data:[]});
  const restarted=new SubtitleSession(f.env,f.storage);
  assert((await restarted.get('',old)).token);
  seconds+=5;
  assert.equal((await save(f.settings,'opensubtitles',{password:'another-password'})).error,'subtitle_rate_limited');
  assert.equal(logins,2);
  assert.equal(f.values.get('subtitleSession').attempts.length,2);
});

test('old session remains usable during candidate verification and after successful login with invalid user information',async t=>{
  let seconds=1_900_000_000;t.mock.method(Date,'now',()=>seconds*1000);
  const f=settingsFixture();let candidate=false,release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(String(url).endsWith('/login'))return Response.json({token:jwt(),base_url:'api.opensubtitles.com'});
    if(String(url).endsWith('/infos/user')){
      if(candidate){entered();return new Promise(resolve=>{release=()=>resolve(Response.json({data:{}}));});}
      return Response.json({data:{user_id:123}});
    }
    return Response.json({data:[]});
  });
  assert.equal((await save(f.settings,'opensubtitles',{apiKey:'sub-key',username:'sub-user',password:'sub-pass'})).ok,true);
  const original=structuredClone(f.values.get('provider:opensubtitles'));seconds+=2;candidate=true;
  const pending=save(f.settings,'opensubtitles',{password:'different-password'});
  await waiting;
  try {assert.deepEqual(await subtitleProvider(await providerEnvironment(f.env),'/subtitles?query=Arrival'),{data:[]});}
  finally {release();}
  assert.equal((await pending).error,'provider_connection_failed');
  assert.deepEqual(f.values.get('provider:opensubtitles'),original);
  assert.deepEqual(await subtitleProvider(await providerEnvironment(f.env),'/subtitles?query=Arrival'),{data:[]});
  assert.equal(f.values.get('subtitleSession').attempts.length,2);
});
