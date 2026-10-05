import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {listSubtitles,searchSubtitles,importSubtitle,subtitleContent,subtitleStatus} from '#src/subtitles.js';
import {SubtitleSession} from '#src/subtitle-auth.js';

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) this.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  }
  prepare(text) {
    const stmt=this.db.prepare(text); let values=[];
    const query={bind(...args){values=args;return query;},async first(){return stmt.get(...values)||null;},async all(){return {results:stmt.all(...values).map(row=>({...row}))};},async run(){const result=stmt.run(...values);return {meta:{changes:Number(result.changes)}};}};
    return query;
  }
}
function fixture() {
  const DB=new D1(), db=DB.db;
  db.exec("INSERT INTO sources VALUES('r2','r2','fixture',''); INSERT INTO users(id,email,role,created_at) VALUES('owner','owner@test','owner',0),('viewer','viewer@test','viewer',0); INSERT INTO libraries(id,source_id,name,prefix,created_at) VALUES('library','r2','Movies','movies/',0); INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) VALUES('movie','r2','library','movies/Arrival (2016).mkv','Arrival (2016).mkv','','arrival (2016).mkv','arrival (2016).mkv',123,'2026-01-01','etag','rev1',0,0);");
  return {env:{DB,OPENSUBTITLES_API_KEY:'key',OPENSUBTITLES_TOKEN:'token'},owner:{id:'owner'},viewer:{id:'viewer'}};
}

test('account credentials enable authorized search and import without a manual token or credential leakage',async t=>{
  const {env,owner,viewer}=fixture();delete env.OPENSUBTITLES_TOKEN;
  env.OPENSUBTITLES_USERNAME='fixture-user';env.OPENSUBTITLES_PASSWORD='fixture-password';
  const values=new Map(),storage={async get(key){return structuredClone(values.get(key));},async put(key,value){values.set(key,structuredClone(value));}};
  const auth=new SubtitleSession(env,storage);
  env.PROCESSOR={idFromName:()=> 'media',get:()=>({subtitleSession:token=>auth.get(token)})};
  const token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push([String(url),options]);
    if(String(url).endsWith('/login'))return Response.json({token,base_url:'api.opensubtitles.com',status:200,user:{allowed_downloads:10}});
    if(String(url).includes('/subtitles?'))return Response.json({data:[]});
    if(String(url).endsWith('/download'))return Response.json({link:'https://dl.opensubtitles.com/download/fixture'});
    assert.equal(options.headers,undefined);
    assert.equal(options.redirect,'manual');
    return new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  });
  await assert.rejects(()=>searchSubtitles(env,viewer,'movie',new URLSearchParams()),e=>e.status===404);
  assert.equal(calls.length,0);
  assert.deepEqual((await searchSubtitles(env,owner,'movie',new URLSearchParams())).items,[]);
  const track=await importSubtitle(env,owner,'movie',{fileId:42,revision:'rev1'});
  assert.match(await (await subtitleContent(env,owner,'movie',track.id)).text(),/Hello/);
  assert.equal(calls.filter(([url])=>url.endsWith('/login')).length,1);
  const result=JSON.stringify(track);
  for(const secret of [token,'fixture-password','fixture-user','fixture-key'])assert(!result.includes(secret));
});

test('search, import, and native subtitle playback are scoped to authorized video revision',async()=>{
  const {env,owner,viewer}=fixture(); const originalFetch=globalThis.fetch; const calls=[];
  globalThis.fetch=async (url,options)=>{
    calls.push([String(url),options]);
    if(String(url).includes('/subtitles?')) return Response.json({data:[{attributes:{language:'en',release:'Arrival.2016',hearing_impaired:false,download_count:33,files:[{file_id:1234}]}}]});
    if(String(url).endsWith('/download')) return Response.json({link:'https://dl.opensubtitles.com/download/once',file_name:'Arrival.srt'});
    return new Response('1\r\n00:00:01,000 --> 00:00:02,500\r\n<b>Hello</b> & <script>bad</script>\r\n');
  };
  try {
    assert.deepEqual(subtitleStatus(env),{available:true,configured:true});
    await assert.rejects(()=>searchSubtitles(env,viewer,'movie',new URLSearchParams()),e=>e.status===404);
    const results=await searchSubtitles(env,owner,'movie',new URLSearchParams({query:'Arrival',language:'en'}));
    assert.deepEqual(results.items,[{fileId:1234,language:'en',release:'Arrival.2016',label:'Arrival.2016',hearingImpaired:false,downloadCount:33,downloads:33}]);
    const track=await importSubtitle(env,owner,'movie',{fileId:1234,language:'en',release:'Arrival.2016',revision:'rev1'});
    assert.equal(track.language,'en'); assert.match(track.url,/\.vtt$/);
    const content=await subtitleContent(env,owner,'movie',track.id+'.vtt');
    assert.equal(content.headers.get('Content-Type'),'text/vtt; charset=utf-8');
    const vtt=await content.text();
    assert.match(vtt,/^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.500\n/);
    assert.match(vtt,/&lt;script&gt;bad&lt;\/script&gt;/);
    assert.deepEqual((await listSubtitles(env,owner,'movie')).items,[track]);
    assert.equal((await listSubtitles(env,owner,'movie')).defaultId,track.id);
    assert.equal((await importSubtitle(env,owner,'movie',{fileId:1234,language:'en',release:'Arrival.2016',revision:'rev1'})).id,track.id);
    assert.equal(calls.filter(([url])=>url.endsWith('/download')).length,1);
    env.DB.db.exec("UPDATE videos SET revision='rev2' WHERE id='movie'");
    assert.deepEqual((await listSubtitles(env,owner,'movie')).items,[]);
    await assert.rejects(()=>subtitleContent(env,owner,'movie',track.id),e=>e.status===404);
  } finally {globalThis.fetch=originalFetch;}
});

test('matched movies search subtitles by TMDB id unless the user enters a query',async()=>{
  const {env,owner}=fixture(),db=env.DB.db,originalFetch=globalThis.fetch; const urls=[];
  db.exec("INSERT INTO movies(id,title,search_title,updated_at) VALUES(42,'Arrival','arrival',0); INSERT INTO movie_matches(video_id,revision,movie_id,state,checked_at) VALUES('movie','rev1',42,'matched',0)");
  globalThis.fetch=async url=>{urls.push(String(url));return Response.json({data:[]});};
  try {
    await searchSubtitles(env,owner,'movie',new URLSearchParams());
    await searchSubtitles(env,owner,'movie',new URLSearchParams({q:'Custom title'}));
    assert.match(urls[0],/tmdb_id=42/); assert.match(urls[1],/query=Custom\+title/);
  } finally {globalThis.fetch=originalFetch;}
});

test('episode subtitles use the series identity and exact season and episode',async()=>{
  const {env,owner}=fixture(),db=env.DB.db,originalFetch=globalThis.fetch,urls=[];
  db.exec("INSERT INTO tv_shows(id,name,search_name,updated_at) VALUES(50,'Example Show','example show',0); INSERT INTO tv_episodes(id,show_id,season_number,episode_number,name,search_name,updated_at) VALUES(501,50,0,2,'A special','a special',0); INSERT INTO episode_matches(video_id,revision,episode_id,state,checked_at) VALUES('movie','rev1',501,'matched',0)");
  globalThis.fetch=async url=>{urls.push(new URL(url));return Response.json({data:[]});};
  try {
    await searchSubtitles(env,owner,'movie',new URLSearchParams({language:'en'}));
    await searchSubtitles(env,owner,'movie',new URLSearchParams({q:'Different release'}));
    assert.deepEqual(Object.fromEntries(urls[0].searchParams),{type:'episode',parent_tmdb_id:'50',season_number:'0',episode_number:'2',languages:'en'});
    assert.deepEqual(Object.fromEntries(urls[1].searchParams),{type:'episode',query:'Different release',season_number:'0',episode_number:'2'});
  } finally {globalThis.fetch=originalFetch;}
});

test('a manually matched movie in a TV library searches movie subtitles',async()=>{
  const {env,owner}=fixture(),originalFetch=globalThis.fetch;let requested;
  env.DB.db.exec("UPDATE libraries SET kind='tv'; INSERT INTO movies(id,title,search_title,updated_at) VALUES(42,'Arrival','arrival',0); INSERT INTO movie_matches(video_id,revision,movie_id,state,checked_at) VALUES('movie','rev1',42,'matched',0)");
  globalThis.fetch=async url=>{requested=new URL(url).searchParams;return Response.json({data:[]});};
  try {
    await searchSubtitles(env,owner,'movie',new URLSearchParams());
    assert.deepEqual(Object.fromEntries(requested),{type:'movie',tmdb_id:'42'});
  } finally {globalThis.fetch=originalFetch;}
});

test('provider download link is confined to official host and never followed through redirect',async()=>{
  const {env,owner}=fixture(); const originalFetch=globalThis.fetch; let count=0;
  try {
    for(const link of ['https://127.0.0.1/private','https://www.opensubtitles.com:443/download/file','https://dl.opensubtitles.com.evil.test/download/file','https://a@www.opensubtitles.com/download/file']) {
      globalThis.fetch=async()=>{count++;return Response.json({link,file_name:'bad.srt'});};
      await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:1234,revision:'rev1'}),e=>e.code==='subtitle_provider_error');
    }
    assert.equal(count,4);
  } finally {globalThis.fetch=originalFetch;}
});

test('official www.opensubtitles.com download links are accepted',async()=>{
  const {env,owner}=fixture(),originalFetch=globalThis.fetch;
  const urls=[];
  globalThis.fetch=async url=>{urls.push(String(url));return String(url).endsWith('/download')?Response.json({link:'https://www.opensubtitles.com/download/opaque/subfile/Arrival.srt'}):new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n');};
  try {
    const track=await importSubtitle(env,owner,'movie',{fileId:42,revision:'rev1'});
    assert(track.id); assert.equal(urls[1],'https://www.opensubtitles.com/download/opaque/subfile/Arrival.srt');
  } finally {globalThis.fetch=originalFetch;}
});

test('subtitle file redirects are rejected without fetching the redirect target',async t=>{
  const {env,owner}=fixture();let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.equal(options.redirect,'manual');
    if(String(url).endsWith('/download'))return Response.json({link:'https://dl.opensubtitles.com/download/fixture'});
    assert.equal(new URL(url).hostname,'dl.opensubtitles.com');
    return new Response('',{status:302,headers:{Location:'https://untrusted.test/file'}});
  });
  await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:42,revision:'rev1'}),e=>e.code==='subtitle_provider_error');
  assert.equal(calls,2);
  assert.equal(env.DB.db.prepare('SELECT count(*) n FROM video_subtitles').get().n,0);
});

test('grant revoked during provider fetch prevents subtitle import',async()=>{
  const {env,viewer}=fixture(),originalFetch=globalThis.fetch;
  env.DB.db.exec("INSERT INTO grants(user_id,library_id) VALUES('viewer','library')");
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  let fetching;
  const entered=new Promise(resolve=>{fetching=resolve;});
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/download'))return Response.json({link:'https://dl.opensubtitles.com/download/once'});
    fetching(); await pending; return new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  };
  try {
    const importing=importSubtitle(env,viewer,'movie',{fileId:42,revision:'rev1'});
    await entered;
    env.DB.db.exec("DELETE FROM grants WHERE user_id='viewer'");
    release();
    await assert.rejects(importing,e=>e.status===409 || e.status===404);
    assert.equal(env.DB.db.prepare('SELECT count(*) n FROM video_subtitles').get().n,0);
  } finally {globalThis.fetch=originalFetch;release();}
});

test('concurrent imports reserve one provider download',async()=>{
  const {env,owner}=fixture(),originalFetch=globalThis.fetch;
  let release,entered,downloads=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const downloading=new Promise(resolve=>{entered=resolve;});
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/download')) {downloads++;entered();await pending;return Response.json({link:'https://dl.opensubtitles.com/download/once'});}
    return new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  };
  try {
    const first=importSubtitle(env,owner,'movie',{fileId:42,revision:'rev1'});
    await downloading;
    assert.deepEqual((await listSubtitles(env,owner,'movie')).items,[]);
    const pendingId=env.DB.db.prepare('SELECT id FROM video_subtitles').get().id;
    await assert.rejects(()=>subtitleContent(env,owner,'movie',pendingId),e=>e.status===404);
    await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:42,revision:'rev1'}),e=>e.code==='subtitle_import_pending');
    release();
    assert((await first).id);
    assert.equal(downloads,1);
  } finally {globalThis.fetch=originalFetch;release();}
});

test('subtitle content enforces size and valid SRT cues',async()=>{
  const {env,owner}=fixture(); const originalFetch=globalThis.fetch;
  let content='not an SRT cue';
  globalThis.fetch=async url=>String(url).endsWith('/download')?Response.json({link:'https://dl.opensubtitles.com/download/once'}):new Response(content);
  try {
    await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:99,revision:'rev1'}),e=>e.code==='invalid_subtitle');
    content='1\n00:00:01,000 --> 00:00:02,000\n'+ 'x'.repeat(300_000);
    await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:99,revision:'rev1'}),e=>e.code==='invalid_subtitle');
    for(const timing of ['00:60:01,000 --> 00:61:02,000','00:00:02,000 --> 00:00:01,000','00:00:01,000 --> 00:00:01,000']) {
      content=`1\n${timing}\nHello\n`;
      await assert.rejects(()=>importSubtitle(env,owner,'movie',{fileId:99,revision:'rev1'}),e=>e.code==='invalid_subtitle');
    }
  } finally {globalThis.fetch=originalFetch;}
});

test('malformed provider envelopes return a stable error',async()=>{
  const {env,owner}=fixture(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json(null);
  try {await assert.rejects(()=>searchSubtitles(env,owner,'movie',new URLSearchParams({q:'Example'})),e=>e.code==='subtitle_provider_error');}
  finally {globalThis.fetch=original;}
});
