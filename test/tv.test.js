import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {one, run, now} from '#src/core.js';
import {parseEpisodeFilename, searchShows, identifyEpisode, episodeDetails, showCatalog, showDetails, episodeImage, enrichEpisodes} from '#src/tv.js';

class D1 {
  constructor() {
    this.db=new DatabaseSync(':memory:');
    for (const file of ['0001_initial.sql','0002_movies.sql','0003_subtitles.sql']) this.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  }
  migrate() { this.db.exec(readFileSync(new URL('../migrations/0004_tv.sql',import.meta.url),'utf8')); }
  prepare(text) {
    const stmt=this.db.prepare(text); let args=[];
    const query={text,values:()=>args,bind(...values){args=values;return query;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};}};
    return query;
  }
  async batch(items) {
    this.db.exec('BEGIN');
    try { const results=items.map(item=>/^\s*(SELECT|WITH)\b/i.test(item.text)?{results:this.db.prepare(item.text).all(...item.values())}:{meta:{changes:Number(this.db.prepare(item.text).run(...item.values()).changes)}}); this.db.exec('COMMIT'); return results; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
async function fixture() {
  const env={DB:new D1(),TMDB_READ_TOKEN:'test'};
  await run(env.DB,"INSERT INTO sources VALUES('r2','r2','fixture','')");
  for (const [id,role] of [['owner','owner'],['alice','viewer'],['bob','viewer']]) await run(env.DB,'INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)',id,`${id}@test`,role,now());
  await run(env.DB,"INSERT INTO libraries(id,source_id,name,prefix,kind,created_at) VALUES('tv','r2','TV','tv/','movies',?)",now());
  await run(env.DB,"INSERT INTO grants VALUES('alice','tv')");
  await run(env.DB,"INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) VALUES('v','r2','tv','tv/Star Trek/S01E02.mkv','Star Trek S01E02.mkv','Star Trek/','star trek s01e02.mkv','star trek/star trek s01e02.mkv',100,'2026-01-01','e','rev1',0,0)");
  env.DB.migrate();
  await run(env.DB,"UPDATE libraries SET kind='tv' WHERE id='tv'");
  return {env,owner:{id:'owner'},alice:{id:'alice'},bob:{id:'bob'}};
}

test('TV migration preserves libraries and grants, and replaces conflicting movie matches',async()=>{
  const {env}=await fixture();
  assert.equal((await one(env.DB,"SELECT kind FROM libraries WHERE id='tv'")).kind,'tv');
  assert.equal((await one(env.DB,"SELECT count(*) n FROM grants WHERE user_id='alice'")).n,1);
  await run(env.DB,"INSERT INTO tv_shows(id,name,search_name,updated_at) VALUES(1,'Star Trek','star trek',1)");
  await run(env.DB,"INSERT INTO tv_episodes(id,show_id,season_number,episode_number,name,search_name,updated_at) VALUES(101,1,1,2,'Charlie X','charlie x',1)");
  await run(env.DB,"INSERT INTO episode_matches VALUES('v','rev1',101,'matched',1)");
  await run(env.DB,"INSERT INTO movies(id,title,search_title,updated_at) VALUES(2,'Film','film',1)");
  await run(env.DB,"INSERT INTO movie_matches VALUES('v','rev1',2,'matched',1)");
  assert.equal((await one(env.DB,"SELECT count(*) n FROM episode_matches WHERE video_id='v'")).n,0);
  await run(env.DB,"INSERT INTO episode_matches VALUES('v','rev1',101,'matched',1)");
  assert.equal((await one(env.DB,"SELECT count(*) n FROM movie_matches WHERE video_id='v'")).n,0);
  await run(env.DB,"UPDATE videos SET revision='rev2' WHERE id='v'");
  assert.equal((await one(env.DB,"SELECT count(*) n FROM episode_matches WHERE video_id='v'")).n,0);
});

test('parser accepts explicit single episodes and rejects combined or ambiguous names',()=>{
  assert.deepEqual(parseEpisodeFilename('Star.Trek.S01E02.1080p.mkv'),{title:'Star Trek',year:undefined,season:1,episode:2});
  assert.deepEqual(parseEpisodeFilename('Star Trek 1x02.mkv'),{title:'Star Trek',year:undefined,season:1,episode:2});
  assert.deepEqual(parseEpisodeFilename('S00E01.mkv','Star Trek/Season 00/'),{title:'Star Trek',year:undefined,season:0,episode:1});
  assert.deepEqual(parseEpisodeFilename('S01E02.mkv','Star Trek/Season_01/'),{title:'Star Trek',year:undefined,season:1,episode:2});
  assert.deepEqual(parseEpisodeFilename('S00E01.mkv','Star Trek/Specials/'),{title:'Star Trek',year:undefined,season:0,episode:1});
  for (const filename of ['Star Trek S01E02-E03.mkv','Star Trek S01E02E03.mkv','Star Trek S01E02 & 03.mkv',
    'Star Trek S01E02,03.mkv','Star Trek S01E02 and 03.mkv','Star Trek 2025-01-02.mkv','Star Trek.mkv']) assert.equal(parseEpisodeFilename(filename),null);
});

function provider() {
  return async input=>{
    const url=new URL(input);
    if(url.pathname==='/3/search/tv') return Response.json({total_pages:1,results:[{id:10,name:'Star Trek',first_air_date:'1966-09-08',overview:'A voyage.',adult:false}]});
    if(url.pathname==='/3/tv/10') return Response.json({id:10,name:'Star Trek',first_air_date:'1966-09-08',overview:'A voyage.',genres:[{name:'Science Fiction'}],poster_path:'/show.jpg',backdrop_path:'/space.jpg'});
    if(url.pathname==='/3/tv/10/season/1/episode/2') return Response.json({id:102,season_number:1,episode_number:2,name:'Charlie X',overview:'An unusual passenger.',air_date:'1966-09-15',runtime:50,still_path:'/still.jpg',credits:{cast:[{id:77,name:'William Shatner',character:'James T. Kirk',profile_path:'/actor.jpg',order:0}],guest_stars:[{id:78,name:'Robert Walker',character:'Charlie',profile_path:'/guest.jpg',order:1}]}});
    if(url.pathname==='/3/tv/10/season/1/episode/3') return Response.json({id:103,season_number:1,episode_number:3,name:'Where No Man Has Gone Before',overview:'A voyage continues.',air_date:'1966-09-22',runtime:50,still_path:'/still2.jpg',credits:{cast:[],guest_stars:[]}});
    if(url.origin==='https://image.tmdb.org') return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
    return new Response(null,{status:404});
  };
}

test('automatic matching saves episode, show, cast and authorized season grouping',async()=>{
  const {env,alice,bob}=await fixture(),original=globalThis.fetch; globalThis.fetch=provider();
  try {
    assert.equal(await enrichEpisodes(env),1);
    const details=await episodeDetails(env,alice,'v');
    assert.equal(details.show.name,'Star Trek');
    assert.equal(details.episode.title,'Charlie X');
    assert.deepEqual(details.cast.map(p=>p.character),['James T. Kirk','Charlie']);
    const shows=await showCatalog(env,alice,new URLSearchParams());
    assert.equal(shows.total,1); assert.equal(shows.items[0].episodeCount,1);
    const listing=await showDetails(env,alice,10,new URLSearchParams({season:'1'}));
    assert.equal(listing.items.length,1); assert.equal(listing.seasons[0].number,1);
    await assert.rejects(()=>episodeDetails(env,bob,'v'),error=>error.status===404);
    await assert.rejects(()=>showDetails(env,bob,10,new URLSearchParams()),error=>error.status===404);
  } finally {globalThis.fetch=original;}
});

test('manual identification is owner only; changing a movie match to an episode is explicit',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch; globalThis.fetch=provider();
  try {
    await run(env.DB,"INSERT INTO movies(id,title,search_title,updated_at) VALUES(1,'Film','film',1)");
    await run(env.DB,"INSERT INTO movie_matches VALUES('v','rev1',1,'matched',1)");
    assert.equal(await enrichEpisodes(env),0);
    await assert.rejects(()=>identifyEpisode(env,alice,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'}),error=>error.status===403);
    await assert.rejects(()=>identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'old'}),error=>error.status===409);
    const result=await identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'});
    assert.equal(result.episode.title,'Charlie X');
    assert.equal((await one(env.DB,"SELECT count(*) n FROM movie_matches WHERE video_id='v'")).n,0);
    assert.equal((await searchShows(env,'Star Trek',1966))[0].id,10);
    await identifyEpisode(env,owner,'v',{tmdbId:null,revision:'rev1'});
    assert.equal((await episodeDetails(env,alice,'v')).match.state,'dismissed');
  } finally {globalThis.fetch=original;}
});

test('explicit owner auto retry can replace a dismissed movie match',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;globalThis.fetch=provider();
  try {
    await run(env.DB,"INSERT INTO movie_matches VALUES('v','rev1',NULL,'dismissed',1)");
    assert.equal(await enrichEpisodes(env),0);
    const result=await identifyEpisode(env,owner,'v',{auto:true,revision:'rev1'});
    assert.equal(result.episode.title,'Charlie X');
    assert.equal((await one(env.DB,"SELECT count(*) n FROM movie_matches WHERE video_id='v'")).n,0);
    assert.equal((await episodeDetails(env,alice,'v')).match.state,'matched');
  } finally {globalThis.fetch=original;}
});

test('automatic lookup rejects ambiguity and delayed provider results cannot undo an owner dismissal',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  let resolveSearch,signalSearch; const started=new Promise(resolve=>{signalSearch=resolve;});
  globalThis.fetch=async input=>{
    if(String(input).includes('/search/tv')) {signalSearch();return new Promise(resolve=>{resolveSearch=resolve;});}
    return provider()(input);
  };
  try {
    const enrichment=enrichEpisodes(env); await started;
    await identifyEpisode(env,owner,'v',{tmdbId:null,revision:'rev1'});
    resolveSearch(Response.json({results:[{id:10,name:'Star Trek',first_air_date:'1966-09-08'}],total_pages:1}));
    await enrichment;
    assert.equal((await episodeDetails(env,alice,'v')).match.state,'dismissed');
    await run(env.DB,"UPDATE videos SET revision='rev2' WHERE id='v'");
    globalThis.fetch=async input=>String(input).includes('/search/tv')?Response.json({results:[{id:10,name:'Star Trek',first_air_date:'1966-09-08'}],total_pages:2}):provider()(input);
    await enrichEpisodes(env);
    assert.equal((await episodeDetails(env,alice,'v')).match.state,'ambiguous');
  } finally {globalThis.fetch=original;}
});

test('episode artwork uses the fixed TMDB host and denies unauthorized requests',async()=>{
  const {env,owner,alice,bob}=await fixture(),original=globalThis.fetch; let imageUrl;
  globalThis.fetch=async (input,options)=>{if(String(input).startsWith('https://image.tmdb.org')){imageUrl=String(input);assert.equal(options.redirect,'manual');}return provider()(input);};
  try {
    await identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'});
    const details=await episodeDetails(env,alice,'v');
    assert.match(details.episode.still,/\/tv-artwork\/still\?r=rev1-102-/);
    await assert.rejects(()=>episodeImage(env,bob,'v','still'),error=>error.status===404);
    assert.equal((await episodeImage(env,alice,'v','still')).status,200);
    assert.equal(imageUrl,'https://image.tmdb.org/t/p/w500/still.jpg');
  } finally {globalThis.fetch=original;}
});

test('episode navigation includes only available authorized files and crosses season order',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;globalThis.fetch=provider();
  try {
    await run(env.DB,"INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) SELECT 'next',source_id,library_id,'tv/Star Trek/S01E03.mkv','Star Trek S01E03.mkv',parent,'s01e03','s01e03',bytes,modified,etag,revision,first_seen,last_seen FROM videos WHERE id='v'");
    await identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'});
    await identifyEpisode(env,owner,'next',{tmdbId:10,season:1,episode:3,revision:'rev1'});
    assert.equal((await episodeDetails(env,alice,'v')).next.id,'next');
    assert.equal((await episodeDetails(env,alice,'next')).previous.id,'v');
    await run(env.DB,"UPDATE videos SET available=0 WHERE id='next'");
    assert.equal((await episodeDetails(env,alice,'v')).next,null);
    assert.equal((await showDetails(env,alice,10)).total,1);
    await run(env.DB,"DELETE FROM grants WHERE user_id='alice'");
    assert.equal((await showCatalog(env,alice)).total,0);
  } finally {globalThis.fetch=original;}
});

test('next and previous skip duplicate files of the current episode',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;globalThis.fetch=provider();
  try {
    for(const [id,name] of [['copy','Star Trek S01E02 copy.mkv'],['next','Star Trek S01E03.mkv'],['earlier','Star Trek S01E03 copy.mkv']])
      await run(env.DB,"INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen) SELECT ?,source_id,library_id,?, ?,parent,?,?,bytes,modified,etag,revision,first_seen,last_seen FROM videos WHERE id='v'",id,`tv/Star Trek/${name}`,name,name.toLowerCase(),name.toLowerCase());
    await identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'});
    await identifyEpisode(env,owner,'copy',{tmdbId:10,season:1,episode:2,revision:'rev1'});
    await identifyEpisode(env,owner,'next',{tmdbId:10,season:1,episode:3,revision:'rev1'});
    await identifyEpisode(env,owner,'earlier',{tmdbId:10,season:1,episode:3,revision:'rev1'});
    assert.equal((await episodeDetails(env,alice,'v')).next.id,'earlier');
    assert.equal((await episodeDetails(env,alice,'next')).previous.id,'v');
  } finally {globalThis.fetch=original;}
});

test('provider episode belonging to a different show is rejected',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>String(input).includes('/season/1/episode/2')
    ?Response.json({id:102,show_id:11,season_number:1,episode_number:2,name:'Wrong show',credits:{cast:[]}})
    :provider()(input);
  try {
    await assert.rejects(()=>identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'}),error=>error.code==='metadata_invalid');
    assert.equal((await episodeDetails(env,alice,'v')).episode,null);
  } finally {globalThis.fetch=original;}
});

test('source replacement fences delayed TV metadata and invalidates old match',async()=>{
  const {env,owner,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>{
    if(String(input).includes('/season/1/episode/2'))await run(env.DB,"UPDATE videos SET revision='rev2' WHERE id='v'");
    return provider()(input);
  };
  try {
    await assert.rejects(()=>identifyEpisode(env,owner,'v',{tmdbId:10,season:1,episode:2,revision:'rev1'}),error=>error.status===409);
    assert.equal((await episodeDetails(env,alice,'v')).episode,null);
  } finally {globalThis.fetch=original;}
});

test('scheduled TV matching cannot publish after library switch or scope removal',async()=>{
  const {env,alice}=await fixture(),original=globalThis.fetch;
  globalThis.fetch=async input=>{
    if(String(input).includes('/season/1/episode/2'))await run(env.DB,"UPDATE libraries SET kind='movies' WHERE id='tv'");
    return provider()(input);
  };
  try {
    await enrichEpisodes(env);
    assert.equal((await episodeDetails(env,alice,'v')).episode,null);
    await run(env.DB,"UPDATE libraries SET kind='tv',prefix='elsewhere/' WHERE id='tv'");
    assert.equal(await enrichEpisodes(env),0);
  } finally {globalThis.fetch=original;}
});
