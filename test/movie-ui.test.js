import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.childNodes=[];this.listeners={};this.className='';this.textTracks=[];this.currentTime=0;this.paused=true;}
  append(...children){for(const child of children){this.childNodes.push(child);if(child instanceof Element)child.parent=this;if(this.tag==='video'&&child.tag==='track')this.textTracks.push({id:String(child.id),mode:'disabled'});}}
  replaceChildren(...children){this.childNodes=[];this.textTracks=[];this.append(...children);}
  setAttribute(key,value){this[key]=value;}removeAttribute(key){delete this[key];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  querySelector(tag){return descendants(this).find(node=>node!==this&&node.tag===tag)||null;}
  querySelectorAll(tag){return descendants(this).filter(node=>node!==this&&node.tag===tag);}
  remove(){if(this.parent){this.parent.childNodes=this.parent.childNodes.filter(node=>node!==this);if(this.parent.tag==='video')this.parent.textTracks=this.parent.textTracks.filter(track=>track.id!==String(this.id));}}
  pause(){this.paused=true;}load(){}play(){this.paused=false;return Promise.resolve();}
  get classList(){return {add:name=>this.className+=' '+name};}
}
function descendants(node){return [node,...(node.childNodes||[]).flatMap(child=>child instanceof Element?descendants(child):[])];}
function setup(hash='#view=movies'){
  const buttons=[],calls=[],context=vm.createContext({Node:Element,URLSearchParams,Intl,Date,AbortController,navigator:{language:'en-US'},
    location:{hash},document:{querySelector:()=>new Element('div'),createElement:tag=>new Element(tag),createTextNode:text=>({text})},
    window:{scrollY:0,scrollTo(){}}});
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(0,source.indexOf('function table(')),context);
  context.buttons=buttons;context.calls=calls;context.makeElement=tag=>new Element(tag);
  vm.runInContext(`account={id:'viewer',role:'viewer'};libraryList=[{id:'movies',name:'Movies',kind:'movies'}];
    button=(label,fn)=>{buttons.push({label,fn});const b=makeElement('button');b.label=label;return b;};`,context);
  return context;
}

test('Movies route requests only movie catalog items and uses portrait cards',async()=>{
  const context=setup();
  vm.runInContext(`api=async path=>{calls.push(path);return {items:[{id:'v1',filename:'Raw.mkv',library_kind:'movies',library_name:'Movies',movie:{title:'The Story',year:'2020',poster:'/api/poster'}}],total:1,offset:0,limit:24};};`,context);
  context.main=new Element('main');
  await vm.runInContext("library(main,new URLSearchParams('view=movies'))",context);
  assert.match(context.calls[0],/type=movies/);
  const card=descendants(context.main).find(node=>node.tag==='a'&&node.className.includes('movie-card'));
  assert(card);assert.match(card.href,/#view=video&id=v1&from=movies/);
  assert.equal(card.childNodes[0].className,'poster loading movie-poster');
});

test('Cast links open an authorized person page and return to that person',async()=>{
  const context=setup('#view=person&id=42');
  vm.runInContext(`api=async path=>{calls.push(path);return {person:{id:42,name:'A. Actor',profile:null},items:[{id:'v1',filename:'Film.mkv',library_kind:'movies',library_name:'Movies',movie:{title:'Film',year:'2021'}}],total:1,offset:0,limit:24};};`,context);
  context.main=new Element('main');await vm.runInContext("personPage(main,new URLSearchParams('view=person&id=42'))",context);
  assert.match(context.calls[0],/^\/api\/people\/42\?/);
  const card=descendants(context.main).find(node=>node.tag==='a'&&node.className.includes('movie-card'));
  assert.match(card.href,/from=person&fromId=42/);
  const panel=vm.runInContext("castPanel({cast:[{id:42,name:'A. Actor',character:'Lead'}]})",context);
  assert.equal(descendants(panel).find(node=>node.className==='cast-card').href,'#view=person&id=42');
});

test('Imported subtitles load without provider setup and can be switched off in place',async()=>{
  const context=setup('#view=video&id=v1');
  vm.runInContext(`api=async (path,data)=>{calls.push(path);if(path.endsWith('/movie'))return {match:{state:'matched'},movie:{title:'Film',overview:'A story.'},cast:[]};
    if(path.endsWith('/subtitles'))return {configured:false,items:[{id:'en1',language:'en',label:'English',url:'/api/videos/v1/subtitles/en1.vtt'}]};
    if(path.endsWith('/session'))return {generation:'s1',position:0};
    return {id:'v1',revision:'revision1',filename:'Film.mkv',library_kind:'movies',library_name:'Movies',path:'Film.mkv',available:true,bytes:1024,duration:100,position:0};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=v1'))",context);
  const hero=descendants(context.main).find(node=>node.className==='movie-hero');
  assert(descendants(hero).some(node=>node.label==='Play original'));
  assert(descendants(context.main).find(node=>node.className==='detail-media').hidden);
  await context.buttons.find(item=>item.label==='Play original').fn();
  const video=vm.runInContext('player',context);
  assert.equal(video.querySelectorAll('track').length,1);
  assert.equal(video.querySelector('track').src,'/api/videos/v1/subtitles/en1.vtt');
  assert.equal(video.textTracks[0].mode,'showing');
  const subtitleSelect=descendants(context.main).find(node=>node.tag==='select'&&node.name==='subtitles');
  assert.deepEqual(subtitleSelect.childNodes.map(node=>node.value),['','en1']);
  subtitleSelect.listeners.change({target:{value:''}});
  assert.equal(video.textTracks[0].mode,'disabled');
  assert.equal(vm.runInContext('player',context),video);
});

test('An old detail response cannot replace the active playback cleanup',async()=>{
  const context=setup('#view=video&id=v1');
  let resolveMovie,resolveSubtitles;
  context.moviePending=new Promise(resolve=>resolveMovie=resolve);
  context.subtitlePending=new Promise(resolve=>resolveSubtitles=resolve);
  vm.runInContext(`api=async path=>path.endsWith('/movie')?moviePending:path.endsWith('/subtitles')?subtitlePending:
    {id:'v1',revision:'r1',filename:'Film.mkv',library_kind:'movies',library_name:'Movies',path:'Film.mkv',available:true,bytes:1024};`,context);
  context.main=new Element('main');
  const oldPage=vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=v1'))",context);
  await Promise.resolve();
  vm.runInContext("epoch++;flush=()=>calls.push('active flush');",context);
  resolveMovie({movie:null,match:{state:'pending'},cast:[]});resolveSubtitles({items:[],configured:false});
  await oldPage;
  vm.runInContext('flush()',context);
  assert.deepEqual(context.calls,['active flush']);
  assert.equal(descendants(context.main).some(node=>node.className==='movie-panel'),false);
});

test('A matched movie keeps its play action when the details request fails',async()=>{
  const context=setup('#view=video&id=v1');
  vm.runInContext(`api=async path=>{if(path.endsWith('/movie'))throw new Error('Details unavailable');
    if(path.endsWith('/subtitles'))return {items:[],configured:false};
    if(path.endsWith('/session'))return {generation:'s1',position:0};
    return {id:'v1',revision:'r1',filename:'Film.mkv',library_kind:'videos',library_name:'Mixed',path:'Film.mkv',available:true,bytes:1024,movie:{title:'Film',year:'2020'}};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=v1'))",context);
  assert(descendants(context.main).some(node=>node.label==='Play original'));
  await context.buttons.find(item=>item.label==='Play original').fn();
  assert.equal(vm.runInContext('player',context).src,'/api/videos/v1/media?r=r1');
  assert.equal(descendants(context.main).find(node=>node.className==='detail-media').hidden,false);
});

test('Video back link retains the previous folder and search route',async()=>{
  const context=setup('#view=video&id=v1&from=folders&library=movies&folder=films%2F&q=story&offset=24');
  vm.runInContext(`api=async path=>path.endsWith('/subtitles')?{items:[],configured:false}:
    {id:'v1',revision:'r1',filename:'Film.mkv',library_name:'Movies',path:'films/Film.mkv',available:true,bytes:1024};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams(location.hash.slice(1)))",context);
  assert.equal(descendants(context.main).find(node=>node.tag==='a').href,'#view=folders&library=movies&folder=films%2F&q=story&offset=24');
});
