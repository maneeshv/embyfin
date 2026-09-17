import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.listeners={};this.currentTime=0;this.className='';}
  append(){} replaceChildren(){} setAttribute(){} removeAttribute(){} load(){} pause(){}
  addEventListener(name,fn){this.listeners[name]=fn;}
  querySelector(){return new Element('select');}
}
async function playback(){
  const events={},documentEvents={},buttons=[],requests=[];
  const context=vm.createContext({URLSearchParams,Intl,Date,Node:Element,AbortController,
    location:{hash:'#view=library'},window:{addEventListener:(name,fn)=>events[name]=fn,scrollTo(){}},
    document:{hidden:false,addEventListener:(name,fn)=>documentEvents[name]=fn,querySelector:()=>new Element('div')},
    fetch:(path,options)=>{requests.push({path,...options});return Promise.resolve({ok:true});},
  });
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(0,source.lastIndexOf('void boot();')),context);
  context.makeElement=tag=>new Element(tag);
  context.captureButton=(label,fn)=>{buttons.push({label,fn});return new Element('button');};
  vm.runInContext(`
    account={id:'viewer'};
    el=(tag,props)=>Object.assign(makeElement(tag),props);
    button=captureButton;poster=()=>makeElement('img');select=()=>makeElement('div');
    shell=()=>makeElement('main');library=async()=>{};
    api=async path=>path.endsWith('/session')?{generation:'session-1',position:0}:
      {id:'video-1',revision:'revision-1',duration:100,available:true,position:0,filename:'clip',bytes:1024};
  `,context);
  await vm.runInContext("videoPage(makeElement('main'),new URLSearchParams('id=video-1'))",context);
  await buttons.find(b=>b.label==='Play original').fn();
  vm.runInContext('player.currentTime=42.5',context);
  return {context,events,documentEvents,requests};
}

test('Leaving playback sends one authenticated keepalive save before teardown',async()=>{
  for(const exit of ['pagehide','hidden','navigation']){
    const {context,events,documentEvents,requests}=await playback();
    if(exit==='pagehide')events.pagehide();
    else if(exit==='hidden'){context.document.hidden=true;documentEvents.visibilitychange();events.pagehide();}
    else await vm.runInContext('render()',context);
    assert.equal(requests.length,1,exit);
    const request=requests[0];
    assert.equal(request.path,'/api/videos/video-1/progress');
    assert.equal(request.keepalive,true);assert.equal(request.signal,undefined);
    assert.equal(request.credentials,'same-origin');assert.equal(request.headers['X-Embyfin-User'],'viewer');
    assert.deepEqual(JSON.parse(request.body),{revision:'revision-1',generation:'session-1',sequence:1,position:42.5,ended:false});
  }
});

test('Account clearing does not send a final write; ended playback remains completed',async()=>{
  const first=await playback();
  vm.runInContext('clearPrivate()',first.context);
  assert.equal(first.requests.length,0);
  const second=await playback();
  vm.runInContext('player.ended=true',second.context);
  second.events.pagehide();
  assert.equal(JSON.parse(second.requests[0].body).ended,true);
});

test('Returning to a hidden tab keeps the page but hides it until the session is revalidated',async()=>{
  const {context,documentEvents,requests}=await playback();
  const calls=[];vm.runInContext('api=async path=>{calls.push(path);return {user:{id:"viewer"}};}',context);context.calls=calls;
  context.document.hidden=true;documentEvents.visibilitychange();
  assert.equal(requests.length,1);assert.equal(vm.runInContext('account?.id',context),'viewer');
  context.document.hidden=false;const pending=documentEvents.visibilitychange();
  assert.equal(vm.runInContext('root.className',context),'revalidating');
  await pending;await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls,['/api/session']);assert.equal(vm.runInContext('root.className',context),'');
  vm.runInContext('api=async()=>{throw Object.assign(new Error("gone"),{status:401});};boot=async()=>{calls.push("boot");};',context);
  documentEvents.visibilitychange();await new Promise(r=>setImmediate(r));
  assert.equal(calls.at(-1),'boot');assert.equal(vm.runInContext('account',context),null);
});
