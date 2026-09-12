import {all, one, run, sql, id, now, fail, normalize, revision} from './core.js';

export async function startScan(env,libraryId) {
  const time = now();
  await env.DB.batch([
    sql(env.DB,`INSERT INTO scans(id,library_id,status,started_at,updated_at)
      SELECT ?,id,'listing',?,? FROM libraries WHERE id=? AND enabled=1 AND paused=0
      AND NOT EXISTS(SELECT 1 FROM scans WHERE library_id=? AND status IN ('listing','reconciling','paused'))`,id(),time,time,libraryId,libraryId),
    sql(env.DB,'UPDATE libraries SET frozen=1,next_scan=? WHERE id=?',time+86400,libraryId),
  ]);
}
export async function scanIntent(env,libraryId,action) {
  const library = await one(env.DB,'SELECT * FROM libraries WHERE id=?',libraryId); if (!library) fail(404,'not_found');
  if (action === 'pause') await env.DB.batch([
    sql(env.DB,'UPDATE libraries SET paused=1 WHERE id=?',libraryId),
    sql(env.DB,"UPDATE scans SET resume_status=status,status='paused',lease_token=NULL,lease_until=NULL WHERE library_id=? AND status IN ('listing','reconciling')",libraryId),
  ]);
  else if (action === 'resume') await env.DB.batch([
    sql(env.DB,'UPDATE libraries SET paused=0 WHERE id=?',libraryId),
    sql(env.DB,"UPDATE scans SET status=resume_status,updated_at=? WHERE library_id=? AND status='paused'",now(),libraryId),
  ]);
  else if (action === 'start') { if (library.paused) fail(409,'scan_paused'); await startScan(env,libraryId); }
  else fail(400,'invalid_scan_action');
}
const fence = `EXISTS(SELECT 1 FROM scans s JOIN libraries l ON l.id=s.library_id WHERE s.id=? AND s.lease_token=? AND s.lease_until>? AND s.lease_until>unixepoch() AND s.status IN ('listing','reconciling') AND l.enabled=1 AND l.paused=0)`;
export async function objectStatements(env,library,object,scanId,token,time) {
  const relative = object.key.slice(library.prefix.length), slash = relative.lastIndexOf('/');
  const filename = relative.slice(slash+1), parent = relative.slice(0,slash+1), fingerprint = await revision(object);
  return [
    sql(env.DB,`INSERT INTO videos(id,source_id,library_id,object_key,filename,parent,search_name,search_path,bytes,modified,etag,revision,first_seen,last_seen,seen_scan)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence}
      ON CONFLICT(source_id,object_key) DO UPDATE SET bytes=excluded.bytes,modified=excluded.modified,etag=excluded.etag,
        revision=excluded.revision,last_seen=excluded.last_seen,seen_scan=excluded.seen_scan,available=1,refresh_requested=0`,
      id(),library.source_id,library.id,object.key,filename,parent,normalize(filename),normalize(relative),object.bytes,object.modified,object.etag,fingerprint,time,time,scanId,scanId,token,time),
    sql(env.DB,`INSERT OR IGNORE INTO jobs(id,video_id,revision)
      SELECT id||':'||revision||':1',id,revision FROM videos WHERE source_id=? AND object_key=? AND ${fence}`,library.source_id,object.key,scanId,token,time),
  ];
}
export async function scanStep(env,source) {
  const time = now(), token = id();
  const due = await all(env.DB,`SELECT id FROM libraries WHERE enabled=1 AND paused=0 AND next_scan<=? ORDER BY next_scan LIMIT 5`,time);
  for (const l of due) await startScan(env,l.id);
  const scan = await one(env.DB,`UPDATE scans SET lease_token=?,lease_until=?,updated_at=? WHERE id=(
    SELECT s.id FROM scans s JOIN libraries l ON l.id=s.library_id WHERE s.status IN ('listing','reconciling')
    AND l.enabled=1 AND l.paused=0 AND COALESCE(s.lease_until,0)<? ORDER BY s.updated_at,s.id LIMIT 1) RETURNING *`,token,time+45,time,time);
  if (!scan) return;
  const library = await one(env.DB,'SELECT * FROM libraries WHERE id=?',scan.library_id);
  const statements = [];
  try {
    if (scan.status === 'listing') {
      const page = await source.list(library.prefix,scan.cursor,40);
      if (page.cursor && page.cursor === scan.cursor) fail(502,'repeated_cursor');
      const extensions = (env.VIDEO_EXTENSIONS || 'mp4,m4v,mov,webm,mkv,avi,mpg,mpeg,mts,m2ts,ts,wmv,flv,ogv').split(',');
      let ignored = 0;
      for (const object of page.objects) {
        if (object.key.endsWith('/') || !extensions.includes(object.key.split('.').pop().toLowerCase())) { ignored++; continue; }
        statements.push(...await objectStatements(env,library,object,scan.id,token,time));
      }
      statements.push(sql(env.DB,`UPDATE scans SET cursor=?,status=?,ignored=ignored+?,
        discovered=(SELECT count(*) FROM videos WHERE seen_scan=?),updated_at=?,lease_token=NULL,lease_until=NULL,error=NULL
        WHERE id=? AND lease_token=? AND lease_until>? AND status='listing'`,page.cursor,page.cursor?'listing':'reconciling',ignored,scan.id,now(),scan.id,token,now()));
    } else {
      const unseen = await all(env.DB,`SELECT * FROM videos WHERE library_id=? AND available=1 AND (seen_scan IS NULL OR seen_scan<>?) LIMIT 8`,library.id,scan.id);
      const heads=await Promise.all(unseen.map(v=>source.head(v.object_key)));
      for (let i=0;i<unseen.length;i++) {
        const v=unseen[i],object=heads[i];
        if (object) statements.push(...await objectStatements(env,library,object,scan.id,token,time));
        else statements.push(sql(env.DB,`UPDATE videos SET available=0,refresh_requested=0 WHERE id=? AND ${fence}`,v.id,scan.id,token,now()));
      }
      if (!unseen.length) {
        statements.push(sql(env.DB,`UPDATE libraries SET last_success=? WHERE id=? AND ${fence}`,now(),library.id,scan.id,token,now()));
        statements.push(sql(env.DB,`UPDATE scans SET status='complete',completed_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND lease_until>? AND status='reconciling'`,now(),now(),scan.id,token,now()));
      } else statements.push(sql(env.DB,`UPDATE scans SET updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,now(),scan.id,token));
    }
    // D1 batch is transactional: objects, replacement invalidation, jobs and cursor commit together.
    await env.DB.batch(statements);
  } catch(error) {
    if (error.code === 'source_network') {
      await run(env.DB,`UPDATE scans SET error='source_network',updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,now(),scan.id,token);
    } else if (error.code === 'invalid_cursor' && scan.cursor_restarts < 2) {
      await run(env.DB,`UPDATE scans SET cursor=NULL,cursor_restarts=cursor_restarts+1,ignored=0,lease_token=NULL,lease_until=NULL,error='Listing cursor expired; safely restarting.' WHERE id=? AND lease_token=?`,scan.id,token);
    } else await run(env.DB,`UPDATE scans SET status='failed',error=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,error.code || 'scan_failed',now(),scan.id,token);
  }
}
