import {all, one, run, fail, id, now, string} from '#src/core.js';
import {access, video} from '#src/catalog.js';
import {subtitleStatus, subtitleProvider as provider, limited} from '#src/subtitle-auth.js';
export {subtitleStatus} from '#src/subtitle-auth.js';

const maxText=256*1024;
const track=row=>({id:row.id,language:row.language,release:row.release,label:row.release,source:'OpenSubtitles',url:`/api/videos/${row.video_id}/subtitles/${row.id}.vtt`});
const language=value=>{const v=string(value || 'en',20);if(!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(v))fail(400,'invalid_language');return v.toLowerCase();};

function srtToVtt(input) {
  const cues=[];
  for(const block of input.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n\s*\n/)) {
    const lines=block.split('\n');
    if(/^\d+$/.test(lines[0])) lines.shift();
    const match=/^(\d{2}:\d{2}:\d{2}),([0-9]{3}) --> (\d{2}:\d{2}:\d{2}),([0-9]{3})(?: X1:\d+ X2:\d+ Y1:\d+ Y2:\d+)?$/.exec(lines.shift() || '');
    if(!match || !lines.length || !lines.some(Boolean))fail(422,'invalid_subtitle');
    const millis=(clock,fraction)=>{
      const [hours,minutes,seconds]=clock.split(':').map(Number);
      if(minutes>59 || seconds>59)fail(422,'invalid_subtitle');
      return ((hours*60+minutes)*60+seconds)*1000+Number(fraction);
    };
    if(millis(match[3],match[4])<=millis(match[1],match[2]))fail(422,'invalid_subtitle');
    const text=lines.join('\n').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    cues.push(`${match[1]}.${match[2]} --> ${match[3]}.${match[4]}\n${text}`);
  }
  if(!cues.length)fail(422,'invalid_subtitle');
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export async function listSubtitles(env,user,videoId) {
  const v=await video(env,user,videoId);
  if(!v.available)fail(410,'unavailable');
  const rows=await all(env.DB,`SELECT s.id,s.video_id,s.language,s.release FROM video_subtitles s
    JOIN videos v ON v.id=s.video_id JOIN libraries l ON l.id=v.library_id
    WHERE s.video_id=? AND s.revision=? AND v.revision=s.revision AND v.available=1 AND s.vtt<>'' AND ${access}
    ORDER BY (s.language='en') DESC,s.created_at,s.id`,v.id,v.revision,user.id);
  return {items:rows.map(track),defaultId:rows[0]?.id || null};
}

export async function searchSubtitles(env,user,videoId,params) {
  const v=await video(env,user,videoId);
  if(!v.available)fail(410,'unavailable');
  const query=params.get('query') || params.get('q');
  const wanted=params.get('language');
  const url=new URLSearchParams({type:v.episode_id||(!v.movie_id&&v.library_kind==='tv')?'episode':'movie'});
  if(v.episode_id){
    if(query)url.set('query',string(query,200));else url.set('parent_tmdb_id',String(v.show_id));
    url.set('season_number',String(v.episode_season));url.set('episode_number',String(v.episode_number));
  }else if(!query && v.movie_id)url.set('tmdb_id',String(v.movie_id));
  else url.set('query',string(query || v.filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' '),200));
  if(wanted)url.set('languages',language(wanted));
  const result=await provider(env,`/subtitles?${url}`);
  if(!Array.isArray(result.data))fail(502,'subtitle_provider_error');
  return {items:result.data.slice(0,25).flatMap(item=>{
    const a=item?.attributes,fileId=a?.files?.[0]?.file_id;
    if(!Number.isSafeInteger(fileId) || fileId<1 || typeof a?.language!=='string')return [];
    const release=String(a.release || a.feature_details?.title || 'Subtitle').slice(0,200);
    return [{fileId,language:a.language,release,label:release,hearingImpaired:!!a.hearing_impaired,downloadCount:Number(a.download_count)||0,downloads:Number(a.download_count)||0}];
  })};
}

export async function importSubtitle(env,user,videoId,data) {
  const v=await video(env,user,videoId);
  if(!v.available)fail(410,'unavailable');
  if(data.revision!==v.revision)fail(409,'source_changed');
  const fileId=data.fileId;
  if(!Number.isSafeInteger(fileId) || fileId<1)fail(400,'invalid_input');
  const lang=language(data.language),release=string(data.release || data.label || 'Subtitle',200);
  const existing=await one(env.DB,`SELECT s.id,s.video_id,s.language,s.release,length(s.vtt) AS ready,s.created_at
    FROM video_subtitles s JOIN videos v ON v.id=s.video_id JOIN libraries l ON l.id=v.library_id
    WHERE s.video_id=? AND s.revision=? AND s.file_id=? AND v.revision=s.revision AND v.available=1 AND ${access}`,
    v.id,v.revision,fileId,user.id);
  if(existing?.ready)return track(existing);
  if(existing && existing.created_at>now()-60)fail(409,'subtitle_import_pending');
  if(!subtitleStatus(env).configured)fail(503,'subtitles_unconfigured');
  const subtitleId=id();
  const started=now();
  let reserved=await run(env.DB,`INSERT OR IGNORE INTO video_subtitles(id,video_id,revision,file_id,language,release,vtt,created_at)
    SELECT ?,v.id,v.revision,?,?,?,'',? FROM videos v JOIN libraries l ON l.id=v.library_id
    WHERE v.id=? AND v.revision=? AND v.available=1 AND ${access}`,subtitleId,fileId,lang,release,started,v.id,v.revision,user.id);
  if(!reserved.meta.changes) {
    reserved=await run(env.DB,`UPDATE video_subtitles SET id=?,language=?,release=?,created_at=?
      WHERE video_id=? AND revision=? AND file_id=? AND vtt='' AND created_at<=?
      AND EXISTS(SELECT 1 FROM videos v JOIN libraries l ON l.id=v.library_id WHERE v.id=video_subtitles.video_id
        AND v.revision=video_subtitles.revision AND v.available=1 AND ${access})`,
      subtitleId,lang,release,started,v.id,v.revision,fileId,started-60,user.id);
    if(!reserved.meta.changes) {
      const row=await one(env.DB,`SELECT s.id,s.video_id,s.language,s.release,length(s.vtt) AS ready
        FROM video_subtitles s JOIN videos v ON v.id=s.video_id JOIN libraries l ON l.id=v.library_id
        WHERE s.video_id=? AND s.revision=? AND s.file_id=? AND v.revision=s.revision AND v.available=1 AND ${access}`,
        v.id,v.revision,fileId,user.id);
      if(row?.ready)return track(row);
      fail(row?409:404,row?'subtitle_import_pending':'not_found');
    }
  }
  let saved=false;
  try {
    const link=await provider(env,'/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:fileId,sub_format:'srt'})});
    let url;
    try {url=new URL(link.link);}catch {fail(502,'subtitle_provider_error');}
    const authority=typeof link.link==='string' ? link.link.match(/^https:\/\/([^/?#]+)/)?.[1]?.toLowerCase() : null;
    if(url.protocol!=='https:' || !['dl.opensubtitles.com','www.opensubtitles.com'].includes(authority) || url.username || url.password || url.port)fail(502,'subtitle_provider_error');
    let response;
    try {response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});}catch {fail(502,'subtitle_provider_error');}
    const vtt=srtToVtt(await limited(response,maxText));
    if(new TextEncoder().encode(vtt).length>maxText)fail(413,'invalid_subtitle');
    const result=await run(env.DB,`UPDATE video_subtitles SET vtt=? WHERE id=? AND video_id=? AND revision=? AND vtt=''
      AND EXISTS(SELECT 1 FROM videos v JOIN libraries l ON l.id=v.library_id WHERE v.id=video_subtitles.video_id
        AND v.revision=video_subtitles.revision AND v.available=1 AND ${access})`,vtt,subtitleId,v.id,v.revision,user.id);
    if(!result.meta.changes)fail(409,'source_changed');
    saved=true;
    return track({id:subtitleId,video_id:v.id,language:lang,release});
  } finally {
    if(!saved)await run(env.DB,"DELETE FROM video_subtitles WHERE id=? AND vtt=''",subtitleId);
  }
}

export async function subtitleContent(env,user,videoId,subtitleId) {
  const v=await video(env,user,videoId);
  if(!v.available)fail(410,'unavailable');
  const key=string(subtitleId,100).replace(/\.vtt$/,'');
  const row=await one(env.DB,`SELECT s.vtt FROM video_subtitles s JOIN videos v ON v.id=s.video_id
    JOIN libraries l ON l.id=v.library_id WHERE s.id=? AND s.video_id=? AND s.revision=?
    AND v.revision=s.revision AND v.available=1 AND s.vtt<>'' AND ${access}`,key,v.id,v.revision,user.id);
  if(!row)fail(404,'not_found');
  return new Response(row.vtt,{headers:{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'private, max-age=86400, immutable'}});
}
