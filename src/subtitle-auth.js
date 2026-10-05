import {createHash} from 'node:crypto';
import {decodeJwt} from 'jose';
import {fail, now, Problem} from '#src/core.js';
import {sealProvider,openProvider} from '#src/providers.js';

const api='https://api.opensubtitles.com/api/v1';
const credentialFingerprint=env=>createHash('sha256').update(JSON.stringify([env.OPENSUBTITLES_API_KEY,env.OPENSUBTITLES_USERNAME,env.OPENSUBTITLES_PASSWORD,env.OPENSUBTITLES_USER_AGENT])).digest('hex');
const automatic=env=>!!(env.OPENSUBTITLES_USERNAME || env.OPENSUBTITLES_PASSWORD);
export const subtitleStatus=env=>({available:!!env.OPENSUBTITLES_API_KEY,configured:!!(env.OPENSUBTITLES_API_KEY && (automatic(env)?env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD:env.OPENSUBTITLES_TOKEN))});
const headers=env=>({'Api-Key':env.OPENSUBTITLES_API_KEY,'User-Agent':env.OPENSUBTITLES_USER_AGENT || 'Embyfin v0.1.0','Accept':'application/json'});

export async function limited(response,max) {
  if(response.status<200 || response.status>=300) {
    await response.body?.cancel();
    fail(response.status===429?429:502,response.status===429?'subtitle_rate_limited':'subtitle_provider_error');
  }
  const length=Number(response.headers.get('Content-Length'));
  if(Number.isFinite(length) && length>max) {await response.body?.cancel();fail(413,'invalid_subtitle');}
  const reader=response.body?.getReader(); if(!reader) fail(502,'subtitle_provider_error');
  const parts=[]; let size=0;
  for(;;) {
    const {done,value}=await reader.read(); if(done)break;
    size+=value.length; if(size>max){await reader.cancel();fail(413,'invalid_subtitle');}
    parts.push(value);
  }
  try {return new TextDecoder('utf-8',{fatal:true}).decode(await new Blob(parts).arrayBuffer());}
  catch {fail(422,'invalid_subtitle');}
}

async function jsonResponse(response,max=512*1024) {
  try {
    const data=JSON.parse(await limited(response,max));
    if(!data || typeof data!=='object' || Array.isArray(data))fail(502,'subtitle_provider_error');
    return data;
  } catch(error) {if(error instanceof Problem)throw error;fail(502,'subtitle_provider_error');}
}

// The existing singleton owns the cache and login queue; neither depends on the processor queue.
export class SubtitleSession {
  constructor(env,storage) {this.env=env;this.storage=storage;this.pending=Promise.resolve();}
  get(rejectedToken='',credentials,cache=true) {
    const task=this.pending.then(()=>this.load(rejectedToken,credentials,cache));
    this.pending=task.catch(()=>{});
    // RPC errors lose custom properties. Return only a stable error code, never upstream bodies or credentials.
    return task.catch(error=>({error:error instanceof Problem?error.code:'subtitle_provider_error',status:error instanceof Problem?error.status:502}));
  }
  clear() {
    const task=this.pending.then(async()=>{const state=await this.storage.get('subtitleSession');if(state){state.session=null;await this.storage.put('subtitleSession',state);}});
    this.pending=task.catch(()=>{});return task;
  }
  commit(credentials,session,record) {
    const task=this.pending.then(async()=>{
      const env={...this.env,...credentials},state=await this.storage.get('subtitleSession') || {attempts:[]};
      state.cachedFingerprint=credentialFingerprint(env);
      state.session=await sealProvider(env,'subtitle-session',{...session,expiresAt:decodeJwt(session.token).exp-60});
      // Publish verified credentials and their session together; failed candidates never replace the active cache.
      await this.storage.put({'subtitleSession':state,'provider:opensubtitles':record});
    });
    this.pending=task.catch(()=>{});return task;
  }
  async load(rejectedToken,credentials,cache) {
    const env={...this.env,...credentials};
    if(!automatic(env) || !subtitleStatus(env).configured)fail(503,'subtitles_unconfigured');
    const fingerprint=credentialFingerprint(env);
    const stored=await this.storage.get('subtitleSession');
    const state={...stored,fingerprint,attempts:stored?.attempts || [],cachedFingerprint:stored?.cachedFingerprint ?? stored?.fingerprint,
      failure:stored?.fingerprint===fingerprint || stored?.failure?.code==='subtitle_rate_limited'?stored?.failure:null};
    const time=now(),matching=state.cachedFingerprint===fingerprint;
    let session=matching?state.session:null;
    if(session?.version===1)session=await openProvider(env,'subtitle-session',session);
    if(session && session.expiresAt>time && session.token!==rejectedToken) {
      if(env.PROVIDER_ENCRYPTION_KEY && !state.session.version){state.session=await sealProvider(env,'subtitle-session',session);await this.storage.put('subtitleSession',state);}
      return {token:session.token,baseUrl:session.baseUrl};
    }
    if(matching)state.session=null;
    if(state.failure && (!state.failure.until || state.failure.until>time))fail(state.failure.status,state.failure.code);
    state.attempts=state.attempts.filter(at=>at>time-3600);
    const minute=state.attempts.filter(at=>at>time-60);
    // Two whole seconds conservatively enforce the provider's one-login-per-second limit.
    const retryAt=Math.max((state.attempts.at(-1) || 0)+2,minute.length>=10?minute[0]+60:0,state.attempts.length>=30?state.attempts[0]+3600:0);
    if(retryAt>time){await this.storage.put('subtitleSession',state);fail(429,'subtitle_rate_limited');}
    state.attempts.push(time);state.failure=null;
    // Record attempts before I/O so a restart cannot bypass the provider's minute/hour limits.
    await this.storage.put('subtitleSession',state);
    let retryUntil=now()+60;
    try {
      const response=await fetch(`${api}/login`,{method:'POST',headers:{...headers(env),'Content-Type':'application/json'},body:JSON.stringify({username:env.OPENSUBTITLES_USERNAME,password:env.OPENSUBTITLES_PASSWORD}),redirect:'manual',signal:AbortSignal.timeout(10000)});
      if([401,403].includes(response.status)){await response.body?.cancel();fail(502,'subtitle_login_failed');}
      if(response.status===429) {
        const value=response.headers.get('Retry-After') || '';
        const seconds=/^\d+$/.test(value)?Number(value):Math.ceil(Date.parse(value)/1000)-now();
        if(Number.isFinite(seconds))retryUntil=now()+Math.min(86400,Math.max(60,seconds));
      }
      const data=await jsonResponse(response,32*1024);
      if(typeof data.token!=='string' || data.token.length>8192 || !['api.opensubtitles.com','vip-api.opensubtitles.com'].includes(data.base_url))fail(502,'subtitle_provider_error');
      // The token comes directly from the fixed HTTPS login endpoint; exp only schedules renewal, not app authorization.
      const {exp}=decodeJwt(data.token);
      if(!Number.isSafeInteger(exp) || exp<=now()+60)fail(502,'subtitle_provider_error');
      const session={token:data.token,baseUrl:`https://${data.base_url}/api/v1`,expiresAt:exp-60};
      if(cache){state.session=env.PROVIDER_ENCRYPTION_KEY?await sealProvider(env,'subtitle-session',session):session;state.cachedFingerprint=fingerprint;}
      await this.storage.put('subtitleSession',state);
      return {token:session.token,baseUrl:session.baseUrl};
    } catch(error) {
      const code=error instanceof Problem && ['subtitle_login_failed','subtitle_rate_limited'].includes(error.code)?error.code:'subtitle_provider_error';
      state.failure={code,status:code==='subtitle_rate_limited'?429:502,until:code==='subtitle_login_failed'?0:retryUntil};
      await this.storage.put('subtitleSession',state);
      fail(state.failure.status,code);
    }
  }
}

export async function subtitleProvider(env,path,options={}) {
  if(!env.OPENSUBTITLES_API_KEY || (automatic(env) && !subtitleStatus(env).configured))fail(503,'subtitles_unconfigured');
  const controller=automatic(env)?env.PROCESSOR?.get(env.PROCESSOR.idFromName('media')):null;
  const getSession=async rejected=>{
    if(!automatic(env))return {token:env.OPENSUBTITLES_TOKEN,baseUrl:api};
    if(!controller)fail(503,'subtitles_unconfigured');
    let value;
    try {value=await controller.subtitleSession(rejected,{OPENSUBTITLES_API_KEY:env.OPENSUBTITLES_API_KEY,OPENSUBTITLES_USERNAME:env.OPENSUBTITLES_USERNAME,OPENSUBTITLES_PASSWORD:env.OPENSUBTITLES_PASSWORD});}catch {fail(502,'subtitle_provider_error');}
    if(value.error)fail(value.status,value.error);
    return value;
  };
  let session=await getSession('');
  for(let attempt=0;attempt<2;attempt++) {
    let response;
    try {response=await fetch(session.baseUrl+path,{...options,headers:{...headers(env),...options.headers,...(session.token?{Authorization:`Bearer ${session.token}`}:{})},redirect:'manual',signal:AbortSignal.timeout(10000)});}
    catch {fail(502,'subtitle_provider_error');}
    // Only an explicit rejection permits retrying a quota-consuming download request.
    if(response.status===401 && automatic(env) && attempt===0) {
      await response.body?.cancel();session=await getSession(session.token);continue;
    }
    return jsonResponse(response);
  }
}
