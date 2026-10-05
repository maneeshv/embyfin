import {all, one, run, sql, fail, now, normalize, string} from '#src/core.js';
import {access, catalog, video} from '#src/catalog.js';

import {tmdb,clean,imagePath as path,tmdbId as movieId,fetchArtwork} from '#src/tmdb.js';

const scope = 'v.source_id=l.source_id AND substr(v.object_key,1,length(l.prefix))=l.prefix';
const automaticScope = "l.kind='movies' AND l.paused=0 AND NOT EXISTS(SELECT 1 FROM episode_matches em WHERE em.video_id=v.id AND em.revision=v.revision AND em.state='matched')";
const artwork = (v,movie,kind,person) => `/api/videos/${v.id}/artwork/${kind}?${person?`person=${person}&`:''}r=${v.revision.slice(0,16)}-${movie.id}-${movie.updated_at}`;
export const movieFeatures = env => ({metadata:!!env.TMDB_READ_TOKEN});

export async function searchMovies(env,query,year) {
  query=string(query,200).trim(); if (!query) fail(400,'invalid_input');
  if (year!==undefined && year!==null && year!=='') {
    year=Number(year); if (!Number.isInteger(year) || year<1878 || year>new Date().getUTCFullYear()+2) fail(400,'invalid_year');
  } else year=undefined;
  const result=await tmdb(env,'/search/movie',{query,year,include_adult:'false'});
  return (Array.isArray(result.results)?result.results:[]).slice(0,10).filter(item=>item && Number.isInteger(item.id) && typeof item.title==='string' && !item.adult).map(item=>({
    id:item.id,title:clean(item.title,200),year:clean(item.release_date,10).slice(0,4)||null,
    overview:clean(item.overview,1000),poster:null,
  }));
}
async function accessibleMovieVideo(env,user,videoId) {
  const v=await video(env,user,string(videoId,100));
  if (!v.available) fail(404,'not_found');
  return v;
}
async function matchState(env,v,movie,state,automatic=false) {
  const result=await run(env.DB,`INSERT INTO movie_matches(video_id,revision,movie_id,state,checked_at)
    SELECT v.id,v.revision,?,?,? FROM videos v JOIN libraries l ON l.id=v.library_id
    WHERE v.id=? AND v.revision=? AND v.available=1 AND l.enabled=1 AND ${scope}
      ${automatic?'AND '+automaticScope:''}
      ${v.ownerId?"AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND u.role='owner')":''}
    ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision,movie_id=excluded.movie_id,
      state=excluded.state,checked_at=excluded.checked_at
      ${automatic?"WHERE movie_matches.state IN ('failed','unmatched','ambiguous')":''}`,movie,state,now(),v.id,v.revision,...(v.ownerId?[v.ownerId]:[]));
  if (!result.meta.changes) fail(409,'source_changed');
}
async function saveMovie(env,v,id,automatic=false) {
  const details=await tmdb(env,`/movie/${movieId(id)}`,{append_to_response:'credits'});
  if (details.id!==id || typeof details.title!=='string' || !details.title.trim() || details.adult) fail(502,'metadata_invalid');
  const cast=(Array.isArray(details.credits?.cast)?details.credits.cast:[]).filter(p=>p && Number.isInteger(p.id) && p.id>0 && typeof p.name==='string' && p.name).slice(0,30);
  const statements=[sql(env.DB,`INSERT INTO movies(id,title,search_title,release_date,overview,tagline,runtime,genres,poster_path,backdrop_path,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,search_title=excluded.search_title,
    release_date=excluded.release_date,overview=excluded.overview,tagline=excluded.tagline,runtime=excluded.runtime,
    genres=excluded.genres,poster_path=excluded.poster_path,backdrop_path=excluded.backdrop_path,updated_at=excluded.updated_at`,
    id,clean(details.title,200),normalize(details.title).slice(0,200),clean(details.release_date,10),clean(details.overview,4000),
    clean(details.tagline,500),Number.isInteger(details.runtime)?details.runtime:null,
    JSON.stringify((Array.isArray(details.genres)?details.genres:[]).map(g=>clean(g?.name,50)).filter(Boolean).slice(0,20)),
    path(details.poster_path),path(details.backdrop_path),now()),
    sql(env.DB,'DELETE FROM movie_cast WHERE movie_id=?',id),
    ...cast.map((p,index)=>sql(env.DB,`INSERT OR IGNORE INTO movie_cast(movie_id,person_id,name,character,profile_path,position) VALUES(?,?,?,?,?,?)`,
      id,p.id,clean(p.name,200),clean(p.character,200),path(p.profile_path),index)),
    sql(env.DB,`INSERT INTO movie_matches(video_id,revision,movie_id,state,checked_at)
      SELECT v.id,v.revision,?,'matched',? FROM videos v JOIN libraries l ON l.id=v.library_id
      WHERE v.id=? AND v.revision=? AND v.available=1 AND l.enabled=1 AND ${scope}
      ${automatic?'AND '+automaticScope:''}
      ${v.ownerId?"AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND u.role='owner')":''}
      ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision,movie_id=excluded.movie_id,
      state=excluded.state,checked_at=excluded.checked_at
      ${automatic?"WHERE movie_matches.state IN ('failed','unmatched','ambiguous')":''}`,id,now(),v.id,v.revision,...(v.ownerId?[v.ownerId]:[]))];
  const results=await env.DB.batch(statements);
  if (!results.at(-1).meta.changes) fail(409,'source_changed');
}
export async function identifyMovie(env,user,videoId,data) {
  const owner=await one(env.DB,"SELECT 1 ok FROM users WHERE id=? AND enabled=1 AND role='owner'",user.id);
  if (!owner) fail(403,'forbidden');
  const v=await accessibleMovieVideo(env,user,videoId);
  v.ownerId=user.id;
  if (!data || typeof data!=='object' || !(Object.hasOwn(data,'tmdbId') || data.auto===true)) fail(400,'invalid_input');
  if (data.revision!==v.revision) fail(409,'source_changed');
  if (data.auto===true) await autoMatch(env,v,false);
  else if (data.tmdbId===null) await matchState(env,v,null,'dismissed');
  else await saveMovie(env,v,movieId(data.tmdbId));
  return movieDetails(env,user,videoId);
}
export async function movieDetails(env,user,videoId) {
  const v=await accessibleMovieVideo(env,user,videoId);
  const match=await one(env.DB,'SELECT state,checked_at,movie_id FROM movie_matches WHERE video_id=? AND revision=?',v.id,v.revision);
  const movie=match?.movie_id ? await one(env.DB,'SELECT * FROM movies WHERE id=?',match.movie_id) : null;
  const cast=movie ? await all(env.DB,'SELECT person_id AS id,name,character,profile_path FROM movie_cast WHERE movie_id=? ORDER BY position',movie.id) : [];
  return {match:match||{state:'pending'},movie:movie?{
    id:movie.id,title:movie.title,year:movie.release_date?.slice(0,4)||null,release_date:movie.release_date,
    overview:movie.overview,tagline:movie.tagline,runtime:movie.runtime,genres:JSON.parse(movie.genres||'[]'),
    poster:movie.poster_path?artwork(v,movie,'poster'):null,
    backdrop:movie.backdrop_path?artwork(v,movie,'backdrop'):null,
  }:null,cast:cast.map(p=>({id:p.id,name:p.name,character:p.character,
    profile:p.profile_path?artwork(v,movie,'person',p.id):null}))};
}
export async function personDetails(env,user,personId,params=new URLSearchParams()) {
  personId=movieId(Number(personId));
  let person=await one(env.DB,`SELECT mc.name,mc.profile_path,v.id AS video_id,v.revision,m.id AS movie_id,m.updated_at FROM movie_cast mc
    JOIN movie_matches mm ON mm.movie_id=mc.movie_id AND mm.state='matched'
    JOIN movies m ON m.id=mm.movie_id
    JOIN videos v ON v.id=mm.video_id AND v.revision=mm.revision AND v.available=1
    JOIN libraries l ON l.id=v.library_id WHERE mc.person_id=? AND ${access} LIMIT 1`,personId,user.id);
  let profile=person?.profile_path?artwork({id:person.video_id,revision:person.revision},{id:person.movie_id,updated_at:person.updated_at},'person',personId):null;
  if(!person){
    person=await one(env.DB,`SELECT tc.name,tc.profile_path,v.id AS video_id,v.revision,e.id AS episode_id,e.updated_at
      FROM tv_cast tc JOIN tv_episodes e ON e.id=tc.episode_id JOIN episode_matches em ON em.episode_id=e.id AND em.state='matched'
      JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1
      JOIN libraries l ON l.id=v.library_id WHERE tc.person_id=? AND ${access} LIMIT 1`,personId,user.id);
    if(person?.profile_path)profile=`/api/videos/${person.video_id}/tv-artwork/person?person=${personId}&r=${person.revision.slice(0,16)}-${person.episode_id}-${person.updated_at}`;
  }
  if (!person) fail(404,'not_found');
  const filters=new URLSearchParams(params); filters.set('person',String(personId)); filters.delete('type');
  const result=await catalog(env,user,filters);
  return {person:{id:personId,name:person.name,profile},...result};
}
export async function movieImage(env,user,videoId,kind,personId) {
  const v=await accessibleMovieVideo(env,user,videoId);
  let image;
  if (kind==='person') {
    personId=movieId(Number(personId));
    image=await one(env.DB,`SELECT mc.profile_path AS path FROM movie_matches mm JOIN movie_cast mc ON mc.movie_id=mm.movie_id
      WHERE mm.video_id=? AND mm.revision=? AND mm.state='matched' AND mc.person_id=?`,v.id,v.revision,personId);
  } else if (kind==='poster' || kind==='backdrop') {
    image=await one(env.DB,`SELECT m.${kind}_path AS path FROM movie_matches mm JOIN movies m ON m.id=mm.movie_id
      WHERE mm.video_id=? AND mm.revision=? AND mm.state='matched'`,v.id,v.revision);
  } else fail(400,'invalid_image');
  return fetchArtwork(image?.path,kind);
}
function parseFilename(filename) {
  const base=filename.replace(/\.[^.]+$/,'').replace(/[._]+/g,' ');
  if (/(?:\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\b(?:season|episode)\s*\d+\b)/i.test(base)) return null;
  const year=/[\s.\[(](19\d{2}|20\d{2})(?=[\s.\])]|$)/.exec(base);
  const title=(year?base.slice(0,year.index):base.split(/\b(?:1080p|2160p|720p|bluray|webrip|web-dl|dvdrip|x264|x265)\b/i)[0])
    .replace(/[._]+/g,' ').replace(/[\s([\]-]+$/g,'').trim();
  if (title.length<2 || title.length>200) return null;
  return {title,year:year?Number(year[1]):undefined};
}
export async function enrichMovies(env,limit=3) {
  if (!env.TMDB_READ_TOKEN) return 0;
  limit=Math.max(1,Math.min(3,Math.floor(limit)));
  const candidates=await all(env.DB,`SELECT v.id,v.filename,v.revision FROM videos v JOIN libraries l ON l.id=v.library_id
    LEFT JOIN movie_matches mm ON mm.video_id=v.id AND mm.revision=v.revision
    WHERE ${automaticScope} AND l.enabled=1 AND ${scope} AND v.available=1 AND (mm.video_id IS NULL OR
      (mm.state IN ('failed','unmatched','ambiguous') AND mm.checked_at<?))
    ORDER BY COALESCE(mm.checked_at,0),v.first_seen,v.id LIMIT ?`,now()-86400,limit);
  for (const v of candidates) {
    try {
      await autoMatch(env,v,true);
    } catch (error) {
      if (error.code==='source_changed') continue;
      await matchState(env,v,null,'failed',true).catch(()=>{});
    }
  }
  return candidates.length;
}
async function autoMatch(env,v,automatic) {
  const parsed=parseFilename(v.filename);
  if (!parsed) return matchState(env,v,null,'unmatched',automatic);
  const result=await tmdb(env,'/search/movie',{query:parsed.title,year:parsed.year,include_adult:'false'});
  const exact=(Array.isArray(result.results)?result.results:[]).filter(item=>item && !item.adult && Number.isInteger(item.id)
    && typeof item.title==='string' && normalize(item.title)===normalize(parsed.title)
    && (!parsed.year || (typeof item.release_date==='string' && item.release_date.startsWith(String(parsed.year)))));
  if (exact.length===1 && (!Number.isInteger(result.total_pages) || result.total_pages<=1)) return saveMovie(env,v,exact[0].id,automatic);
  return matchState(env,v,null,exact.length?'ambiguous':'unmatched',automatic);
}
