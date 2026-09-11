import {all, one, run, sql, fail, id, now, number, string, body, json} from './core.js';
import {machineIdentity} from './auth.js';
import {ensureCurrent} from './catalog.js';

// A temporary canary is limited to three videos and an absolute expiry.
export function processingSample(env) {
  if (!env.PROCESSING_SAMPLE) return {ids:null,until:Number.MAX_SAFE_INTEGER};
  const sample=JSON.parse(env.PROCESSING_SAMPLE);
  if (!Array.isArray(sample.ids) || sample.ids.length<1 || sample.ids.length>3 ||
      sample.ids.some(id=>typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id)) ||
      !Number.isSafeInteger(sample.until) || sample.until<=0) throw Error('invalid_processing_sample');
  return {ids:JSON.stringify(sample.ids),until:sample.until};
}

export async function validRun(env,token) {
  const run = await one(env.DB,"SELECT * FROM processor_runs WHERE slot=1 AND token=? AND status='active' AND lease_until>? AND deadline>?",token,now(),now());
  if (!run) fail(409,'stale_run'); return run;
}
export async function validJob(env,token,jobId,lease) {
  const job = await one(env.DB,`SELECT j.*,v.object_key,v.etag,v.bytes,v.modified,v.library_id FROM jobs j
    JOIN videos v ON v.id=j.video_id JOIN libraries l ON l.id=v.library_id
    WHERE j.id=? AND j.token=? AND j.run_token=? AND j.state='leased' AND j.lease_until>?
    AND v.revision=j.revision AND v.available=1 AND l.enabled=1 AND v.source_id=l.source_id
    AND substr(v.object_key,1,length(l.prefix))=l.prefix`,jobId,lease,token,now());
  if (!job) fail(409,'stale_job'); return job;
}
export async function claim(env,token) {
  const active = await validRun(env,token), time = now(), lease = id(), sample=processingSample(env);
  if (Math.min(active.deadline,sample.until)-time < active.job_seconds+15) return null;
  const job = await one(env.DB,`UPDATE jobs SET state='leased',token=?,run_token=?,lease_until=?,attempts=attempts+1,
    read_bytes=0,read_requests=0,poster_key=NULL,error=NULL WHERE id=(
      SELECT j.id FROM jobs j JOIN videos v ON v.id=j.video_id JOIN libraries l ON l.id=v.library_id
      WHERE j.state='pending' AND j.attempts<3 AND j.retry_after<=? AND v.revision=j.revision
      AND v.available=1 AND l.enabled=1 AND l.paused=0
      AND (? IS NULL OR v.id IN (SELECT value FROM json_each(?))) ORDER BY j.retry_after,j.id LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE state='leased')
    AND EXISTS(SELECT 1 FROM processor_runs WHERE slot=1 AND token=? AND status='active' AND lease_until>? AND deadline>?) RETURNING *`,
    lease,token,Math.min(time+90,active.deadline),time,sample.ids,sample.ids,token,time,time+active.job_seconds+15);
  if (!job) return null;
  const video = await one(env.DB,'SELECT * FROM videos WHERE id=?',job.video_id);
  return {id:job.id,lease,revision:job.revision,bytes:video.bytes,type:video.filename.split('.').pop(),deadline:Math.min(active.deadline,time+active.job_seconds),readLimit:active.read_limit};
}
export async function retryFailed(env,libraryId) {
  await env.DB.batch([
    sql(env.DB,`UPDATE jobs SET state='pending',attempts=0,error=NULL,retry_after=0,token=NULL,lease_until=NULL
      WHERE state IN ('failed','stale') AND EXISTS(SELECT 1 FROM videos v WHERE v.id=jobs.video_id AND v.revision=jobs.revision AND v.library_id=?)`,libraryId),
    sql(env.DB,`UPDATE videos SET enrichment='pending',processing_error=NULL WHERE library_id=? AND enrichment='failed'`,libraryId),
    sql(env.DB,'UPDATE processor_runs SET next_dispatch=0 WHERE slot=1'),
  ]);
}
export async function expireJobs(env) {
  await env.DB.batch([
    sql(env.DB,`UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
      error='processor_interrupted',retry_after=?,token=NULL,lease_until=NULL
      WHERE state='leased' AND (lease_until<? OR NOT EXISTS(SELECT 1 FROM processor_runs r WHERE r.token=jobs.run_token AND r.status='active' AND r.lease_until>? AND r.deadline>?))`,now()+60,now(),now(),now()),
    sql(env.DB,`UPDATE videos SET enrichment='failed',processing_error='processor_interrupted'
      WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.video_id=videos.id AND j.revision=videos.revision AND j.state='failed')`),
  ]);
}
export async function machine(request,env,source,controller) {
  const token = await machineIdentity(request,env), active = await validRun(env,token);
  const action = new URL(request.url).pathname.slice('/machine/'.length);
  if (request.method !== 'POST') fail(405,'method_not_allowed');
  if (action === 'claim') {
    const job = await claim(env,token);
    return json({job});
  }
  const jobId = request.headers.get('X-Job-Id'), lease = request.headers.get('X-Job-Lease');
  const job = await validJob(env,token,jobId,lease);
  if (action === 'heartbeat') {
    const until = Math.min(now()+90,active.deadline);
    await env.DB.batch([
      sql(env.DB,"UPDATE processor_runs SET heartbeat=?,lease_until=? WHERE token=? AND status='active' AND lease_until>? AND deadline>?",now(),until,token,now(),now()),
      sql(env.DB,"UPDATE jobs SET lease_until=? WHERE id=? AND token=? AND state='leased' AND lease_until>?",until,job.id,lease,now()),
    ]);
    await controller.heartbeat(token); return json({ok:true,deadline:active.deadline});
  }
  if (action === 'access') {
    const data = await body(request), start = number(data.start,0,job.bytes-1), end = number(data.end,start,job.bytes-1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end-start+1>4*1024*1024) fail(400,'invalid_read');
    // Reserve before signing. Repeated and failed requests consume the same finite budget.
    const reserved = await run(env.DB,`UPDATE jobs SET read_bytes=read_bytes+?,read_requests=read_requests+1
      WHERE id=? AND token=? AND state='leased' AND lease_until>? AND read_bytes+?<=?`,end-start+1,job.id,lease,now(),end-start+1,active.read_limit);
    if (!reserved.meta.changes) fail(422,'read_budget_exceeded');
    await run(env.DB,'UPDATE processor_runs SET read_bytes=read_bytes+? WHERE token=?',end-start+1,token);
    await ensureCurrent(env,source,{...job,id:job.video_id,available:1});
    return json(await source.access(job.object_key,job.etag,{start,end},Math.min(60,active.deadline-now())));
  }
  const key = `posters/${job.video_id}/${job.revision}/v1-${lease}.jpg`;
  if (action === 'poster') {
    const length = Number(request.headers.get('Content-Length'));
    if (request.headers.get('Content-Type') !== 'image/jpeg' || !Number.isSafeInteger(length) || length<4 || length>2097152) fail(413,'invalid_poster');
    const reader = request.body.getReader(), chunks = []; let size = 0;
    for (;;) { const {done,value} = await reader.read(); if (done) break; size+=value.length; if (size>2097152) {await reader.cancel();fail(413,'invalid_poster');} chunks.push(value); }
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    if (size!==length || bytes[0]!==255 || bytes[1]!==216 || bytes[size-2]!==255 || bytes[size-1]!==217) fail(400,'invalid_poster');
    await env.POSTERS.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});
    await run(env.DB,"UPDATE jobs SET poster_key=? WHERE id=? AND token=? AND state='leased' AND lease_until>?",key,job.id,lease,now());
    return json({ok:true});
  }
  const data = await body(request);
  if (action === 'complete') {
    await ensureCurrent(env,source,{...job,id:job.video_id,available:1});
    if (job.poster_key !== key || !await env.POSTERS.head(key)) fail(409,'poster_missing');
    const value = (key,max) => data[key] == null ? null : number(data[key],0,max);
    const label = key => data[key] == null ? null : string(data[key],128);
    const fence = `EXISTS(SELECT 1 FROM jobs j JOIN processor_runs r ON r.token=j.run_token WHERE j.id=? AND j.token=?
      AND j.state='leased' AND j.lease_until>? AND r.status='active' AND r.lease_until>? AND r.deadline>?)`;
    const results = await env.DB.batch([
      sql(env.DB,`UPDATE videos SET duration=?,width=?,height=?,container=?,video_codec=?,audio_codec=?,poster_key=?,enrichment='ready',processing_error=NULL
        WHERE id=? AND revision=? AND ${fence}`,value('duration',31536000),value('width',32768),value('height',32768),label('container'),label('videoCodec'),label('audioCodec'),key,job.video_id,job.revision,job.id,lease,now(),now(),now()),
      sql(env.DB,`UPDATE jobs SET state='ready',token=NULL,lease_until=NULL,elapsed_ms=?,cpu_ms=?,peak_rss=?,peak_scratch=? WHERE id=? AND ${fence}`,
        value('elapsedMs',1200000)||0,value('cpuMs',1200000)||0,value('peakRss',6442450944)||0,value('peakScratch',1073741824)||0,job.id,job.id,lease,now(),now(),now()),
    ]);
    if (!results[0].meta.changes) fail(409,'stale_job');
    return json({ok:true});
  }
  if (action === 'fail') {
    const errors = ['network','source_changed','unavailable','read_budget_exceeded','time_budget_exceeded','scratch_budget_exceeded','unsupported_or_corrupt','upload_failed','processor_failed'];
    const code = errors.includes(data.code) ? data.code : 'processor_failed';
    const retry = ['network','upload_failed'].includes(code) && job.attempts<3;
    const fence = `EXISTS(SELECT 1 FROM jobs j JOIN processor_runs r ON r.token=j.run_token WHERE j.id=? AND j.token=?
      AND j.state='leased' AND j.lease_until>? AND r.status='active' AND r.lease_until>? AND r.deadline>?)`;
    await env.DB.batch([
      sql(env.DB,`UPDATE videos SET enrichment=?,processing_error=?,refresh_requested=CASE WHEN ? THEN 1 ELSE refresh_requested END WHERE id=? AND revision=? AND ${fence}`,retry?'pending':'failed',code,+['source_changed','unavailable'].includes(code),job.video_id,job.revision,job.id,lease,now(),now(),now()),
      sql(env.DB,`UPDATE jobs SET state=?,error=?,retry_after=?,token=NULL,lease_until=NULL WHERE id=? AND ${fence}`,retry?'pending':'failed',code,now()+60*2**job.attempts,job.id,job.id,lease,now(),now(),now()),
    ]);
    return json({ok:true});
  }
  fail(404,'not_found');
}
