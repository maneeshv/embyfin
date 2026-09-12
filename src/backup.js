import {createHash} from 'node:crypto';
import {now, one, fail} from './core.js';
export const backupState = async env => (await env.BACKUPS.get('control/backup.json'))?.json() || null;
const save = (env,state) => env.BACKUPS.put('control/backup.json',JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
export const maintenance = async env => env.MAINTENANCE === 'true' || !!await env.BACKUPS.head('control/maintenance.json');
export async function requestBackup(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_DATABASE_ID) fail(503,'backup_not_configured','Configure backup export credentials before starting a backup.');
  const state = await backupState(env);
  if (state && !['complete','failed'].includes(state.status)) return state;
  const next = {status:'draining',started:now(),lastComplete:state?.lastComplete || null,schemaVersion:1};
  await save(env,next); return next;
}
async function copySQL(env,url,key) {
  if (new URL(url).protocol !== 'https:') fail(502,'invalid_export_url');
  const response = await fetch(url,{signal:AbortSignal.timeout(20000)});
  if (!response.ok || !response.body) fail(502,'export_download_failed');
  const upload = await env.BACKUPS.createMultipartUpload(key,{httpMetadata:{contentType:'application/sql'}});
  const reader = response.body.getReader(), hash = createHash('sha256'), parts=[];
  let block = new Uint8Array(5*1024*1024), used=0, total=0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      hash.update(value); total += value.length;
      // ponytail: 512 MiB export ceiling; checkpoint multipart copying if the catalog outgrows a bounded tick.
      if (total>512*1024*1024) fail(507,'backup_size_budget');
      let offset=0;
      while (offset<value.length) {
        const n=Math.min(block.length-used,value.length-offset); block.set(value.subarray(offset,offset+n),used);used+=n;offset+=n;
        if (used===block.length) {parts.push(await upload.uploadPart(parts.length+1,block));used=0;block=new Uint8Array(block.length);}
      }
    }
    if (!total) fail(502,'empty_export');
    if (used) parts.push(await upload.uploadPart(parts.length+1,block.subarray(0,used)));
    await upload.complete(parts);
    return {bytes:total,sha256:hash.digest('hex')};
  } catch(error) { await reader.cancel().catch(()=>{});await upload.abort();throw error; }
}
export async function backupTick(env,controller) {
  let state = await backupState(env);
  const last = state?.lastComplete?.completed || 0;
  if (now()-last>86400) console.error(JSON.stringify({event:'embyfin_backup_stale',ageSeconds:last?now()-last:null}));
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_DATABASE_ID) return !!state && !['complete','failed'].includes(state.status);
  const today = new Date().toISOString().slice(0,10);
  if ((!state || ['complete','failed'].includes(state.status)) && state?.day!==today && new Date().getUTCHours()>=Number(env.BACKUP_HOUR_UTC || 2)) {
    state=await requestBackup(env);state.day=today;await save(env,state);
  }
  if (!state || ['complete','failed'].includes(state.status)) return false;
  try {
    if (state.status==='draining') {
      await controller.halt('backup');
      // Gate is in R2 before draining. Let every pre-gate 45/90-second lease and bounded request expire.
      if (now()-state.started<100) return true;
      const busy = await one(env.DB,"SELECT count(*) AS n FROM scans WHERE lease_until>?",now());
      if (busy.n) return true;
      state.status='exporting';await save(env,state);
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_DATABASE_ID}/export`,{
      method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({output_format:'polling',...(state.bookmark?{current_bookmark:state.bookmark}:{})}),signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) fail(502,'export_request_failed');
    const envelope = await response.json(), result=envelope.result;
    if (!envelope.success || !result || result.status==='error') fail(502,'export_failed');
    state.bookmark=result.at_bookmark || state.bookmark;
    if (result.status!=='complete') {await save(env,state);return true;}
    const key=`daily/${state.day || today}/${state.started}.sql`;
    const copy=await copySQL(env,result.result.signed_url,key);
    const manifest={key,...copy,schemaVersion:1,started:state.started,completed:now(),bookmark:state.bookmark};
    await env.BACKUPS.put(`${key}.json`,JSON.stringify(manifest));
    state={status:'complete',day:state.day || today,lastComplete:manifest};await save(env,state);
    // Retention follows all cursors and deletes only completed backup days outside the 30-day window.
    const cutoff = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    let cursor;
    do {
      const list=await env.BACKUPS.list({prefix:'daily/',limit:1000,cursor});
      const expired=list.objects.filter(o=>o.key.split('/')[1]<cutoff).map(o=>o.key);
      if(expired.length) await env.BACKUPS.delete(expired);
      cursor=list.truncated?list.cursor:undefined;
    } while(cursor);
    console.log(JSON.stringify({event:'embyfin_backup_complete',bytes:copy.bytes,elapsedSeconds:now()-manifest.started}));
    return false;
  } catch(error) {
    // Keep the export gate closed if provider completion is uncertain; operator can inspect/retry outside D1.
    state.error=error.code || 'backup_failed';state.lastError=now();await save(env,state);
    console.error(JSON.stringify({event:'embyfin_backup_failed',code:state.error}));return true;
  }
}
