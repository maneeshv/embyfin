import {createHash} from 'node:crypto';
import {fail,now,Problem,string} from '#src/core.js';
import {tmdb} from '#src/tmdb.js';
import {subtitleProvider,subtitleStatus} from '#src/subtitle-auth.js';

const names=['tmdb','opensubtitles'];
const fields={tmdb:{token:['TMDB_READ_TOKEN',4096]},opensubtitles:{apiKey:['OPENSUBTITLES_API_KEY',1024],username:['OPENSUBTITLES_USERNAME',254],password:['OPENSUBTITLES_PASSWORD',1024]}};
const encoder=new TextEncoder();
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const safeError=error=>({error:error instanceof Problem?error.code:'provider_settings_unavailable',status:error instanceof Problem?error.status:503});
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const controller=env=>env.PROCESSOR?.get(env.PROCESSOR.idFromName('media'));

async function encryptionKey(env) {
  try {
    const value=env.PROVIDER_ENCRYPTION_KEY;
    if(typeof value!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))throw Error();
    const bytes=decode(value);if(bytes.length!==32 || encode(bytes)!==value)throw Error();
    return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
  } catch {fail(503,'provider_encryption_unavailable');}
}
export async function sealProvider(env,purpose,value) {
  const key=await encryptionKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`embyfin:${purpose}:v1`)},key,encoder.encode(JSON.stringify(value)));
  return {version:1,iv:encode(iv),ciphertext:encode(ciphertext)};
}
export async function openProvider(env,purpose,value) {
  const key=await encryptionKey(env);
  try {
    if(value?.version!==1 || typeof value.iv!=='string' || value.iv.length!==16 || typeof value.ciphertext!=='string' || value.ciphertext.length>32768)throw Error();
    const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(value.iv),additionalData:encoder.encode(`embyfin:${purpose}:v1`)},key,decode(value.ciphertext));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch {fail(503,'provider_settings_unreadable');}
}
function deployment(env,name) {
  const credentials=Object.fromEntries(Object.entries(fields[name]).map(([field,[key]])=>[field,env[key] || '']));
  if(name==='opensubtitles')credentials.legacyToken=env.OPENSUBTITLES_TOKEN || '';
  return credentials;
}
function apply(env,name,credentials) {
  const next={...env};
  for(const [field,[key]] of Object.entries(fields[name]))next[key]=credentials?.[field] || '';
  if(name==='opensubtitles')next.OPENSUBTITLES_TOKEN=credentials?.legacyToken || '';
  return next;
}
function configured(env,name) {return name==='tmdb'?!!env.TMDB_READ_TOKEN:subtitleStatus(env).configured;}
function credentials(name,input,previous={}) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!Object.hasOwn(fields[name],key)))fail(400,'invalid_provider_credentials');
  const result={};
  for(const [field,[,max]] of Object.entries(fields[name])) {
    const value=input[field]===undefined?'':string(input[field],max,true);
    result[field]=value || previous[field] || '';
    if(!result[field])fail(400,'provider_credentials_required');
  }
  return result;
}

export class ProviderSettings {
  constructor(env,storage,subtitles) {this.env=env;this.storage=storage;this.subtitles=subtitles;this.pending=Promise.resolve();}
  async configuration() {
    let editable=true;
    try {await encryptionKey(this.env);}catch {editable=false;}
    let effective={...this.env};const providers={editable};
    for(const name of names) {
      let record;
      try {
        record=await this.storage.get(`provider:${name}`);
        if(record?.disabled===true) {effective=apply(effective,name,null);providers[name]={configured:false,source:'disabled',status:'disconnected'};continue;}
        if(record!==undefined) {
          const saved=await openProvider(this.env,name,record);
          const value=credentials(name,saved.credentials);
          effective=apply(effective,name,value);
          providers[name]={configured:true,source:'settings',status:saved.status==='error'?'error':'connected',lastChecked:saved.lastChecked,...(saved.error?{error:saved.error}:{})};
        } else {
          providers[name]={configured:configured(effective,name),source:Object.values(deployment(effective,name)).some(Boolean)?'deployment':'none',status:configured(effective,name)?'configured':'disconnected'};
          const checked=await this.storage.get(`provider-check:${name}`);
          if(checked?.fingerprint===fingerprint(deployment(effective,name)))providers[name]={...providers[name],status:checked.status,lastChecked:checked.lastChecked,...(checked.error?{error:checked.error}:{})};
        }
      } catch(error) {
        effective=apply(effective,name,null);
        providers[name]={configured:false,source:'settings',status:'error',error:safeError(error).error};
      }
    }
    const values={};
    for(const name of names)for(const [, [key]] of Object.entries(fields[name]))values[key]=effective[key] || '';
    values.OPENSUBTITLES_TOKEN=effective.OPENSUBTITLES_TOKEN || '';
    return {credentials:values,providers};
  }
  update(data) {
    const task=this.pending.then(()=>this.change(data));this.pending=task.catch(()=>{});
    return task.catch(safeError);
  }
  async change(data) {
    const name=string(data?.provider,30),action=string(data?.action,30);
    if(!names.includes(name) || !['save','test','disconnect'].includes(action))fail(400,'invalid_provider_action');
    if(action==='disconnect') {
      await this.storage.put(`provider:${name}`,{disabled:true});
      if(name==='opensubtitles')await this.subtitles.clear();
    } else {
      if(action==='save')await encryptionKey(this.env);
      const current=await this.configuration();
      const env={...this.env,...current.credentials};
      let candidate;
      if(action==='save') {
        candidate=credentials(name,data.credentials || {},deployment(env,name));
        if(name==='opensubtitles' && !current.providers[name].configured && current.providers[name].error)await this.subtitles.clear();
      } else {
        if(data.credentials && Object.values(data.credentials).some(value=>value!==''))fail(400,'save_provider_credentials_first');
        if(!current.providers[name].configured && current.providers[name].error)fail(503,current.providers[name].error);
        if(!configured(env,name))fail(400,'provider_credentials_required');
        candidate=deployment(env,name);
      }
      const testEnv=apply(env,name,candidate);let candidateSession;
      const recordCheck=async error=>{
        const checked={status:error?'error':'connected',lastChecked:now(),...(error?{error:safeError(error).error}:{})};
        if(action==='save' || current.providers[name].source==='settings') {
          const saved=Object.fromEntries(Object.keys(fields[name]).map(field=>[field,candidate[field]]));
          const record=await sealProvider(this.env,name,{credentials:saved,...checked});
          if(name==='opensubtitles' && action==='save')await this.subtitles.commit(testEnv,candidateSession,record);
          else await this.storage.put(`provider:${name}`,record);
        } else await this.storage.put(`provider-check:${name}`,{fingerprint:fingerprint(candidate),...checked});
      };
      try {
        if(name==='tmdb') {
          const result=await tmdb(testEnv,'/authentication');
          if(result.success!==true)fail(502,'provider_connection_failed');
        } else {
          // Reuse the session queue and durable attempt history even for candidate credentials.
          testEnv.PROCESSOR={idFromName:()=> 'media',get:()=>({subtitleSession:async(rejected,settings)=>{const session=await this.subtitles.get(rejected,settings,action!=='save');if(!session.error)candidateSession=session;return session;}})};
          const result=await subtitleProvider(testEnv,'/infos/user');
          if(!result.data || !Number.isSafeInteger(result.data.user_id))fail(502,'provider_connection_failed');
        }
      } catch(error) {if(action==='test')await recordCheck(error);throw error;}
      await recordCheck();
    }
    return {ok:true,providers:(await this.configuration()).providers};
  }
}

export async function providerConfiguration(env) {
  const remote=controller(env);
  if(!remote) return new ProviderSettings(env,{get:async()=>undefined},null).configuration();
  try {return await remote.providerConfiguration();}
  catch {
    const error={configured:false,source:'settings',status:'error',error:'provider_settings_unavailable'};
    return {credentials:{TMDB_READ_TOKEN:'',OPENSUBTITLES_API_KEY:'',OPENSUBTITLES_USERNAME:'',OPENSUBTITLES_PASSWORD:'',OPENSUBTITLES_TOKEN:''},providers:{editable:false,tmdb:error,opensubtitles:error}};
  }
}
export async function providerEnvironment(env) {return {...env,...(await providerConfiguration(env)).credentials};}
export async function updateProvider(env,data) {
  const remote=controller(env);if(!remote)fail(503,'provider_settings_unavailable');
  let result;
  try {result=await remote.updateProvider(data);}catch {fail(503,'provider_settings_unavailable');}
  if(result.error)fail(result.status,result.error);
  return result;
}
