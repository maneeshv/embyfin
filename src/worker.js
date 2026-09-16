import {all,one,run,sql,fail,Problem,body,json,string,boolean,prefix,id,now,byteRange,mime,protect} from './core.js';
import {identity,resolveUser,csrf,owner} from './auth.js';
import {R2Source} from './storage.js';
import {catalog,libraries,folders,video,publicVideo,ensureCurrent,personal} from './catalog.js';
import {scanIntent} from './scans.js';
import {machine,retryFailed} from './jobs.js';
import {backupState,gate,requestBackup} from './backup.js';

const verified=new WeakSet();
async function bootstrap(env) {
  // Source configuration only changes with a redeploy, which replaces this isolate: verify once per isolate.
  if(verified.has(env.DB))return;
  let source=await one(env.DB,"SELECT bucket,scope FROM sources WHERE id='r2'");
  if(!source) {
    await run(env.DB,"INSERT OR IGNORE INTO sources(id,provider,bucket,scope) VALUES('r2','r2',?,?)",env.SOURCE_BUCKET,env.SOURCE_SCOPE || '');
    source=await one(env.DB,"SELECT bucket,scope FROM sources WHERE id='r2'");
  }
  if(source.bucket!==env.SOURCE_BUCKET || source.scope!==(env.SOURCE_SCOPE || '')) fail(503,'source_configuration_changed','Source changes require a migration.');
  verified.add(env.DB);
}
async function stream(request,env,source,user,videoId) {
  const v=await video(env,user,videoId), object=await ensureCurrent(env,source,v);
  const headers=new Headers({'Content-Type':mime(v.filename),'Accept-Ranges':'bytes','ETag':object.etag,'Last-Modified':new Date(object.modified).toUTCString()});
  const matches = (value,weak=false) => value?.split(',').map(s=>weak?s.trim().replace(/^W\//,''):s.trim()).some(s=>s==='*'||s===object.etag);
  if(request.headers.has('If-Match') && !matches(request.headers.get('If-Match'))) return new Response(null,{status:412,headers});
  if(!request.headers.has('If-Match') && Date.parse(request.headers.get('If-Unmodified-Since'))<Date.parse(object.modified)) return new Response(null,{status:412,headers});
  if(matches(request.headers.get('If-None-Match'),true) || (!request.headers.has('If-None-Match') && Date.parse(request.headers.get('If-Modified-Since'))>=Date.parse(object.modified))) return new Response(null,{status:304,headers});
  const ifRange=request.headers.get('If-Range');
  const allowRange=!ifRange || ifRange===object.etag || (!ifRange.startsWith('W/') && Date.parse(ifRange)>=Date.parse(object.modified));
  let range;
  try {range=byteRange(allowRange?request.headers.get('Range'):null,v.bytes);}
  catch(error) {headers.set('Content-Range',`bytes */${v.bytes}`);return new Response(null,{status:416,headers});}
  headers.set('Content-Length',String(range?range.end-range.start+1:v.bytes));
  if(range) headers.set('Content-Range',`bytes ${range.start}-${range.end}/${v.bytes}`);
  if(request.method==='HEAD') return new Response(null,{status:range?206:200,headers});
  const upstream=await source.open(v.object_key,range,object.etag,request.signal);
  if(upstream.status===412) {await upstream.body?.cancel();await run(env.DB,'UPDATE videos SET refresh_requested=1 WHERE id=?',v.id);fail(409,'source_changed');}
  if(upstream.status===404) {await upstream.body?.cancel();fail(410,'unavailable');}
  if(upstream.status!==(range?206:200) || Number(upstream.headers.get('Content-Length'))!==Number(headers.get('Content-Length')) || (range && upstream.headers.get('Content-Range')!==headers.get('Content-Range'))) {
    await upstream.body?.cancel();fail(502,'invalid_storage_response');
  }
  return new Response(upstream.body,{status:upstream.status,headers});
}
async function admin(request,env,user,path) {
  owner(user);
  if(path==='/api/admin' && request.method==='GET') {
    const [libs,users,grants,scans,failures,processor]=await Promise.all([
      all(env.DB,`SELECT l.*,(SELECT count(*) FROM videos v WHERE v.library_id=l.id) AS discovered,
        (SELECT count(*) FROM videos v WHERE v.library_id=l.id AND v.enrichment='ready' AND v.available=1) AS enriched,
        (SELECT count(*) FROM videos v WHERE v.library_id=l.id AND v.enrichment='pending' AND v.available=1) AS pending,
        (SELECT count(*) FROM videos v WHERE v.library_id=l.id AND v.enrichment='failed' AND v.available=1) AS failed,
        (SELECT count(*) FROM videos v WHERE v.library_id=l.id AND v.available=0) AS missing FROM libraries l ORDER BY l.name`),
      all(env.DB,'SELECT id,email,role,enabled,subject IS NOT NULL AS linked FROM users ORDER BY role,email'),
      all(env.DB,'SELECT * FROM grants'),
      all(env.DB,'SELECT id,library_id,status,discovered,ignored,started_at,updated_at,completed_at,error FROM scans ORDER BY started_at DESC LIMIT 50'),
      all(env.DB,`SELECT v.id,v.filename,l.name AS library_name,v.processing_error,j.attempts,j.read_bytes,j.elapsed_ms
        FROM videos v JOIN libraries l ON l.id=v.library_id LEFT JOIN jobs j ON j.video_id=v.id AND j.revision=v.revision
        WHERE v.enrichment='failed' ORDER BY v.id LIMIT 100`),
      one(env.DB,'SELECT status,started_at,deadline,heartbeat,read_bytes,read_limit,job_seconds,error,next_dispatch FROM processor_runs WHERE slot=1'),
    ]);
    return json({libraries:libs,users,grants,scans,failures,processor,backup:await backupState(env),
      source:{bucket:env.SOURCE_BUCKET,scope:env.SOURCE_SCOPE || '',configured:!!env.SOURCE_ACCESS_KEY_ID},
      processingEnabled:env.PROCESSING_ENABLED==='true',backupConfigured:!!env.CF_API_TOKEN});
  }
  if(request.method!=='POST') fail(405,'method_not_allowed');
  const data=await body(request);
  if(path==='/api/admin/libraries') {
    const scope=prefix(data.prefix,env.SOURCE_SCOPE || ''), name=string(data.name,100);
    if(data.id) {
      const l=await one(env.DB,'SELECT * FROM libraries WHERE id=?',string(data.id,100));if(!l)fail(404,'not_found');
      if(l.frozen && l.prefix!==scope) fail(409,'scope_frozen');
      await run(env.DB,'UPDATE libraries SET name=?,prefix=?,enabled=? WHERE id=?',name,scope,boolean(data.enabled ?? true),l.id);
    } else await run(env.DB,"INSERT INTO libraries(id,source_id,name,prefix,created_at,next_scan) VALUES(?,'r2',?,?,?,?)",id(),name,scope,now(),2147483647);
    return json({ok:true});
  }
  if(path==='/api/admin/users') {
    const email=string(data.email,254).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+$/.test(email))fail(400,'invalid_email');
    const existing=await one(env.DB,'SELECT * FROM users WHERE email=? COLLATE NOCASE',email);
    if(existing?.role==='owner')fail(400,'owner_immutable');
    await run(env.DB,`INSERT INTO users(id,email,created_at,enabled) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET enabled=excluded.enabled`,id(),email,now(),boolean(data.enabled ?? true));
    return json({ok:true,admission:'Configure Cloudflare Access admission separately.'});
  }
  if(path==='/api/admin/grants') {
    const uid=string(data.userId,100),lid=string(data.libraryId,100);
    if(data.granted===true)await run(env.DB,'INSERT OR IGNORE INTO grants(user_id,library_id) VALUES(?,?)',uid,lid);
    else if(data.granted===false)await run(env.DB,'DELETE FROM grants WHERE user_id=? AND library_id=?',uid,lid);
    else fail(400,'invalid_grant');
    return json({ok:true});
  }
  if(path==='/api/admin/scan') {await scanIntent(env,string(data.libraryId,100),data.action);return json({ok:true});}
  if(path==='/api/admin/retry') {await retryFailed(env,string(data.libraryId,100));return json({ok:true});}
  if(path==='/api/admin/backup') {await requestBackup(env);return json({ok:true});}
  if(path==='/api/admin/validate') {
    const source=new R2Source(env),page=await source.list(env.SOURCE_SCOPE || '',null,1);
    if(page.objects.length)await source.head(page.objects[0].key);
    const key=`connection-check/${id()}`;await env.POSTERS.put(key,'embyfin');
    if(!await env.POSTERS.head(key))fail(502,'poster_store_failed');await env.POSTERS.delete(key);
    return json({ok:true,list:true,read:page.objects.length?'verified':'empty scope',posters:true});
  }
  fail(404,'not_found');
}
export async function handle(request,env,ctx,authenticate=identity) {
  try {
    const path=new URL(request.url).pathname;
    const [halted,backup]=await gate(env);
    if(halted)fail(503,'maintenance','Library maintenance is in progress. Try again later.');
    if(backup && !['complete','failed'].includes(backup.status))fail(503,'backup_maintenance','A database backup is in progress. Try again later.');
    const controller=env.PROCESSOR?.get(env.PROCESSOR.idFromName('media'));
    if(path.startsWith('/machine/'))return protect(await machine(request,env,new R2Source(env),controller));
    const [claim]=await Promise.all([authenticate(request,env),bootstrap(env)]);
    const user=await resolveUser(env,claim);
    if(!['GET','HEAD'].includes(request.method))csrf(request,env,user);
    let result;
    if(path==='/api/session' && request.method==='GET') result=json({user,local:authenticate!==identity,logout:'/cdn-cgi/access/logout'});
    else if(path.startsWith('/api/admin'))result=await admin(request,env,user,path);
    else if(path==='/api/libraries' && request.method==='GET')result=json({items:await libraries(env,user)});
    else if(path==='/api/videos' && request.method==='GET')result=json(await catalog(env,user,new URL(request.url).searchParams));
    else if(path==='/api/folders' && request.method==='GET')result=json(await folders(env,user,new URL(request.url).searchParams));
    else if(path.startsWith('/api/videos/')) {
      const match=/^\/api\/videos\/([^/]+)(?:\/(media|poster|availability|session|progress|favorite|watched))?$/.exec(path);
      if(!match)fail(404,'not_found');
      const [,videoId,action]=match;
      if(action==='media' && ['GET','HEAD'].includes(request.method))result=await stream(request,env,new R2Source(env),user,videoId);
      else {
        const v=await video(env,user,videoId);
        if(!action && request.method==='GET')result=json(publicVideo(v));
        else if(action==='poster' && ['GET','HEAD'].includes(request.method)) {
          if(!v.poster_key)fail(404,'poster_pending');
          const poster=await env.POSTERS.get(v.poster_key);if(!poster)fail(404,'poster_pending');
          // Revision-keyed URL; private so no shared cache holds it, immutable so the browser skips revalidation until the URL changes.
          result=new Response(request.method==='HEAD'?null:poster.body,{headers:{'Content-Type':'image/jpeg','Content-Length':String(poster.size),'Cache-Control':'private, max-age=86400, immutable'}});
        } else if(action==='availability' && request.method==='GET') {await ensureCurrent(env,new R2Source(env),v);result=json({available:true,revision:v.revision});}
        else if(['session','progress','favorite','watched'].includes(action) && request.method==='POST') {
          if(action==='session')await ensureCurrent(env,new R2Source(env),v);
          result=json(await personal(env,user,v,action,await body(request)));
        } else fail(405,'method_not_allowed');
      }
    } else if(path.startsWith('/api/'))fail(404,'not_found');
    else if(['GET','HEAD'].includes(request.method)) {
      if(!['/','/index.html','/app.js','/style.css','/favicon.svg','/recovery.html'].includes(path))fail(404,'not_found');
      const asset=await env.ASSETS.fetch(request);
      result=new Response(asset.body,asset);result.headers.set('Cache-Control','private, no-cache');
    } else fail(405,'method_not_allowed');
    const authenticated=new Response(result.body,result);
    authenticated.headers.set('X-Embyfin-User',user.id);
    return protect(authenticated);
  } catch(error) {
    let status=error instanceof Problem?error.status:500,code=error instanceof Problem?error.code:'internal_error';
    if(/overlapping library prefix/.test(error.message)){status=409;code='overlapping_prefix';}
    if(/FOREIGN KEY constraint/.test(error.message)){status=400;code='invalid_reference';}
    // Logs and errors exclude filenames, SQL parameters, source credentials, and presigned queries.
    if(status>=500)console.error(JSON.stringify({event:'embyfin_request_failed',code}));
    return protect(json({error:code,message:error instanceof Problem?error.message:code},status));
  }
}
