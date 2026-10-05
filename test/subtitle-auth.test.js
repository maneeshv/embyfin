import test from 'node:test';
import assert from 'node:assert/strict';
import {subtitleStatus} from '#src/subtitles.js';

const jwt=(exp,serial='one')=>`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({exp,serial})).toString('base64url')}.signature`;
const login=(token,base_url='api.opensubtitles.com')=>Response.json({token,base_url,status:200,user:{allowed_downloads:10,allowed_translations:0,level:'Member',user_id:1,ext_installed:false,vip:false}});
async function fixture(t) {
  const env={OPENSUBTITLES_API_KEY:'fixture-key'};
  env.OPENSUBTITLES_USERNAME='fixture-user';env.OPENSUBTITLES_PASSWORD='fixture-password';
  assert.deepEqual(subtitleStatus(env),{available:true,configured:true});
  const {SubtitleSession,subtitleProvider}=await import('#src/subtitle-auth.js');
  const values=new Map(),storage={async get(key){return structuredClone(values.get(key));},async put(key,value){values.set(key,structuredClone(value));}};
  let seconds=1_800_000_000;
  t.mock.method(Date,'now',()=>seconds*1000);
  const session=new SubtitleSession(env,storage);
  const controller={subtitleSession:token=>session.get(token)};
  env.PROCESSOR={idFromName:name=>{assert.equal(name,'media');return name;},get:()=>controller};
  return {env,session,storage,values,SubtitleSession,request:(path='/subtitles',options)=>subtitleProvider(env,path,options),advance:n=>{seconds+=n;},time:()=>seconds};
}

test('automatic subtitle login is shared, durable, private, and routed to the returned official host',async t=>{
  const f=await fixture(t),token=jwt(f.time()+3600),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push([String(url),options]);
    if(String(url).endsWith('/login'))return login(token,'vip-api.opensubtitles.com');
    assert.equal(String(url),'https://vip-api.opensubtitles.com/api/v1/subtitles');
    assert.equal(options.headers.Authorization,`Bearer ${token}`);
    return Response.json({data:[]});
  });
  const results=await Promise.all(Array.from({length:8},()=>f.request()));
  assert(results.every(r=>Array.isArray(r.data)));
  assert.equal(calls.filter(([url])=>url.endsWith('/login')).length,1);
  const [url,options]=calls[0];
  assert.equal(url,'https://api.opensubtitles.com/api/v1/login');
  assert.equal(options.redirect,'manual');
  assert.equal(options.headers['Api-Key'],'fixture-key');
  assert.equal(options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(options.body),{username:'fixture-user',password:'fixture-password'});
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get()).token,token);
  assert(!JSON.stringify([...f.values]).includes('fixture-password'));
  assert(!JSON.stringify([...f.values]).includes('fixture-user'));
  assert(!JSON.stringify([...f.values]).includes('fixture-key'));
});

test('tokens renew before expiry and credential rotation invalidates a durable session',async t=>{
  const f=await fixture(t);let logins=0;
  t.mock.method(globalThis,'fetch',async()=>login(jwt(f.time()+120,String(++logins))));
  const first=await f.session.get();f.advance(59);
  assert.equal((await f.session.get()).token,first.token);
  f.advance(1);const renewed=await f.session.get();assert.notEqual(renewed.token,first.token);
  f.advance(2);f.env.OPENSUBTITLES_PASSWORD='replacement-password';
  assert.notEqual((await new f.SubtitleSession(f.env,f.storage).get()).token,renewed.token);
  assert.equal(logins,3);
});

test('concurrent late authentication failures refresh once and never discard the newer token',async t=>{
  const f=await fixture(t);let logins=0;
  t.mock.method(globalThis,'fetch',async()=>login(jwt(f.time()+3600,String(++logins))));
  const first=await f.session.get();f.advance(2);
  const results=await Promise.all(Array.from({length:6},()=>f.session.get(first.token)));
  assert(results.every(r=>r.token===results[0].token && r.token!==first.token));
  assert.equal((await f.session.get(first.token)).token,results[0].token);
  assert.equal(logins,2);
});

test('invalid account credentials stop further logins even across controller restarts',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({message:'private upstream details'},{status:401});});
  assert.deepEqual(await f.session.get(),{error:'subtitle_login_failed',status:502});
  f.advance(86400);
  assert.deepEqual(await new f.SubtitleSession(f.env,f.storage).get(),{error:'subtitle_login_failed',status:502});
  assert.equal(calls,1);
  f.env.OPENSUBTITLES_PASSWORD='corrected-password';
  t.mock.method(globalThis,'fetch',async()=>{calls++;return login(jwt(f.time()+3600));});
  assert((await f.session.get()).token);assert.equal(calls,2);
});

test('login throttling is durable and valid sessions remain usable during its cooldown',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return login(jwt(f.time()+7200,String(calls)));});
  let current=await f.session.get();
  assert.equal((await f.session.get(current.token)).status,429);
  f.advance(2);current=await f.session.get();
  for(let i=0;i<8;i++){f.advance(2);current=await f.session.get(current.token);assert(current.token);}
  f.advance(2);
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get(current.token)).status,429);
  assert.equal(calls,10);
  f.advance(61);assert((await f.session.get()).token);
});

test('transient login failures back off without exposing provider details',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({password:'private upstream details'},{status:503});});
  assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
  assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
  assert.equal(calls,1);f.advance(61);
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get()).status,502);
  assert.equal(calls,2);
});

test('the hourly login limit survives restarts while cached tokens remain usable',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return login(jwt(f.time()+7200,String(calls)));});
  let current=await f.session.get();
  for(let i=1;i<30;i++){f.advance(61);current=await f.session.get(current.token);assert(current.token);}
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get()).token,current.token);
  f.advance(61);
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get(current.token)).status,429);
  assert.equal(calls,30);f.advance(3601);
  assert((await f.session.get()).token);assert.equal(calls,31);
});

test('a provider login Retry-After survives restart without repeated requests',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'300'}});});
  assert.equal((await f.session.get()).status,429);f.advance(61);
  assert.equal((await new f.SubtitleSession(f.env,f.storage).get()).status,429);
  assert.equal(calls,1);f.advance(240);
  assert.equal((await f.session.get()).status,429);assert.equal(calls,2);
});

test('login timeout and oversized responses remain bounded and do not leak upstream errors',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('fixture-password');});
  assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
  assert.equal((await f.session.get()).status,502);assert.equal(calls,1);f.advance(61);
  t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(33*1024)));
  assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
});

test('login and authenticated provider redirects fail without forwarding credentials',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    calls++;assert.equal(options.redirect,'manual');
    return new Response('',{status:302,headers:{Location:'https://untrusted.test/collect'}});
  });
  assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
  assert.equal(calls,1);f.advance(61);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.redirect,'manual');
    if(String(url).endsWith('/login'))return login(jwt(f.time()+3600));
    calls++;return new Response('',{status:307,headers:{Location:'https://untrusted.test/collect'}});
  });
  await assert.rejects(()=>f.request(),e=>e.code==='subtitle_provider_error');
  assert.equal(calls,2);
});

test('untrusted login hosts and malformed or expired tokens never become authenticated destinations',async t=>{
  const f=await fixture(t);
  for(const payload of [
    {token:jwt(f.time()+3600),base_url:'api.opensubtitles.com.evil.test'},
    {token:jwt(f.time()+3600),base_url:'https://api.opensubtitles.com:443'},
    {token:jwt(f.time()+3600),base_url:'127.0.0.1'},
    {token:'not-a-jwt',base_url:'api.opensubtitles.com'},
    {token:jwt(f.time()-1),base_url:'api.opensubtitles.com'},
  ]) {
    t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
    assert.deepEqual(await f.session.get(),{error:'subtitle_provider_error',status:502});
    f.advance(61);
  }
});

test('an explicit API 401 renews and retries once, with no retries for quota or uncertain downloads',async t=>{
  const f=await fixture(t);let logins=0,requests=0,status=401;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('/login'))return login(jwt(f.time()+3600,String(++logins)));
    requests++;return new Response('',{status});
  });
  await f.session.get();f.advance(2);
  await assert.rejects(()=>f.request('/download',{method:'POST',body:'{}'}),e=>e.code==='subtitle_provider_error');
  assert.equal(logins,2);assert.equal(requests,2);
  for(status of [406,429,500]) {
    f.advance(61);const before=requests;
    await assert.rejects(()=>f.request('/download',{method:'POST',body:'{}'}));
    assert.equal(requests,before+1);assert.equal(logins,2);
  }
  let uncertain=0;
  t.mock.method(globalThis,'fetch',async()=>{uncertain++;throw Error('connection lost after download request');});
  await assert.rejects(()=>f.request('/download',{method:'POST',body:'{}'}),e=>e.code==='subtitle_provider_error');
  assert.equal(uncertain,1);
});

test('one rejected token can recover a subtitle request successfully with the new token',async t=>{
  const f=await fixture(t);let logins=0,requests=0;
  const previous=jwt(f.time()+3600,'old'),replacement=jwt(f.time()+3600,'new');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).endsWith('/login'))return login(++logins===1?previous:replacement);
    requests++;
    return options.headers.Authorization===`Bearer ${previous}`?new Response('',{status:401}):Response.json({data:[{id:'result'}]});
  });
  await f.session.get();f.advance(2);
  assert.deepEqual(await f.request(),{data:[{id:'result'}]});
  assert.equal(logins,2);assert.equal(requests,2);
});

test('partial automatic credentials fail closed while API-key search and manual tokens stay compatible',async t=>{
  const {subtitleProvider}=await import('#src/subtitle-auth.js');
  const env={OPENSUBTITLES_API_KEY:'fixture-key',OPENSUBTITLES_TOKEN:'legacy-token'};let authorization;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{authorization=options.headers.Authorization;return Response.json({data:[]});});
  await subtitleProvider(env,'/subtitles');assert.equal(authorization,'Bearer legacy-token');
  delete env.OPENSUBTITLES_TOKEN;
  await subtitleProvider(env,'/subtitles');assert.equal(authorization,undefined);
  env.OPENSUBTITLES_USERNAME='fixture-user';env.OPENSUBTITLES_TOKEN='legacy-token';
  assert.equal(subtitleStatus(env).configured,false);
  await assert.rejects(()=>subtitleProvider(env,'/subtitles'),e=>e.code==='subtitles_unconfigured');
});
