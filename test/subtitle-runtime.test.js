import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('provider requests work in Workerd with durable subtitle sessions and bounded errors', async () => {
  const config=JSON.parse(await readFile(new URL('../wrangler.local.jsonc',import.meta.url),'utf8'));
  const binding=config.durable_objects?.bindings.find(item=>item.name==='PROCESSOR');
  assert.equal(binding?.class_name,'LocalMediaController');
  assert.ok(config.migrations.some(item=>item.new_sqlite_classes?.includes(binding.class_name)));
  const result=await build({stdin:{contents:`
    export {LocalMediaController} from '#src/local.js';
    import {subtitleProvider} from '#src/subtitle-auth.js';
    import {tmdb,fetchArtwork} from '#src/tmdb.js';
    export default {async fetch(request,env) {
      if(new URL(request.url).pathname==='/metadata')return Response.json(await tmdb(env,'/movie/42'));
      if(new URL(request.url).pathname==='/artwork')return fetchArtwork('/fixture.png','poster');
      if(new URL(request.url).pathname==='/failure') {
        const controller=env.PROCESSOR.get(env.PROCESSOR.idFromName('failed-login'));
        return Response.json(await controller.subtitleSession(''));
      }
      return Response.json(await subtitleProvider(env,'/subtitles?query=fixture'));
    }};
  `,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],write:false});
  const bindings={OPENSUBTITLES_API_KEY:'fixture-key'};
  bindings.OPENSUBTITLES_USERNAME='fixture-user';
  bindings.OPENSUBTITLES_PASSWORD='fixture-password';
  bindings.TMDB_READ_TOKEN='fixture-metadata';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'HS256'})}.${encode({exp:Math.floor(Date.now()/1000)+3600})}.fixture`;
  let logins=0,searches=0,rejectLogin=false;
  const options={modules:true,script:result.outputFiles[0].text,compatibilityDate:config.compatibility_date,
    compatibilityFlags:config.compatibility_flags,bindings,
    durableObjects:{PROCESSOR:{className:binding.class_name,useSQLite:true}},
    outboundService:async request=>{
      if(request.url==='https://api.themoviedb.org/3/movie/42') {
        assert.equal(request.headers.get('Authorization'),`Bearer ${bindings.TMDB_READ_TOKEN}`);
        return Response.json({id:42,title:'Fixture Movie'});
      }
      if(request.url==='https://image.tmdb.org/t/p/w500/fixture.png') {
        assert.equal(request.headers.get('Authorization'),null);
        return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
      }
      assert.equal(request.headers.get('Api-Key'),bindings.OPENSUBTITLES_API_KEY);
      if(request.url==='https://api.opensubtitles.com/api/v1/login') {
        logins++;
        assert.equal(request.method,'POST');
        assert.deepEqual(await request.json(),{username:bindings.OPENSUBTITLES_USERNAME,password:bindings.OPENSUBTITLES_PASSWORD});
        if(rejectLogin)return Response.json({message:'private upstream failure'}, {status:403});
        return Response.json({token,base_url:'vip-api.opensubtitles.com',user:{vip:true},status:200});
      }
      assert.equal(request.url,'https://vip-api.opensubtitles.com/api/v1/subtitles?query=fixture');
      assert.equal(request.headers.get('Authorization'),`Bearer ${token}`);
      searches++;
      return Response.json({data:[]});
    }};
  const mf=new Miniflare(convertV4MiniflareOptions(options));
  try {
    const results=await Promise.all(Array.from({length:6},async ()=>{
      const response=await mf.dispatchFetch('http://localhost/search');
      assert.equal(response.status,200,`${await response.clone().text()} (logins=${logins}, searches=${searches})`);
      return response.json();
    }));
    assert.deepEqual(results,Array.from({length:6},()=>({data:[]})));
    assert.equal(logins,1);
    assert.equal(searches,6);
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/metadata')).json(),{id:42,title:'Fixture Movie'});
    const artwork=await mf.dispatchFetch('http://localhost/artwork');
    assert.equal(artwork.headers.get('Content-Type'),'image/png');
    assert.deepEqual(new Uint8Array(await artwork.arrayBuffer()),new Uint8Array([137,80,78,71]));
    await mf.setOptions(convertV4MiniflareOptions({...options,bindings:{...bindings,RESTART:'yes'}}));
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/search')).json(),{data:[]});
    assert.equal(logins,1,'the restarted object must reuse its stored login');
    rejectLogin=true;
    for(let i=0;i<2;i++) {
      assert.deepEqual(await (await mf.dispatchFetch('http://localhost/failure')).json(),{error:'subtitle_login_failed',status:502});
    }
    assert.equal(logins,2,'a rejected password must be cached instead of retrying the provider');
  } finally {await mf.dispose();}
});
