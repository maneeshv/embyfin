import {all, one, run, sql, fail, id, now, literal, normalize, string, number, boolean} from './core.js';
import {current} from './storage.js';

// Every catalog projection, count, image and stream uses this same permission predicate.
export const access = `l.enabled=1 AND v.source_id=l.source_id AND substr(v.object_key,1,length(l.prefix))=l.prefix
  AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND
    (u.role='owner' OR EXISTS(SELECT 1 FROM grants g WHERE g.user_id=u.id AND g.library_id=l.id)))`;
const state = `LEFT JOIN user_video s ON s.video_id=v.id AND s.user_id=?`;
const fields = `v.*,l.name AS library_name,l.prefix,COALESCE(s.favorite,0) favorite,
  CASE WHEN s.revision=v.revision THEN s.watched ELSE 0 END watched,
  CASE WHEN s.revision=v.revision THEN s.position ELSE 0 END position,
  CASE WHEN s.revision=v.revision THEN s.last_watched END last_watched`;
export function publicVideo(v) {
  const {object_key,source_id,search_name,search_path,seen_scan,etag,poster_key,prefix,refresh_requested,...visible} = v;
  visible.path = object_key.slice(prefix.length);
  visible.poster = poster_key ? `/api/videos/${v.id}/poster` : null;
  return visible;
}
export const libraries = (env,user) => all(env.DB, `SELECT l.id,l.name FROM libraries l WHERE l.enabled=1 AND
  EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.enabled=1 AND (u.role='owner' OR EXISTS(SELECT 1 FROM grants g WHERE g.user_id=u.id AND g.library_id=l.id))) ORDER BY l.name,l.id`,user.id);
export async function video(env,user,videoId) {
  const result = await one(env.DB,`SELECT ${fields} FROM videos v JOIN libraries l ON l.id=v.library_id ${state} WHERE v.id=? AND ${access}`,user.id,videoId,user.id);
  if (!result) fail(404,'not_found'); return result;
}
export async function catalog(env,user,params) {
  const where = [access,'v.available=1']; const args = [user.id,user.id];
  const library = params.get('library'), folder = params.get('folder'), query = string(params.get('q') || '',256,true);
  if (library) { where.push('l.id=?'); args.push(library); }
  if (folder !== null) {
    string(folder,1024,true);
    if (params.get('recursive') === '1') { where.push('substr(v.parent,1,length(?))=?'); args.push(folder,folder); }
    else { where.push('v.parent=?'); args.push(folder); }
  }
  if (query) { where.push("(v.search_name LIKE ? ESCAPE '\\' OR v.search_path LIKE ? ESCAPE '\\')"); args.push(`%${literal(query)}%`,`%${literal(query)}%`); }
  const section = params.get('section');
  if (section === 'continue') where.push('s.revision=v.revision AND s.position>0 AND s.watched=0');
  if (section === 'recent') where.push('s.revision=v.revision AND s.last_watched IS NOT NULL');
  if (section === 'favorites' || params.get('favorite') === '1') where.push('s.favorite=1');
  if (params.get('watched') === '1') where.push('s.revision=v.revision AND s.watched=1');
  if (params.get('watched') === '0') where.push('(s.watched IS NULL OR s.watched=0 OR s.revision<>v.revision)');
  const sorts = {name:'v.search_name',added:'v.first_seen',modified:'v.modified',size:'v.bytes',duration:'v.duration'};
  const sort = section==='added' ? 'v.first_seen' : sorts[params.get('sort')] || 'v.first_seen';
  const order = ['continue','recent'].includes(section) ? 's.last_watched DESC' : section==='added' ? 'v.first_seen DESC' : `${sort} ${params.get('direction') === 'asc' ? 'ASC':'DESC'}`;
  const limit = Math.max(1,Math.min(100,Number(params.get('limit')) || 36));
  const offset = Math.max(0,Math.min(1000000,Number(params.get('offset')) || 0));
  const from = `FROM videos v JOIN libraries l ON l.id=v.library_id ${state} WHERE ${where.join(' AND ')}`;
  const [items,count] = await env.DB.batch([
    sql(env.DB,`SELECT ${fields} ${from} ORDER BY ${sort==='v.duration'&&!['continue','recent'].includes(section)?'v.duration IS NULL,':''}${order},v.id LIMIT ? OFFSET ?`,...args,Math.floor(limit),Math.floor(offset)),
    sql(env.DB,`SELECT count(*) AS total ${from}`,...args),
  ]);
  return {items:items.results.map(publicVideo),total:count.results[0].total,offset,limit};
}
export async function folders(env,user,params) {
  const library = string(params.get('library'),100), parent = string(params.get('folder') || '',1024,true);
  const offset = Math.max(0,Math.min(1000000,Number(params.get('offset')) || 0));
  const items = await all(env.DB,`WITH paths AS (SELECT DISTINCT substr(v.parent,length(?)+1) AS rest
    FROM videos v JOIN libraries l ON l.id=v.library_id WHERE ${access} AND l.id=? AND v.available=1
    AND substr(v.parent,1,length(?))=? AND v.parent<>?)
    SELECT DISTINCT substr(rest,1,instr(rest,'/')) AS name FROM paths ORDER BY name LIMIT 101 OFFSET ?`,parent,user.id,library,parent,parent,parent,Math.floor(offset));
  return {items:items.slice(0,100).map(v=>({name:v.name,path:parent+v.name})),more:items.length>100};
}
export async function ensureCurrent(env,source,v) {
  if (!v.available) fail(410,'unavailable');
  try { return await current(source,v); }
  catch(error) { if ([409,410].includes(error.status)) await run(env.DB,'UPDATE videos SET refresh_requested=1 WHERE id=?',v.id); throw error; }
}
export async function personal(env,user,v,action,data) {
  await run(env.DB,'INSERT OR IGNORE INTO user_video(user_id,video_id,revision) SELECT ?,id,revision FROM videos WHERE id=?',user.id,v.id);
  if (action === 'favorite') await run(env.DB,'UPDATE user_video SET favorite=? WHERE user_id=? AND video_id=?',boolean(data.favorite),user.id,v.id);
  else {
    if (data.revision !== v.revision) fail(409,'source_changed');
    if (action === 'session') {
      const generation = id();
      const result = await run(env.DB,`UPDATE user_video SET generation=?,sequence=0,
        position=CASE WHEN ? THEN 0 ELSE position END,watched=CASE WHEN ? THEN 0 ELSE watched END
        WHERE user_id=? AND video_id=? AND revision=? AND EXISTS(SELECT 1 FROM videos WHERE id=? AND revision=? AND available=1)`,
        generation,boolean(data.startOver ?? false),boolean(data.startOver ?? false),user.id,v.id,v.revision,v.id,v.revision);
      if (!result.meta.changes) fail(409,'source_changed');
      return {generation,revision:v.revision,position:data.startOver ? 0 : v.position};
    }
    if (action === 'watched') await run(env.DB,`UPDATE user_video SET watched=?,position=0,generation=NULL,sequence=0 WHERE user_id=? AND video_id=? AND revision=?`,boolean(data.watched),user.id,v.id,v.revision);
    else if (action === 'progress') {
      const position = number(data.position,0,v.duration || 31536000), sequence = number(data.sequence,1,Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(sequence)) fail(400,'invalid_sequence');
      const result = await run(env.DB,`UPDATE user_video SET position=?,watched=CASE WHEN ? THEN 1 ELSE watched END,
        last_watched=?,sequence=? WHERE user_id=? AND video_id=? AND revision=? AND generation=? AND sequence<?
        AND EXISTS(SELECT 1 FROM videos WHERE id=? AND revision=? AND available=1 AND refresh_requested=0)`,
        position,boolean(data.ended ?? false),now(),sequence,user.id,v.id,v.revision,string(data.generation,100),sequence,v.id,v.revision);
      if (!result.meta.changes) fail(409,'stale_playback','A newer playback session or changed original superseded this session.');
    }
  }
  return {ok:true};
}
