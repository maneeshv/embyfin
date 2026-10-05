import {Container} from '@cloudflare/containers';
import {handle} from './worker.js';
import {one, run, now, id} from './core.js';
import {R2Source} from './storage.js';
import {scanStep} from './scans.js';
import {expireJobs,processingSample} from './jobs.js';
import {machineToken} from './auth.js';
import {backupTick, maintenance} from './backup.js';
import {enrichMovies} from '#src/movies.js';
import {enrichEpisodes} from '#src/tv.js';
import {SubtitleSession} from '#src/subtitle-auth.js';
import {ProviderSettings} from '#src/providers.js';

export interface Env {
  DB:D1Database; POSTERS:R2Bucket; BACKUPS:R2Bucket; ASSETS:Fetcher;
  PROCESSOR:DurableObjectNamespace<MediaController>;
  APP_ORIGIN:string; MAINTENANCE:string; PROCESSING_ENABLED:string;
  JOB_SECONDS:string; JOB_READ_LIMIT:string; BATCH_SECONDS:string;
  [key:string]:unknown;
}
type Active = {token:string;deadline:number};
export class MediaController extends Container<Env> {
  sleepAfter='60s';
  private ticking?:Promise<void>;
  private controls:Promise<unknown>=Promise.resolve();
  private subtitleAuth=new SubtitleSession(this.env,this.ctx.storage);
  private providers=new ProviderSettings(this.env,this.ctx.storage,this.subtitleAuth);
  async providerConfiguration() {return this.providers.configuration();}
  async updateProvider(data:unknown) {return this.providers.update(data);}
  async subtitleSession(rejectedToken='',credentials?:Record<string,string>) {return this.subtitleAuth.get(rejectedToken,credentials ?? (await this.providers.configuration()).credentials);}
  private control<T>(task:()=>Promise<T>):Promise<T> {
    const next=this.controls.then(task,task);
    this.controls=next.catch(()=>{});
    return next;
  }
  async heartbeat(token:string) {
    const active=await this.ctx.storage.get<Active>('active');
    if (!active || active.token!==token || active.deadline<=now()) throw Error('stale_run');
    this.renewActivityTimeout();
  }
  async halt(reason:string) {
    // Confirm destruction before clearing the slot, including a controller restart after launch failure.
    await this.destroy();
    await run(this.env.DB,"UPDATE processor_runs SET status='stopped',error=? WHERE slot=1",reason);
    await this.ctx.storage.delete('active');
  }
  async deadline(payload:Active) {
    return this.control(async()=>{
      const active=await this.ctx.storage.get<Active>('active');
      if (!active || active.token!==payload.token) return;
      await this.schedule(15,'hardStop',payload);
      await this.stop();
    });
  }
  async hardStop(payload:Active) {
    return this.control(async()=>{
      const active=await this.ctx.storage.get<Active>('active');
      if (active?.token===payload.token) {
        console.log(JSON.stringify({event:'embyfin_processor_stop',overrunSeconds:Math.max(0,now()-active.deadline)}));
        await this.halt('batch_deadline');
      }
    });
  }
  override async onActivityExpired() { await this.control(()=>this.halt('idle_timeout')); }
  override async onStop({exitCode,reason}:{exitCode:number;reason:string}) {
    // Next tick reconciles state; a delayed event must not fence a new run.
    console.log(JSON.stringify({event:'embyfin_processor_exit',exitCode,reason}));
  }
  override onError(error:unknown) { console.error(JSON.stringify({event:'embyfin_processor_error',message:error instanceof Error?error.message:'unknown'})); }
  async tick() {
    if(this.ticking)return this.ticking;
    this.ticking=this.control(()=>this.advance()).finally(()=>{this.ticking=undefined;});
    return this.ticking;
  }
  async backupContinue() {
    await this.ctx.storage.delete('backupAlarm');
    await this.tick();
  }
  private async advance() {
      if (await maintenance(this.env)) {await this.halt('maintenance');return;}
      if (await backupTick(this.env,this)) {
        if(!await this.ctx.storage.get('backupAlarm')) {
          const alarm=await this.schedule(5,'backupContinue');
          await this.ctx.storage.put('backupAlarm',alarm.taskId);
        }
        return;
      }
      const previous=await one(this.env.DB,'SELECT * FROM processor_runs WHERE slot=1');
      if (previous && (previous.status!=='active' || previous.lease_until<=now() || previous.deadline<=now() || (await this.getState()).status==='stopped')) await this.halt(previous.error || 'lease_expired');
      await expireJobs(this.env);
      await run(this.env.DB,'UPDATE libraries SET next_scan=0 WHERE paused=0 AND EXISTS(SELECT 1 FROM videos v WHERE v.library_id=libraries.id AND v.refresh_requested=1)');
      if (this.env.SOURCE_ACCESS_KEY_ID) await scanStep(this.env,new R2Source(this.env));
      const metadataEnv={...this.env,...(await this.providers.configuration()).credentials};
      await enrichMovies(metadataEnv);
      await enrichEpisodes(metadataEnv);
      if (this.env.PROCESSING_ENABLED!=='true') return;
      const sample=processingSample(this.env);
      if (sample.until<=now()) return;
      const pending=await one(this.env.DB,`SELECT j.id FROM jobs j JOIN videos v ON v.id=j.video_id JOIN libraries l ON l.id=v.library_id
        WHERE j.state='pending' AND j.retry_after<=? AND j.attempts<3 AND v.revision=j.revision AND v.available=1 AND l.enabled=1 AND l.paused=0
        AND (? IS NULL OR v.id IN (SELECT value FROM json_each(?))) LIMIT 1`,now(),sample.ids,sample.ids);
      if (!pending) return;
      const token=id(),started=now(),deadline=Math.min(sample.until,started+Math.min(600,Math.max(150,Number(this.env.BATCH_SECONDS)||600)));
      const jobSeconds=Math.min(120,Math.max(10,Number(this.env.JOB_SECONDS)||120));
      const readLimit=Math.min(268435456,Math.max(1048576,Number(this.env.JOB_READ_LIMIT)||268435456));
      const acquired=await one(this.env.DB,`INSERT INTO processor_runs(slot,token,status,started_at,deadline,lease_until,heartbeat,read_limit,job_seconds,next_dispatch)
        VALUES(1,?,'active',?,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET token=excluded.token,status='active',started_at=excluded.started_at,
        deadline=excluded.deadline,lease_until=excluded.lease_until,heartbeat=excluded.heartbeat,read_limit=excluded.read_limit,
        job_seconds=excluded.job_seconds,read_bytes=0,next_dispatch=excluded.next_dispatch,error=NULL
        WHERE processor_runs.status='stopped' AND processor_runs.next_dispatch<=? RETURNING token`,token,started,deadline,started+90,started,readLimit,jobSeconds,started+900,started);
      if (!acquired) return;
      const active={token,deadline};
      await this.ctx.storage.put('active',active);
      await this.schedule(new Date(deadline*1000),'deadline',active);
      try {
        await this.start({envVars:{EMBYFIN_URL:this.env.APP_ORIGIN,RUN_TOKEN:await machineToken(this.env,token,deadline),RUN_DEADLINE:String(deadline)}},{portToCheck:8080,signal:AbortSignal.timeout(30_000)});
        console.log(JSON.stringify({event:'embyfin_processor_started'}));
      } catch (error) {
        console.error(JSON.stringify({event:'embyfin_processor_start_failed',message:error instanceof Error?error.message:'unknown'}));
        await this.halt('startup_failed');
      }
  }
}
export default {
  fetch(request:Request,env:Env,ctx:ExecutionContext) { return handle(request,env,ctx); },
  scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext) {
    ctx.waitUntil(env.PROCESSOR.get(env.PROCESSOR.idFromName('media')).tick());
  },
} satisfies ExportedHandler<Env>;
