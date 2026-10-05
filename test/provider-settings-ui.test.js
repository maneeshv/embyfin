import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.childNodes=[];this.listeners={};this.className='';this.disabled=false;this.required=false;this.maxLength=-1;this.value='';}
  append(...children){for(const child of children){this.childNodes.push(child);if(child instanceof Element)child.parent=this;}}
  replaceChildren(...children){this.childNodes=[];this.append(...children);}
  replaceWith(node){const list=this.parent.childNodes;list[list.indexOf(this)]=node;node.parent=this.parent;}
  setAttribute(key,value){this[key]=value;}removeAttribute(key){delete this[key];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  get classList(){return {add:name=>this.className+=' '+name};}
  set textContent(v){this.childNodes=[{text:String(v)}];}
  get text(){return this.childNodes.map(n=>n instanceof Element?n.text:n.text).join(' ');}
}
const all=node=>[node,...(node.childNodes||[]).flatMap(c=>c instanceof Element?all(c):[])];
const find=(root,fn)=>all(root).filter(n=>n instanceof Element&&fn(n));
const card=(main,label)=>find(main,n=>n.className==='provider-card'&&n.childNodes[0].text===label)[0];
const field=(c,i)=>find(c,n=>n.tag==='input')[i];
const btn=(c,label)=>find(c,n=>n.tag==='button'&&n.text===label)[0];
const message=c=>find(c,n=>n.className.startsWith('provider-message'))[0];

const off={configured:false,source:'none',status:'disconnected'};
const base=providers=>({source:{bucket:'b',configured:true},libraries:[],users:[],grants:[],scans:[],failures:[],backup:{},providers});
async function setup(providers,role='owner'){
  const calls=[],context=vm.createContext({Node:Element,URLSearchParams,Intl,Date,AbortController,navigator:{language:'en-US'},location:{hash:'#view=settings'},
    document:{querySelector:()=>new Element('div'),createElement:t=>new Element(t),createTextNode:text=>({text})},window:{scrollY:0,scrollTo(){}}});
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(0,source.indexOf('async function render(')),context);
  context.calls=calls;context.admin=base(providers);context.postHandler=async()=>({ok:true,providers});
  vm.runInContext(`account={id:'o',role:'${role}'};libraryList=[];
    api=async(path,data)=>{if(data===undefined)return admin;calls.push({path,data});if(path==='/api/admin/providers')return postHandler(data);return {};};`,context);
  const main=new Element('main');context.main=main;await vm.runInContext('settings(main)',context);
  return {context,main,calls};
}
const plain=v=>JSON.parse(JSON.stringify(v));
const tick=()=>new Promise(r=>setImmediate(r));
const submit=c=>c.parent.childNodes.length&&find(c,n=>n.tag==='form')[0].listeners.submit({preventDefault(){}});

test('initial setup requires every field and sends only typed credentials; secrets use password inputs',async()=>{
  const {main,calls,context}=await setup({editable:true,tmdb:off,opensubtitles:off});
  const os=card(main,'OpenSubtitles');
  assert.deepEqual(find(os,n=>n.tag==='input').map(n=>n.type),['password','text','password']);
  assert(find(os,n=>n.tag==='input').every(n=>n.value===''&&n.required===true));
  field(os,0).value='key';submit(os);await tick();
  assert.equal(calls.length,0);assert.match(message(os).text,/every field/);
  field(os,1).value='user';field(os,2).value='pw';
  context.postHandler=async()=>({ok:true,providers:{editable:true,tmdb:off,opensubtitles:{configured:true,source:'settings',status:'connected'}}});
  submit(os);await tick();
  assert.deepEqual(plain(calls[0]),{path:'/api/admin/providers',data:{provider:'opensubtitles',action:'save',credentials:{apiKey:'key',username:'user',password:'pw'}}});
});

test('successful save clears inputs and shows new status; failed save keeps inputs and prior status',async()=>{
  const {main,calls,context}=await setup({editable:true,tmdb:{configured:true,source:'settings',status:'configured'},opensubtitles:off});
  let c=card(main,'TMDB');field(c,0).value='bad-token';
  context.postHandler=async()=>{const e=new Error('tmdb_rejected');throw e;};
  submit(c);await tick();c=card(main,'TMDB');
  assert.equal(field(c,0).value,'bad-token');assert.match(c.text,/Configured, not yet tested/);assert.match(message(c).text,/tmdb rejected/);
  context.postHandler=async()=>({ok:true,providers:{editable:true,tmdb:{configured:true,source:'settings',status:'connected',lastChecked:1},opensubtitles:off}});
  submit(c);await tick();
  const fresh=card(main,'TMDB');
  assert.equal(field(fresh,0).value,'');assert.match(fresh.text,/Connected/);assert.match(message(fresh).text,/Saved/);
  assert.equal(calls.length,2);
});

test('editing saved credentials allows empty fields and sends only changed ones',async()=>{
  const {main,calls}=await setup({editable:true,tmdb:off,opensubtitles:{configured:true,source:'settings',status:'connected'}});
  const os=card(main,'OpenSubtitles');
  assert(find(os,n=>n.tag==='input').every(n=>n.required===false));assert.match(os.text,/keep its stored value/);
  field(os,1).value='new-user';submit(os);await tick();
  assert.deepEqual(plain(calls[0].data.credentials),{username:'new-user'});
});

test('in-flight mutation disables every action and drops duplicates',async()=>{
  const {main,calls,context}=await setup({editable:true,tmdb:{configured:true,source:'settings',status:'connected'},opensubtitles:{configured:true,source:'settings',status:'connected'}});
  let release;context.postHandler=data=>new Promise(r=>{release=()=>r({ok:true,providers:{editable:true,tmdb:{configured:true,source:'settings',status:'connected'},opensubtitles:{configured:true,source:'settings',status:'connected'}}});});
  const t=card(main,'TMDB'),buttons=find(main,n=>n.tag==='button'&&n.parent.className!=='nav'&&['Save and test connection','Test connection','Disconnect'].includes(n.text));
  assert.equal(buttons.length,6);
  btn(t,'Test connection').listeners.click();await tick();
  assert(buttons.every(b=>b.disabled===true),'save, test and disconnect all lock');
  btn(t,'Test connection').listeners.click();btn(t,'Disconnect').listeners.click();field(t,0).value='x';submit(t);await tick();
  assert.equal(calls.length,1);
  release();await tick();
  assert(find(main,n=>n.tag==='button'&&n.text==='Test connection').every(b=>b.disabled===false));
});

test('disconnect and test send no credentials; status reflects result',async()=>{
  const {main,calls,context}=await setup({editable:true,tmdb:{configured:true,source:'settings',status:'error',error:'tmdb_rejected'},opensubtitles:off});
  assert.match(card(main,'TMDB').text,/Connection problem \(tmdb rejected\)/);
  context.postHandler=async()=>({ok:true,providers:{editable:true,tmdb:off,opensubtitles:off}});
  btn(card(main,'TMDB'),'Disconnect').listeners.click();await tick();
  assert.deepEqual(plain(calls[0].data),{provider:'tmdb',action:'disconnect'});
  const c=card(main,'TMDB');assert.match(c.text,/Disconnected/);assert(find(c,n=>n.tag==='input').every(n=>n.required===true));
  assert.equal(btn(c,'Test connection').disabled,true);
});

test('deployment source can be turned off and nothing stored is rendered',async()=>{
  const {main,calls}=await setup({editable:true,tmdb:{configured:true,source:'deployment',status:'configured'},opensubtitles:{configured:false,source:'disabled',status:'disconnected'}});
  const t=card(main,'TMDB');assert.match(t.text,/deployment configuration/);
  assert(find(main,n=>n.tag==='input').every(n=>n.value===''));
  btn(t,'Turn off deployment configuration').listeners.click();await tick();
  assert.deepEqual(plain(calls[0].data),{provider:'tmdb',action:'disconnect'});
});

test('editable false disables everything and blocks programmatic events',async()=>{
  const {main,calls}=await setup({editable:false,tmdb:{configured:true,source:'settings',status:'connected'},opensubtitles:off});
  assert.match(find(main,n=>n.className==='muted provider-message')[0].text,/Saving and testing are unavailable.*can still be disconnected/);
  assert(!/cloudflare/i.test(find(main,n=>n.className==='providers')[0].text));
  const t=card(main,'TMDB');
  assert(find(t,n=>n.tag==='input'||n.tag==='button'&&n.text!=='Disconnect').every(n=>n.disabled===true));
  assert.equal(btn(t,'Disconnect').disabled,false,'configured provider can still be disconnected');
  field(t,0).value='x';submit(t);btn(t,'Test connection').listeners.click();await tick();
  assert.equal(calls.length,0);
});

test('unconfigured provider rejects programmatic test; non-owner gets no provider form',async()=>{
  const {main,calls}=await setup({editable:true,tmdb:off,opensubtitles:off});
  btn(card(main,'TMDB'),'Test connection').listeners.click();btn(card(main,'TMDB'),'Disconnect').listeners.click();await tick();
  assert.equal(calls.length,0);
  const viewer=await setup({editable:true,tmdb:off,opensubtitles:off},'viewer');
  assert.equal(find(viewer.main,n=>n.tag==='input').filter(n=>n.type==='password').length,0);
});

test('a mutation on one provider keeps the other provider\'s unsaved draft; test keeps its own draft; save and disconnect clear it',async()=>{
  const live={configured:true,source:'settings',status:'connected'};
  const {main,context}=await setup({editable:true,tmdb:live,opensubtitles:live});
  const t=()=>card(main,'TMDB'),o=()=>card(main,'OpenSubtitles');
  field(o(),1).value='draft-user';field(t(),0).value='draft-token';
  context.postHandler=async()=>({ok:true,providers:{editable:true,tmdb:live,opensubtitles:live}});
  btn(t(),'Test connection').listeners.click();await tick();
  assert.equal(field(o(),1).value,'draft-user','sibling draft survives test');
  assert.equal(field(t(),0).value,'draft-token','own draft survives test');
  submit(t());await tick();
  assert.equal(field(o(),1).value,'draft-user','sibling draft survives save');
  assert.equal(field(t(),0).value,'','own draft cleared by save');
  field(t(),0).value='again';
  context.postHandler=async()=>({ok:true,providers:{editable:true,tmdb:off,opensubtitles:live}});
  btn(t(),'Disconnect').listeners.click();await tick();
  assert.equal(field(t(),0).value,'','own draft cleared by disconnect');
  assert.equal(field(o(),1).value,'draft-user','sibling draft survives disconnect');
});

test('ready section never renders a literal null and inflight also locks inputs',async()=>{
  const live={configured:true,source:'settings',status:'connected'};
  const {main,context}=await setup({editable:true,tmdb:live,opensubtitles:off});
  const section=find(main,n=>n.className==='providers')[0];
  assert(!/\bnull\b|undefined/.test(section.text));
  let release;context.postHandler=()=>new Promise(r=>{release=()=>r({ok:true,providers:{editable:true,tmdb:live,opensubtitles:off}});});
  btn(card(main,'TMDB'),'Test connection').listeners.click();await tick();
  assert(find(section,n=>n.tag==='input').every(n=>n.disabled===true));
  release();await tick();
  assert(find(section,n=>n.tag==='input').every(n=>n.disabled===false));
});

test('unreadable saved record (missing encryption key) permits disconnect but blocks save and test',async()=>{
  const broken={configured:false,source:'settings',status:'error',error:'encryption_key_missing'};
  const {main,calls,context}=await setup({editable:false,tmdb:broken,opensubtitles:{configured:false,source:'disabled',status:'disconnected'}});
  const t=card(main,'TMDB');
  assert.equal(btn(t,'Disconnect').disabled,false);
  assert.equal(btn(t,'Test connection').disabled,true);assert.equal(btn(t,'Save and test connection').disabled,true);
  assert.equal(btn(card(main,'OpenSubtitles'),'Disconnect').disabled,true,'source disabled without config stays locked');
  field(t,0).value='x';submit(t);btn(t,'Test connection').listeners.click();await tick();
  assert.equal(calls.length,0);
  context.postHandler=async()=>({ok:true,providers:{editable:false,tmdb:off,opensubtitles:off}});
  btn(t,'Disconnect').listeners.click();await tick();
  assert.deepEqual(plain(calls[0].data),{provider:'tmdb',action:'disconnect'});
  assert.equal(btn(card(main,'TMDB'),'Disconnect').disabled,true);
});

test('successful provider mutations update the global feature flags immediately',async()=>{
  const live={configured:true,source:'settings',status:'connected'};
  const {main,context}=await setup({editable:true,tmdb:off,opensubtitles:off});
  const flags=()=>JSON.parse(vm.runInContext('JSON.stringify(features)',context));
  vm.runInContext('features={metadata:false,subtitles:false}',context);
  let providers={editable:true,tmdb:live,opensubtitles:off};context.postHandler=async()=>({ok:true,providers});
  field(card(main,'TMDB'),0).value='token';submit(card(main,'TMDB'));await tick();
  assert.deepEqual(flags(),{metadata:true,subtitles:false});
  providers={editable:true,tmdb:live,opensubtitles:live};
  const os=card(main,'OpenSubtitles');field(os,0).value='k';field(os,1).value='u';field(os,2).value='p';submit(os);await tick();
  assert.equal(flags().subtitles,true);
  providers={editable:true,tmdb:off,opensubtitles:live};
  btn(card(main,'TMDB'),'Disconnect').listeners.click();await tick();
  assert.deepEqual(flags(),{metadata:false,subtitles:true});
});

test('failed mutations leave feature flags alone; unconfigured match copy links owners to Settings',async()=>{
  const {main,context}=await setup({editable:true,tmdb:off,opensubtitles:off});
  vm.runInContext('features={metadata:true}',context);
  context.postHandler=async()=>{throw new Error('boom');};
  field(card(main,'TMDB'),0).value='t';submit(card(main,'TMDB'));await tick();
  assert.equal(vm.runInContext('features.metadata',context),true);
  const copy=role=>{vm.runInContext(`account={id:'a',role:'${role}'}`,context);const node=vm.runInContext("providerNeeded('TMDB movie matching')",context);
    return typeof node==='string'?[node,[]]:[node.text,find(node,n=>n.tag==='a').map(a=>a.href)];};
  const [owner,links]=copy('owner'),[viewer,viewerLinks]=copy('viewer');
  assert.match(owner,/needs a TMDB token/);assert.deepEqual(links,['#view=settings']);
  assert.match(viewer,/unavailable/);assert.equal(viewerLinks.length,0);
  const [ownerEpisode,viewerEpisode]=[owner,viewer];
  assert(!/deployment/i.test(owner+ownerEpisode+viewer+viewerEpisode));
});

test('error status wins over unconfigured and inputs carry the credential length limits',async()=>{
  const {main}=await setup({editable:true,tmdb:{configured:false,source:'settings',status:'error',error:'encryption_key_missing'},opensubtitles:off});
  assert.match(card(main,'TMDB').text,/Connection problem \(encryption key missing\)/);
  assert.deepEqual(find(card(main,'TMDB'),n=>n.tag==='input').map(n=>n.maxLength),[4096]);
  assert.deepEqual(find(card(main,'OpenSubtitles'),n=>n.tag==='input').map(n=>n.maxLength),[1024,254,1024]);
});
