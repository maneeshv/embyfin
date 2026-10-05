import {all, one, run, sql, fail, now, normalize, string, number, literal} from '#src/core.js';
import {access, catalog, video} from '#src/catalog.js';
import {tmdb, clean, imagePath, tmdbId, fetchArtwork} from '#src/tmdb.js';

const scope='v.source_id=l.source_id AND substr(v.object_key,1,length(l.prefix))=l.prefix';
const artwork=(v,episode,kind,person)=>`/api/videos/${v.id}/tv-artwork/${kind}?${person?`person=${person}&`:''}r=${v.revision.slice(0,16)}-${episode.id}-${episode.updated_at}`;
const page=params=>({offset:Math.max(0,Math.min(1000000,Number(params.get('offset'))||0)),limit:Math.max(1,Math.min(100,Number(params.get('limit'))||36))});
const yearValue=value=>{if(value===undefined||value===null||value==='')return undefined;const year=Number(value);if(!Number.isInteger(year)||year<1878||year>new Date().getUTCFullYear()+2)fail(400,'invalid_year');return year;};
const showShape=(show,v,episode)=>({id:show.id,name:show.name,year:show.first_air_date?.slice(0,4)||null,
  firstAirDate:show.first_air_date,overview:show.overview,genres:JSON.parse(show.genres||'[]'),
  poster:show.poster_path?artwork(v,{id:episode.id,updated_at:show.updated_at},'poster'):null,
  backdrop:show.backdrop_path?artwork(v,{id:episode.id,updated_at:show.updated_at},'backdrop'):null});
const episodeShape=(episode,v)=>({id:episode.id,showId:episode.show_id,seasonNumber:episode.season_number,episodeNumber:episode.episode_number,
  title:episode.name,overview:episode.overview,airDate:episode.air_date,runtime:episode.runtime,
  still:episode.still_path?artwork(v,episode,'still'):null});
const accessible=async(env,user,videoId)=>{const v=await video(env,user,string(videoId,100));if(!v.available)fail(404,'not_found');return v;};

export function parseEpisodeFilename(filename,parent='') {
  if(typeof filename!=='string'||typeof parent!=='string')return null;
  const base=filename.replace(/\.[^.]+$/,'').replace(/[._]+/g,' ');
  const markers=[...base.matchAll(/(?:^|[^A-Za-z0-9])(?:S(\d{1,2})E(\d{1,3})|(\d{1,2})x(\d{1,3}))(?![A-Za-z0-9])/gi)];
  if(markers.length!==1)return null;
  const mark=markers[0],season=Number(mark[1]??mark[3]),episode=Number(mark[2]??mark[4]);
  const after=base.slice(mark.index+mark[0].length);
  if(!episode||/(?:^\s*(?:[-+&,/]|\band\b)\s*E?\d{1,3}\b|\bE\d{1,3}\b|\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b)/i.test(after))return null;
  let title=base.slice(0,mark.index).replace(/[\s([\]-]+$/g,'').trim();
  if(!title)title=parent.split('/').filter(Boolean).map(p=>p.replace(/[._]+/g,' ')).reverse()
    .find(p=>!/^season\s*\d{1,2}$|^s\d{1,2}$|^specials$/i.test(p))||'';
  const yearMatch=/[\s([\]](19\d{2}|20\d{2})(?=[\s)\]]|$)/.exec(title);
  const year=yearMatch?Number(yearMatch[1]):undefined;
  if(yearMatch)title=title.slice(0,yearMatch.index).trim();
  title=title.replace(/[\s([\]-]+$/g,'').trim();
  if(title.length<2||title.length>200)return null;
  return {title,year,season,episode};
}

export async function searchShows(env,query,year) {
  query=string(query,200).trim();if(!query)fail(400,'invalid_input');year=yearValue(year);
  const data=await tmdb(env,'/search/tv',{query,first_air_date_year:year,include_adult:'false'});
  if(!Array.isArray(data.results))fail(502,'metadata_invalid');
  return data.results.slice(0,10).filter(item=>item&&Number.isInteger(item.id)&&item.id>0&&typeof item.name==='string'&&!item.adult)
    .map(item=>({id:item.id,title:clean(item.name,200),year:clean(item.first_air_date,10).slice(0,4)||null,overview:clean(item.overview,1000)}));
}

async function matchState(env,v,episode,state,automatic=false) {
  const result=await run(env.DB,`INSERT INTO episode_matches(video_id,revision,episode_id,state,checked_at)
    SELECT v.id,v.revision,?,?,? FROM videos v JOIN libraries l ON l.id=v.library_id
    WHERE v.id=? AND v.revision=? AND v.available=1 AND l.enabled=1 AND ${scope}
      ${automatic?"AND l.kind='tv' AND l.paused=0 AND NOT EXISTS(SELECT 1 FROM movie_matches mm WHERE mm.video_id=v.id AND mm.revision=v.revision AND mm.state IN ('matched','dismissed'))":''}
      ${v.ownerId?"AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND u.role='owner')":''}
    ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision,episode_id=excluded.episode_id,state=excluded.state,checked_at=excluded.checked_at
      ${automatic?"WHERE episode_matches.state IN ('failed','unmatched','ambiguous')":''}`,
    episode,state,now(),v.id,v.revision,...(v.ownerId?[v.ownerId]:[]));
  if(!result.meta.changes)fail(409,'source_changed');
}

async function saveEpisode(env,v,showId,season,episodeNumber,automatic=false) {
  showId=tmdbId(showId);season=number(season,0,999);episodeNumber=number(episodeNumber,1,1000);
  if(!Number.isInteger(season)||!Number.isInteger(episodeNumber))fail(400,'invalid_number');
  const [show,episode]=await Promise.all([
    tmdb(env,`/tv/${showId}`),
    tmdb(env,`/tv/${showId}/season/${season}/episode/${episodeNumber}`,{append_to_response:'credits'}),
  ]);
  if(show.id!==showId||typeof show.name!=='string'||!show.name.trim()||show.adult||
    !Number.isInteger(episode.id)||episode.id<1||episode.id>2147483647||
    (episode.show_id!==undefined&&episode.show_id!==showId)||episode.season_number!==season||episode.episode_number!==episodeNumber||
    typeof episode.name!=='string'||!episode.name.trim())fail(502,'metadata_invalid');
  const credits=episode.credits;
  const people=[...(Array.isArray(credits?.cast)?credits.cast:[]),...(Array.isArray(credits?.guest_stars)?credits.guest_stars:Array.isArray(episode.guest_stars)?episode.guest_stars:[])];
  const seen=new Set();const cast=people.filter(p=>p&&Number.isInteger(p.id)&&p.id>0&&typeof p.name==='string'&&p.name&&!seen.has(p.id)&&seen.add(p.id)).slice(0,30);
  const statements=[
    sql(env.DB,`INSERT INTO tv_shows(id,name,search_name,first_air_date,overview,genres,poster_path,backdrop_path,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,search_name=excluded.search_name,
      first_air_date=excluded.first_air_date,overview=excluded.overview,genres=excluded.genres,poster_path=excluded.poster_path,
      backdrop_path=excluded.backdrop_path,updated_at=excluded.updated_at`,showId,clean(show.name,200),normalize(show.name).slice(0,200),
      clean(show.first_air_date,10),clean(show.overview,4000),JSON.stringify((Array.isArray(show.genres)?show.genres:[]).map(g=>clean(g?.name,50)).filter(Boolean).slice(0,20)),
      imagePath(show.poster_path),imagePath(show.backdrop_path),now()),
    sql(env.DB,`INSERT INTO tv_episodes(id,show_id,season_number,episode_number,name,search_name,overview,air_date,runtime,still_path,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET show_id=excluded.show_id,season_number=excluded.season_number,
      episode_number=excluded.episode_number,name=excluded.name,search_name=excluded.search_name,overview=excluded.overview,
      air_date=excluded.air_date,runtime=excluded.runtime,still_path=excluded.still_path,updated_at=excluded.updated_at`,
      episode.id,showId,season,episodeNumber,clean(episode.name,200),normalize(episode.name).slice(0,200),clean(episode.overview,4000),
      clean(episode.air_date,10),Number.isInteger(episode.runtime)&&episode.runtime>0?episode.runtime:null,imagePath(episode.still_path),now()),
    sql(env.DB,'DELETE FROM tv_cast WHERE episode_id=?',episode.id),
    ...cast.map((p,index)=>sql(env.DB,'INSERT OR IGNORE INTO tv_cast(episode_id,person_id,name,character,profile_path,position) VALUES(?,?,?,?,?,?)',
      episode.id,p.id,clean(p.name,200),clean(p.character,200),imagePath(p.profile_path),index)),
    sql(env.DB,`INSERT INTO episode_matches(video_id,revision,episode_id,state,checked_at)
      SELECT v.id,v.revision,?,'matched',? FROM videos v JOIN libraries l ON l.id=v.library_id
      WHERE v.id=? AND v.revision=? AND v.available=1 AND l.enabled=1 AND ${scope}
        ${automatic?"AND l.kind='tv' AND l.paused=0 AND NOT EXISTS(SELECT 1 FROM movie_matches mm WHERE mm.video_id=v.id AND mm.revision=v.revision AND mm.state IN ('matched','dismissed'))":''}
        ${v.ownerId?"AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND u.role='owner')":''}
      ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision,episode_id=excluded.episode_id,state=excluded.state,checked_at=excluded.checked_at
        ${automatic?"WHERE episode_matches.state IN ('failed','unmatched','ambiguous')":''}`,
      episode.id,now(),v.id,v.revision,...(v.ownerId?[v.ownerId]:[])),
  ];
  const results=await env.DB.batch(statements);
  if(!results.at(-1).meta.changes)fail(409,'source_changed');
}

async function autoMatch(env,v,automatic) {
  const parsed=parseEpisodeFilename(v.filename,v.parent);
  if(!parsed)return matchState(env,v,null,'unmatched',automatic);
  const data=await tmdb(env,'/search/tv',{query:parsed.title,first_air_date_year:parsed.year,include_adult:'false'});
  if(!Array.isArray(data.results))fail(502,'metadata_invalid');
  const exact=data.results.filter(item=>item&&Number.isInteger(item.id)&&item.id>0&&!item.adult&&typeof item.name==='string'&&
    normalize(item.name)===normalize(parsed.title)&&(!parsed.year||clean(item.first_air_date,10).startsWith(String(parsed.year))));
  if(exact.length===1&&(!Number.isInteger(data.total_pages)||data.total_pages<=1))return saveEpisode(env,v,exact[0].id,parsed.season,parsed.episode,automatic);
  return matchState(env,v,null,exact.length?'ambiguous':'unmatched',automatic);
}

export async function identifyEpisode(env,user,videoId,data) {
  const owner=await one(env.DB,"SELECT 1 ok FROM users WHERE id=? AND enabled=1 AND role='owner'",user.id);
  if(!owner)fail(403,'forbidden');
  const v=await accessible(env,user,videoId);v.ownerId=user.id;
  if(!data||typeof data!=='object'||Array.isArray(data)||!(Object.hasOwn(data,'tmdbId')||data.auto===true))fail(400,'invalid_input');
  if(data.revision!==v.revision)fail(409,'source_changed');
  if(data.auto===true)await autoMatch(env,v,false);
  else if(data.tmdbId===null)await matchState(env,v,null,'dismissed');
  else await saveEpisode(env,v,tmdbId(data.tmdbId),data.season,data.episode);
  return episodeDetails(env,user,videoId);
}

export async function enrichEpisodes(env,limit=3) {
  if(!env.TMDB_READ_TOKEN)return 0;
  limit=Math.max(1,Math.min(3,Math.floor(limit)));
  const candidates=await all(env.DB,`SELECT v.id,v.filename,v.parent,v.revision FROM videos v JOIN libraries l ON l.id=v.library_id
    LEFT JOIN episode_matches em ON em.video_id=v.id AND em.revision=v.revision
    LEFT JOIN movie_matches mm ON mm.video_id=v.id AND mm.revision=v.revision
    WHERE l.kind='tv' AND l.enabled=1 AND l.paused=0 AND ${scope} AND v.available=1
      AND (mm.video_id IS NULL OR mm.state NOT IN ('matched','dismissed'))
      AND (em.video_id IS NULL OR (em.state IN ('failed','unmatched','ambiguous') AND em.checked_at<?))
    ORDER BY COALESCE(em.checked_at,0),v.first_seen,v.id LIMIT ?`,now()-86400,limit);
  for(const v of candidates){
    try {await autoMatch(env,v,true);}
    catch(error){if(error.code==='source_changed')continue;await matchState(env,v,null,'failed',true).catch(()=>{});}
  }
  return candidates.length;
}

export async function episodeDetails(env,user,videoId) {
  const v=await accessible(env,user,videoId);
  const match=await one(env.DB,'SELECT state,checked_at,episode_id FROM episode_matches WHERE video_id=? AND revision=?',v.id,v.revision);
  if(!match?.episode_id)return {match:match||{state:'pending'},show:null,episode:null,cast:[],previous:null,next:null};
  const row=await one(env.DB,'SELECT e.*,t.name show_name,t.search_name show_search_name,t.first_air_date,t.overview show_overview,t.genres,t.poster_path,t.backdrop_path,t.updated_at show_updated_at FROM tv_episodes e JOIN tv_shows t ON t.id=e.show_id WHERE e.id=?',match.episode_id);
  if(!row)fail(404,'not_found');
  const cast=await all(env.DB,'SELECT person_id AS id,name,character,profile_path FROM tv_cast WHERE episode_id=? ORDER BY position LIMIT 30',row.id);
  const around=async direction=>{
    const before=direction==='previous';
    const found=await one(env.DB,`SELECT v.id,e.name AS title,e.season_number AS seasonNumber,e.episode_number AS episodeNumber
      FROM episode_matches em JOIN tv_episodes e ON e.id=em.episode_id
      JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1 JOIN libraries l ON l.id=v.library_id
      WHERE e.show_id=? AND ${access} AND (e.season_number,e.episode_number) ${before?'<':'>'} (?,?)
      ORDER BY e.season_number ${before?'DESC':'ASC'},e.episode_number ${before?'DESC':'ASC'},v.id ${before?'DESC':'ASC'} LIMIT 1`,row.show_id,user.id,row.season_number,row.episode_number);
    return found||null;
  };
  const show={id:row.show_id,name:row.show_name,first_air_date:row.first_air_date,overview:row.show_overview,genres:row.genres,
    poster_path:row.poster_path,backdrop_path:row.backdrop_path,updated_at:row.show_updated_at};
  return {match,show:showShape(show,v,row),episode:episodeShape(row,v),
    cast:cast.map(p=>({id:p.id,name:p.name,character:p.character,profile:p.profile_path?artwork(v,row,'person',p.id):null})),
    previous:await around('previous'),next:await around('next')};
}

export async function showCatalog(env,user,params=new URLSearchParams()) {
  const {offset,limit}=page(params),q=string(params.get('q')||'',200,true),library=string(params.get('library')||'',100,true);
  const where=[access,'v.available=1'];const args=[user.id];
  if(q){where.push("t.search_name LIKE ? ESCAPE '\\'");args.push(`%${literal(q)}%`);}
  if(library){where.push('l.id=?');args.push(library);}
  const from=`FROM episode_matches em JOIN tv_episodes e ON e.id=em.episode_id JOIN tv_shows t ON t.id=e.show_id
    JOIN videos v ON v.id=em.video_id AND v.revision=em.revision JOIN libraries l ON l.id=v.library_id WHERE ${where.join(' AND ')}`;
  const rows=await all(env.DB,`SELECT t.*,COUNT(DISTINCT v.id) AS episodeCount,COUNT(DISTINCT e.season_number) AS seasonCount,
    MIN(v.id) AS sample_video,MIN(v.revision) AS sample_revision,MIN(e.id) AS sample_episode,MAX(e.updated_at) AS episode_updated_at
    ${from} GROUP BY t.id ORDER BY t.search_name,t.id LIMIT ? OFFSET ?`,...args,Math.floor(limit),Math.floor(offset));
  const count=await one(env.DB,`SELECT COUNT(DISTINCT t.id) AS total ${from}`,...args);
  return {items:rows.map(t=>({id:t.id,name:t.name,year:t.first_air_date?.slice(0,4)||null,overview:t.overview,
    poster:t.poster_path?artwork({id:t.sample_video,revision:t.sample_revision},{id:t.sample_episode,updated_at:t.updated_at},'poster'):null,
    backdrop:t.backdrop_path?artwork({id:t.sample_video,revision:t.sample_revision},{id:t.sample_episode,updated_at:t.updated_at},'backdrop'):null,
    episodeCount:t.episodeCount,seasonCount:t.seasonCount})),total:count.total,offset,limit};
}

export async function showDetails(env,user,showId,params=new URLSearchParams()) {
  showId=tmdbId(Number(showId));
  const representative=await one(env.DB,`SELECT t.*,v.id AS sample_video,v.revision AS sample_revision,e.id AS sample_episode,e.updated_at AS episode_updated_at
    FROM episode_matches em JOIN tv_episodes e ON e.id=em.episode_id JOIN tv_shows t ON t.id=e.show_id
    JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1 JOIN libraries l ON l.id=v.library_id
    WHERE t.id=? AND ${access} ORDER BY e.season_number,e.episode_number,v.id LIMIT 1`,showId,user.id);
  if(!representative)fail(404,'not_found');
  const seasonParam=params.get('season');
  if(seasonParam!==null&&(!/^\d{1,3}$/.test(seasonParam)||Number(seasonParam)>1000))fail(400,'invalid_number');
  const seasons=await all(env.DB,`SELECT e.season_number AS number,COUNT(DISTINCT v.id) AS episodeCount
    FROM episode_matches em JOIN tv_episodes e ON e.id=em.episode_id
    JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1 JOIN libraries l ON l.id=v.library_id
    WHERE e.show_id=? AND ${access} GROUP BY e.season_number ORDER BY e.season_number`,showId,user.id);
  const cast=await all(env.DB,`SELECT tc.person_id AS id,tc.name,tc.character,tc.profile_path,
    MIN(v.id) AS sample_video,MIN(v.revision) AS sample_revision,MIN(e.id) AS sample_episode,MAX(e.updated_at) AS episode_updated_at
    FROM tv_cast tc JOIN tv_episodes e ON e.id=tc.episode_id JOIN episode_matches em ON em.episode_id=e.id AND em.state='matched'
    JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1 JOIN libraries l ON l.id=v.library_id
    WHERE e.show_id=? AND ${access} GROUP BY tc.person_id ORDER BY MIN(tc.position),tc.person_id LIMIT 30`,showId,user.id);
  const filters=new URLSearchParams(params);filters.set('type','tv');filters.set('show',String(showId));filters.set('sort','episode');filters.set('direction','asc');
  const result=await catalog(env,user,filters);
  return {show:showShape(representative,{id:representative.sample_video,revision:representative.sample_revision},{id:representative.sample_episode,updated_at:representative.episode_updated_at}),
    cast:cast.map(p=>({id:p.id,name:p.name,character:p.character,profile:p.profile_path?artwork({id:p.sample_video,revision:p.sample_revision},{id:p.sample_episode,updated_at:p.episode_updated_at},'person',p.id):null})),
    seasons,...result};
}

export async function episodeImage(env,user,videoId,kind,personId) {
  const v=await accessible(env,user,videoId);
  const row=await one(env.DB,`SELECT e.*,t.poster_path,t.backdrop_path FROM episode_matches em
    JOIN tv_episodes e ON e.id=em.episode_id JOIN tv_shows t ON t.id=e.show_id
    WHERE em.video_id=? AND em.revision=? AND em.state='matched'`,v.id,v.revision);
  if(!row)fail(404,'not_found');
  let path;
  if(kind==='person'){
    personId=tmdbId(Number(personId));
    path=(await one(env.DB,`SELECT tc.profile_path FROM tv_cast tc JOIN tv_episodes e ON e.id=tc.episode_id
      JOIN episode_matches em ON em.episode_id=e.id AND em.state='matched'
      JOIN videos v ON v.id=em.video_id AND v.revision=em.revision AND v.available=1 JOIN libraries l ON l.id=v.library_id
      WHERE e.show_id=? AND tc.person_id=? AND ${access} LIMIT 1`,row.show_id,personId,user.id))?.profile_path;
  } else if(kind==='poster'||kind==='backdrop')path=row[`${kind}_path`];
  else if(kind==='still')path=row.still_path;
  else fail(400,'invalid_image');
  return fetchArtwork(path,kind);
}
