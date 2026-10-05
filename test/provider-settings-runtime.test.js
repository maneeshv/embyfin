import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('Settings credentials persist through Workerd restarts and drive provider requests without deployment secrets',async()=>{
  const config=JSON.parse(await readFile(new URL('../wrangler.local.jsonc',import.meta.url),'utf8'));
  const bundle=await build({entryPoints:['src/local.js'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],write:false});
  const bindings={...config.vars};
  bindings.PROVIDER_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const credentials={apiKey:'runtime-provider-key',username:'runtime-provider-user',password:'runtime-provider-password'};
  const metadataToken='runtime-metadata-token';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'HS256'})}.${encode({exp:Math.floor(Date.now()/1000)+3600})}.runtime-signature`;
  let logins=0,searches=0;
  const options={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:config.compatibility_date,
    compatibilityFlags:config.compatibility_flags,bindings,d1Databases:['DB'],r2Buckets:['BACKUPS','POSTERS'],
    durableObjects:{PROCESSOR:{className:'LocalMediaController',useSQLite:true}},
    outboundService:async request=>{
      const url=new URL(request.url);
      if(url.origin==='https://api.themoviedb.org') {
        assert.equal(request.headers.get('Authorization'),`Bearer ${metadataToken}`);
        if(url.pathname==='/3/authentication')return Response.json({success:true,status_code:1,status_message:'Success.'});
        assert.equal(url.pathname,'/3/search/movie');
        return Response.json({page:1,results:[{id:42,title:'Fixture Movie',release_date:'2020-01-01'}],total_results:1,total_pages:1});
      }
      assert.equal(request.headers.get('Api-Key'),credentials.apiKey);
      if(url.pathname==='/api/v1/login') {
        assert.equal(url.origin,'https://api.opensubtitles.com');
        assert.deepEqual(await request.json(),{username:credentials.username,password:credentials.password});
        logins++;
        return Response.json({token,base_url:'vip-api.opensubtitles.com',user:{vip:true},status:200});
      }
      assert.equal(url.origin,'https://vip-api.opensubtitles.com');
      assert.equal(request.headers.get('Authorization'),`Bearer ${token}`);
      if(url.pathname==='/api/v1/infos/user')return Response.json({data:{user_id:42,allowed_downloads:100,remaining_downloads:100,vip:true,level:'VIP'}});
      assert.equal(url.pathname,'/api/v1/subtitles');searches++;
      return Response.json({data:[],total_pages:0,total_count:0,page:1});
    }};
  const mf=new Miniflare(convertV4MiniflareOptions(options));
  try {
    const db=await mf.getD1Database('DB');
    for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()) {
      // D1 exec splits on newlines; SQLite's parser keeps multiline triggers together.
      const statements=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
statements=[]
pending=''
for line in sys.stdin:
 pending+=line
 if sqlite3.complete_statement(pending):
  statements.append(pending);pending=''
if pending.strip(): statements.append(pending)
print(json.dumps(statements))`],{input:await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'),encoding:'utf8'}));
      for(const statement of statements)await db.prepare(statement).run();
    }
    const origin=bindings.APP_ORIGIN;
    const session=await (await mf.dispatchFetch(origin+'/api/session')).json();
    assert.equal(session.user.role,'owner');
    const send=async payload=>mf.dispatchFetch(origin+'/api/admin/providers',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Embyfin-User':session.user.id},body:JSON.stringify(payload)});
    const admin=await (await mf.dispatchFetch(origin+'/api/admin')).json();
    assert.equal(admin.providers?.editable,true);
    for(const [provider,values] of [['tmdb',{token:metadataToken}],['opensubtitles',credentials]]) {
      const saved=await send({provider,action:'save',credentials:values});
      const body=await saved.text();assert.equal(saved.status,200,body);
      assert.equal(JSON.parse(body).providers[provider].configured,true);
      for(const secret of [metadataToken,...Object.values(credentials),token])assert.ok(!body.includes(secret),'HTTP response must not disclose credentials');
    }
    assert.equal(logins,1);
    await db.prepare("INSERT INTO libraries(id,source_id,name,prefix,created_at,kind) VALUES('fixture','r2','Fixtures','fixtures/',0,'videos')").run();
    await db.prepare("INSERT INTO videos(id,source_id,library_id,object_key,filename,search_name,search_path,parent,bytes,modified,etag,revision,first_seen,last_seen) VALUES('fixture-video','r2','fixture','fixtures/Fixture.mp4','Fixture.mp4','fixture.mp4','fixture.mp4','',10,'2020-01-01','fixture-etag','fixture-revision',0,0)").run();
    const search=await mf.dispatchFetch(origin+'/api/videos/fixture-video/movie/search?q=Fixture');
    const found=await search.json();assert.equal(search.status,200,JSON.stringify(found));assert.equal(found.items[0].id,42);
    const subtitles=await mf.dispatchFetch(origin+'/api/videos/fixture-video/subtitles/search?q=Fixture&language=en');
    assert.equal(subtitles.status,200,await subtitles.clone().text());assert.equal(searches,1);
    await mf.setOptions(convertV4MiniflareOptions({...options,bindings:{...bindings,RESTART:'yes'}}));
    const restarted=await (await mf.dispatchFetch(origin+'/api/admin')).json();
    assert.equal(restarted.providers.opensubtitles.source,'settings');assert.equal(restarted.providers.tmdb.source,'settings');
    const again=await mf.dispatchFetch(origin+'/api/videos/fixture-video/subtitles/search?q=Fixture&language=en');
    assert.equal(again.status,200,await again.clone().text());assert.equal(logins,1);assert.equal(searches,2);
    const disconnected=await send({provider:'opensubtitles',action:'disconnect'});
    assert.equal(disconnected.status,200,await disconnected.clone().text());
    const disabled=await mf.dispatchFetch(origin+'/api/videos/fixture-video/subtitles/search?q=Fixture&language=en');
    assert.equal(disabled.status,503);assert.equal(searches,2);
    const badBindings={...bindings,RESTART:'wrong-key'};
    badBindings.PROVIDER_ENCRYPTION_KEY=randomBytes(32).toString('base64');
    await mf.setOptions(convertV4MiniflareOptions({...options,bindings:badBindings}));
    const unreadable=await (await mf.dispatchFetch(origin+'/api/admin')).json();
    assert.equal(unreadable.providers.tmdb.status,'error');
    assert.equal((await mf.dispatchFetch(origin+'/api/videos/fixture-video')).status,200,'ordinary video details survive a key mismatch');
    assert.equal((await send({provider:'tmdb',action:'disconnect'})).status,200,'owner can reset an unreadable provider');
  } finally {await mf.dispose();}
});
