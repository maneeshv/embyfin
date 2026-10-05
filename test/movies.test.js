import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {one, run, now} from '#src/core.js';
import {catalog} from '#src/catalog.js';
import {searchMovies, identifyMovie, movieDetails, personDetails, movieImage, enrichMovies} from '#src/movies.js';

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) this.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  }
  prepare(text) {
    const stmt = this.db.prepare(text); let args = [];
    const query = {text,values:()=>args,bind(...values){args=values;return query;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){const result=stmt.run(...args);return {meta:{changes:Number(result.changes)}};}};
    return query;
  }
  async batch(items) {
    this.db.exec('BEGIN');
    try {
      const results=items.map(item=>/^\s*(SELECT|WITH)\b/i.test(item.text)?{results:this.db.prepare(item.text).all(...item.values())}:{meta:{changes:Number(this.db.prepare(item.text).run(...item.values()).changes)}});
      this.db.exec('COMMIT'); return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
async function fixture() {
  const env={DB:new D1(),TMDB_READ_TOKEN:'test'};
  await run(env.DB,"INSERT INTO sources VALUES('r2','r2','fixture','')");
  for (const [id,role] of [['owner','owner'],['alice','viewer'],['bob','viewer']]) await run(env.DB,'INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)',id,`${id}@test`,role,now());
  for (const [id,kind] of [['movies','movies'],['other','videos']]) await run(env.DB,"INSERT INTO libraries(id,source_id,name,prefix,kind,created_at) VALUES(?,'r2',?,?,?,?)",id,id,id+'/',kind,now());
  await run(env.DB,"INSERT INTO grants VALUES('alice','movies')");
  await run(env.DB,"INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) VALUES('v','r2','movies','movies/Arrival (2016).mkv','Arrival (2016).mkv','','arrival (2016).mkv','arrival (2016).mkv',100,'2026-01-01','e','revision-1',0,0)");
  return {env,owner:{id:'owner',role:'owner'},alice:{id:'alice',role:'viewer'},bob:{id:'bob',role:'viewer'}};
}
function tmdbFetch() {
  return async input=>{
    const url=new URL(input);
    if (url.pathname==='/3/search/movie') return Response.json({results:[{id:329865,title:'Arrival',release_date:'2016-11-10',poster_path:'/poster.jpg',overview:'A linguist meets visitors.',adult:false}]});
    if (url.pathname==='/3/movie/329865') return Response.json({id:329865,title:'Arrival',release_date:'2016-11-10',poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg',overview:'A linguist meets visitors.',runtime:116,genres:[{name:'Science Fiction'}],credits:{cast:[{id:123,name:'Amy Adams',character:'Louise Banks',profile_path:'/amy.jpg',order:0}]}});
    return new Response(null,{status:404});
  };
}
test('automatic movie matching stores details and grants only authorized cast links',async()=>{
  const {env,alice,bob}=await fixture(),original=globalThis.fetch; globalThis.fetch=tmdbFetch();
  try {
    assert.equal(await enrichMovies(env),1);
    const details=await movieDetails(env,alice,'v');
    assert.equal(details.movie.title,'Arrival');
    assert.equal(details.cast[0].character,'Louise Banks');
    assert.equal((await catalog(env,alice,new URLSearchParams({type:'movies',person:'123'}))).total,1);
    assert.equal((await personDetails(env,alice,123,new URLSearchParams())).items.length,1);
    await assert.rejects(()=>personDetails(env,bob,123,new URLSearchParams()),error=>error.status===404);
    await assert.rejects(()=>movieDetails(env,bob,'v'),error=>error.status===404);
    await run(env.DB,"UPDATE videos SET revision='revision-2' WHERE id='v'");
    assert.equal((await movieDetails(env,alice,'v')).movie,null);
  } finally { globalThis.fetch=original; }
});
test('manual match is owner only and ambiguous automatic results remain unmatched',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>String(input).includes('/search/movie')?Response.json({results:[
    {id:1,title:'Arrival',release_date:'2016-01-01'},{id:2,title:'Arrival',release_date:'2016-11-10'},
  ]}):tmdbFetch()(input);
  try {
    await enrichMovies(env);
    assert.equal((await movieDetails(env,alice,'v')).match.state,'ambiguous');
    await assert.rejects(()=>identifyMovie(env,alice,'v',{tmdbId:329865,revision:'revision-1'}),error=>error.status===403);
    await assert.rejects(()=>identifyMovie(env,owner,'v',{tmdbId:329865,revision:'stale'}),error=>error.status===409);
    assert.equal((await identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'})).movie.title,'Arrival');
    assert.equal((await searchMovies(env,'Arrival',2016))[0].title,'Arrival');
    await identifyMovie(env,owner,'v',{tmdbId:null,revision:'revision-1'});
    assert.equal((await movieDetails(env,alice,'v')).match.state,'dismissed');
  } finally { globalThis.fetch=original; }
});
test('an in-flight automatic lookup cannot replace an owner dismissal',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  let resolveSearch,signalSearch;
  const started=new Promise(resolve=>{signalSearch=resolve;});
  globalThis.fetch=async input=>{
    if (String(input).includes('/search/movie')) { signalSearch(); return new Promise(resolve=>{resolveSearch=resolve;}); }
    return tmdbFetch()(input);
  };
  try {
    const enrichment=enrichMovies(env);
    await started;
    await identifyMovie(env,owner,'v',{tmdbId:null,revision:'revision-1'});
    resolveSearch(Response.json({results:[{id:329865,title:'Arrival',release_date:'2016-11-10'}]}));
    await enrichment;
    assert.equal((await movieDetails(env,alice,'v')).match.state,'dismissed');
  } finally { globalThis.fetch=original; }
});
test('manual matching works in a mixed video library and appears in Movies',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch; globalThis.fetch=tmdbFetch();
  try {
    await run(env.DB,"UPDATE libraries SET kind='videos' WHERE id='movies'");
    assert.equal(await enrichMovies(env),0);
    await identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'});
    assert.equal((await movieDetails(env,alice,'v')).movie.title,'Arrival');
    assert.equal((await catalog(env,alice,new URLSearchParams({type:'movies'}))).total,1);
    assert.equal((await catalog(env,alice,new URLSearchParams({type:'videos'}))).total,0);
    assert.equal((await personDetails(env,alice,123)).items.length,1);
  } finally { globalThis.fetch=original; }
});
test('year at filename end is parsed and later search pages prevent automatic certainty',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  await run(env.DB,"UPDATE videos SET filename='Arrival.2016.mkv' WHERE id='v'");
  let searchUrl;
  globalThis.fetch=async input=>{
    if (String(input).includes('/search/movie')) { searchUrl=new URL(input); return Response.json({total_pages:2,results:[{id:329865,title:'Arrival',release_date:'2016-11-10'}]}); }
    return tmdbFetch()(input);
  };
  try {
    await identifyMovie(env,owner,'v',{auto:true,revision:'revision-1'});
    assert.equal(searchUrl.searchParams.get('year'),'2016');
    assert.equal((await movieDetails(env,alice,'v')).match.state,'ambiguous');
  } finally { globalThis.fetch=original; }
});
test('movie artwork is permission checked, proxied from a fixed image host, and versioned',async()=>{
  const {env,owner,alice,bob}=await fixture(),original=globalThis.fetch;
  let imageUrl;
  globalThis.fetch=async (input,options)=>{
    if (String(input).startsWith('https://image.tmdb.org/')) {
      imageUrl=String(input); assert.equal(options.redirect,'manual');
      return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
    }
    return tmdbFetch()(input);
  };
  try {
    await identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'});
    const details=await movieDetails(env,alice,'v');
    assert.match(details.movie.poster,/\?r=revision-1-329865-/);
    await assert.rejects(()=>movieImage(env,bob,'v','poster'),error=>error.status===404);
    const image=await movieImage(env,alice,'v','poster');
    assert.equal(image.status,200);
    assert.equal(imageUrl,'https://image.tmdb.org/t/p/w500/poster.jpg');
    assert.equal(image.headers.get('Content-Type'),'image/jpeg');
  } finally { globalThis.fetch=original; }
});
test('provider result from an obsolete video revision cannot be attached',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>{
    if (String(input).includes('/movie/329865')) await run(env.DB,"UPDATE videos SET revision='revision-2' WHERE id='v'");
    return tmdbFetch()(input);
  };
  try {
    await assert.rejects(()=>identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'}),error=>error.status===409);
    assert.equal((await movieDetails(env,alice,'v')).movie,null);
  } finally { globalThis.fetch=original; }
});
test('automatic enrichment excludes videos outside their library scope',async()=>{
  const {env,owner}=await fixture(),original=globalThis.fetch; let requests=0;
  globalThis.fetch=async input=>{requests++;return tmdbFetch()(input);};
  try {
    await run(env.DB,"UPDATE videos SET object_key='outside/Arrival (2016).mkv' WHERE id='v'");
    assert.equal(await enrichMovies(env),0);
    assert.equal(requests,0);
    await assert.rejects(()=>identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'}),error=>error.status===404);
  } finally { globalThis.fetch=original; }
});
test('automatic enrichment excludes a video whose source no longer matches its library',async()=>{
  const {env}=await fixture(),original=globalThis.fetch; let requests=0;
  globalThis.fetch=async input=>{requests++;return tmdbFetch()(input);};
  try {
    await run(env.DB,"INSERT INTO sources VALUES('other-source','r2','other-bucket','')");
    await run(env.DB,"UPDATE videos SET source_id='other-source' WHERE id='v'");
    assert.equal(await enrichMovies(env),0);
    assert.equal(requests,0);
  } finally { globalThis.fetch=original; }
});
test('automatic result cannot attach after library kind changes during provider fetch',async()=>{
  const {env,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>{
    if (String(input).includes('/search/movie')) await run(env.DB,"UPDATE libraries SET kind='videos' WHERE id='movies'");
    return tmdbFetch()(input);
  };
  try {
    await enrichMovies(env);
    assert.equal((await movieDetails(env,alice,'v')).movie,null);
  } finally { globalThis.fetch=original; }
});
test('owner revocation during provider fetch prevents a manual match',async()=>{
  const {env,owner}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>{
    if (String(input).includes('/movie/329865')) await run(env.DB,"UPDATE users SET enabled=0 WHERE id='owner'");
    return tmdbFetch()(input);
  };
  try {
    await assert.rejects(()=>identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'}),error=>error.status===409);
    assert.equal((await one(env.DB,"SELECT count(*) n FROM movie_matches")).n,0);
  } finally { globalThis.fetch=original; }
});
test('malformed TMDB JSON is rejected with a stable metadata error',async()=>{
  const {env,owner}=await fixture(),original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json(null);
    await assert.rejects(()=>searchMovies(env,'Arrival'),error=>error.code==='metadata_invalid');
    globalThis.fetch=async()=>Response.json({id:329865,title:{}});
    await assert.rejects(()=>identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'}),error=>error.code==='metadata_invalid');
  } finally { globalThis.fetch=original; }
});

test('TMDB metadata and artwork reject redirects without following locations or retaining bodies',async t=>{
  const {env,owner,alice}=await fixture();
  t.mock.method(globalThis,'fetch',tmdbFetch());
  await identifyMovie(env,owner,'v',{tmdbId:329865,revision:'revision-1'});
  for(const status of [301,302,303,307,308]) {
    for(const artwork of [false,true]) {
      let calls=0,canceled=false;
      t.mock.method(globalThis,'fetch',async(input,options)=>{
        calls++;
        assert.equal(options.redirect,'manual');
        assert.equal(new URL(input).hostname,artwork?'image.tmdb.org':'api.themoviedb.org');
        assert.equal(options.headers?.Authorization,artwork?undefined:'Bearer test');
        return new Response(new ReadableStream({cancel(){canceled=true;}}),{status,headers:{Location:'https://untrusted.test/redirect'}});
      });
      await assert.rejects(()=>artwork?movieImage(env,alice,'v','poster'):searchMovies(env,'Arrival'),error=>error.code===(artwork?'image_unavailable':'metadata_unavailable'));
      assert.equal(calls,1);assert.equal(canceled,true);
    }
  }
});

test('underscore release names identify the title/year and episodic files never auto-match',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch,calls=[];
  globalThis.fetch=async input=>{calls.push(new URL(input));return tmdbFetch()(input);};
  try {
    await run(env.DB,"UPDATE videos SET filename='Arrival_2016_1080p.mkv' WHERE id='v'");
    await identifyMovie(env,owner,'v',{auto:true,revision:'revision-1'});
    assert.equal(calls[0].searchParams.get('query'),'Arrival');assert.equal(calls[0].searchParams.get('year'),'2016');
    assert.equal((await movieDetails(env,alice,'v')).movie.title,'Arrival');
    calls.length=0;
    await run(env.DB,"UPDATE videos SET filename='Arrival_S01E02_2016.mkv' WHERE id='v'");
    await identifyMovie(env,owner,'v',{auto:true,revision:'revision-1'});
    assert.equal(calls.length,0);assert.equal((await movieDetails(env,alice,'v')).movie,null);
  } finally {globalThis.fetch=original;}
});
