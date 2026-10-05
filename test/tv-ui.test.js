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
function textOf(node){return (node.childNodes||[]).map(child=>child instanceof Element?textOf(child):child?.text||String(child)).join('');}
function setup(hash='#view=tv',role='viewer'){
  const buttons=[],calls=[],context=vm.createContext({Node:Element,URLSearchParams,Intl,Date,AbortController,navigator:{language:'en-US'},
    location:{hash},document:{querySelector:()=>new Element('div'),createElement:tag=>new Element(tag),createTextNode:text=>({text})},
    window:{scrollY:0,scrollTo(){}}});
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(0,source.indexOf('function table(')),context);
  context.buttons=buttons;context.calls=calls;context.makeElement=tag=>new Element(tag);
  vm.runInContext(`account={id:'viewer',role:'${role}'};libraryList=[{id:'tv',name:'Shows',kind:'tv'}];
    button=(label,fn)=>{buttons.push({label,fn});const b=makeElement('button');b.label=label;return b;};`,context);
  return context;
}

test('TV page groups episodes into show cards and links to unmatched files',async()=>{
  const context=setup();
  vm.runInContext(`api=async path=>{calls.push(path);return {items:[{id:12,name:'North Star',year:2022,poster:'/poster',episodeCount:7,seasonCount:2}],total:1,offset:0,limit:24};};`,context);
  context.main=new Element('main');await vm.runInContext("tvPage(main,new URLSearchParams('view=tv'))",context);
  assert.match(context.calls[0],/^\/api\/shows\?/);
  assert(descendants(context.main).some(node=>node.tag==='a'&&node.href==='#view=show&id=12'));
  assert(descendants(context.main).some(node=>node.tag==='a'&&node.href.includes('section=unmatched')));
  assert(descendants(context.main).some(node=>node.tag==='h3'&&textOf(node)==='North Star'));
});

test('Show page filters a season and lists episodes in catalog order',async()=>{
  const context=setup('#view=show&id=12&season=2');
  vm.runInContext(`api=async path=>{calls.push(path);return {show:{id:12,name:'North Star',year:2022,overview:'Story'},cast:[{id:99,name:'An Actor',character:'Lead'}],seasons:[{number:0,episodeCount:1},{number:1,episodeCount:4},{number:2,episodeCount:2}],items:[{id:'e2',filename:'02.mkv',library_kind:'tv',library_name:'Shows',episode:{showId:12,showName:'North Star',seasonNumber:2,episodeNumber:2,title:'Ending'}},{id:'e1',filename:'01.mkv',library_kind:'tv',library_name:'Shows',episode:{showId:12,showName:'North Star',seasonNumber:2,episodeNumber:1,title:'Beginning'}}],total:2,offset:0,limit:24};};`,context);
  context.main=new Element('main');await vm.runInContext("showPage(main,new URLSearchParams('view=show&id=12&season=2'))",context);
  assert.match(context.calls[0],/^\/api\/shows\/12\?.*season=2/);
  const links=descendants(context.main).filter(node=>node.tag==='a'&&node.href?.includes('view=video'));
  assert.equal(links.length,2);
  assert.match(links[0].href,/id=e1/);assert.match(links[1].href,/id=e2/);
  assert(descendants(context.main).some(node=>node.tag==='a'&&node.href?.includes('season=0')&&textOf(node)==='Specials'));
  const seasonIndex=context.main.childNodes.findIndex(node=>node.className==='season-nav'),castIndex=context.main.childNodes.findIndex(node=>node.className==='cast-section');
  assert(seasonIndex>=0&&castIndex>seasonIndex);
});

test('Episode keeps playback available when metadata request fails',async()=>{
  const context=setup('#view=video&id=e1&from=show&fromId=12&season=1');
  vm.runInContext(`api=async path=>{calls.push(path);if(path.endsWith('/episode'))throw new Error('Provider unavailable');
    if(path.endsWith('/subtitles'))return {items:[],configured:false};if(path.endsWith('/session'))return {generation:'s1',position:0};
    return {id:'e1',revision:'r1',filename:'North.Star.S01E01.mkv',library_kind:'tv',library_name:'Shows',path:'North.Star.S01E01.mkv',available:true,bytes:1024,episode:{id:88,showId:12,showName:'North Star',seasonNumber:1,episodeNumber:1,title:'Pilot'}};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams(location.hash.slice(1)))",context);
  assert(descendants(context.main).some(node=>node.tag==='h1'&&textOf(node)==='Pilot'));
  assert(descendants(context.main).some(node=>node.tag==='a'&&node.href?.includes('view=show&id=12')));
  assert(descendants(context.main).some(node=>node.label==='Play original'));
  await context.buttons.find(item=>item.label==='Play original').fn();
  assert.equal(vm.runInContext('player',context).src,'/api/videos/e1/media?r=r1');
});

test('Episode details show authorized next link and native subtitle search title',async()=>{
  const context=setup('#view=video&id=e1&from=show&fromId=12&season=1');
  vm.runInContext(`api=async path=>{calls.push(path);if(path.endsWith('/episode'))return {match:{state:'matched'},show:{id:12,name:'North Star'},episode:{seasonNumber:1,episodeNumber:1,title:'Pilot'},cast:[],previous:null,next:{id:'e2',seasonNumber:1,episodeNumber:2,title:'Aftermath'}};
    if(path.endsWith('/subtitles'))return {items:[],configured:true};if(path.endsWith('/session'))return {generation:'s1',position:0};
    return {id:'e1',revision:'r1',filename:'North.Star.S01E01.mkv',library_kind:'tv',library_name:'Shows',path:'North.Star.S01E01.mkv',available:true,bytes:1024,episode:{id:88,showId:12,showName:'North Star',seasonNumber:1,episodeNumber:1,title:'Pilot'}};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams(location.hash.slice(1)))",context);
  assert(descendants(context.main).some(node=>node.tag==='a'&&node.href?.includes('id=e2')&&textOf(node).includes('Next')));
  assert.equal(descendants(context.main).find(node=>node.tag==='input'&&node.name==='q')?.value,'North Star');
  await context.buttons.find(item=>item.label==='Play original').fn();
  const video=vm.runInContext('player',context);
  assert.equal(video.src,'/api/videos/e1/media?r=r1');
});

test('Unmatched TV route requests only unmatched TV files',async()=>{
  const context=setup('#view=tv&section=unmatched');
  vm.runInContext(`api=async path=>{calls.push(path);return {items:[],total:0,offset:0,limit:24};};`,context);
  context.main=new Element('main');await vm.runInContext("tvPage(main,new URLSearchParams('view=tv&section=unmatched'))",context);
  assert.match(context.calls[0],/^\/api\/videos\?/);
  assert.match(context.calls[0],/type=tv/);assert.match(context.calls[0],/unmatched=1/);
});

test('Owner can identify an episode in a mixed Videos library',async()=>{
  const context=setup('#view=video&id=e1','owner');
  vm.runInContext(`features.metadata=true;api=async (path,data)=>{calls.push([path,data]);
    if(path.endsWith('/movie'))return {match:{state:'pending'},movie:null,cast:[]};
    if(path.includes('/episode/search?'))return {items:[{id:12,title:'North Star',year:2022}]};
    if(path.endsWith('/episode'))return data?{match:{state:'matched'},show:{id:12,name:'North Star'},episode:{id:88,seasonNumber:1,episodeNumber:2},cast:[]}:{match:{state:'pending'},show:null,episode:null,cast:[]};
    if(path.endsWith('/subtitles'))return {items:[],configured:false};
    return {id:'e1',revision:'r1',filename:'North.Star.S01E02.mkv',library_kind:'videos',library_name:'Mixed',path:'North.Star.S01E02.mkv',available:true,bytes:1024};};
    render=async()=>{};toast=()=>{};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=e1'))",context);
  assert(descendants(context.main).some(node=>node.tag==='h2'&&textOf(node)==='Movie match'));
  assert(descendants(context.main).some(node=>node.tag==='h2'&&textOf(node)==='Episode match'));
  const form=descendants(context.main).find(node=>node.tag==='form'&&descendants(node).some(child=>child.name==='season'));
  const season=descendants(form).find(node=>node.name==='season'),episode=descendants(form).find(node=>node.name==='episode');
  assert.equal(season.value,'1');assert.equal(episode.value,'2');form.listeners.submit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const selectButton=context.buttons.find(item=>item.label==='Select');assert(selectButton);
  season.value='';
  assert.throws(()=>selectButton.fn(),/season/i);
  assert(!context.calls.some(([path,data])=>path==='/api/videos/e1/episode'&&data?.tmdbId));
  season.value='0';
  await selectButton.fn();
  assert(context.calls.some(([path,data])=>path==='/api/videos/e1/episode'&&data?.tmdbId===12&&data.season===0&&data.episode===2&&data.revision==='r1'));
});

test('An episode match takes precedence over its Movies library kind',async()=>{
  const context=setup('#view=video&id=e1');
  vm.runInContext(`api=async path=>{if(path.endsWith('/episode'))return {match:{state:'matched'},show:{id:12,name:'North Star'},episode:{seasonNumber:1,episodeNumber:1,title:'Pilot'},cast:[]};
    if(path.endsWith('/subtitles'))return {items:[],configured:false};
    return {id:'e1',revision:'r1',filename:'Pilot.mkv',library_kind:'movies',library_name:'Odd',path:'Pilot.mkv',available:true,bytes:1024,episode:{showId:12,showName:'North Star',seasonNumber:1,episodeNumber:1,title:'Pilot'}};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=e1'))",context);
  assert(descendants(context.main).some(node=>node.className==='movie-hero episode-hero'));
  assert(!descendants(context.main).some(node=>node.className==='movie-hero'));
  const card=vm.runInContext("card({id:'e1',filename:'Pilot.mkv',library_kind:'movies',library_name:'Odd',episode:{showName:'North Star',seasonNumber:1,episodeNumber:1,title:'Pilot'}})",context);
  assert(!card.className.includes('movie-card'));
});

test('A movie match takes precedence over its TV library kind',async()=>{
  const context=setup('#view=video&id=m1');
  vm.runInContext(`api=async path=>{if(path.endsWith('/movie'))return {match:{state:'matched'},movie:{title:'The Film'},cast:[]};
    if(path.endsWith('/subtitles'))return {items:[],configured:false};
    return {id:'m1',revision:'r1',filename:'Film.mkv',library_kind:'tv',library_name:'Odd',path:'Film.mkv',available:true,bytes:1024,movie:{title:'The Film',year:2023}};};`,context);
  context.main=new Element('main');await vm.runInContext("videoPage(main,new URLSearchParams('view=video&id=m1'))",context);
  assert(descendants(context.main).some(node=>node.className==='movie-hero'));
  assert(!descendants(context.main).some(node=>node.className==='movie-hero episode-hero'));
  const card=vm.runInContext("card({id:'m1',filename:'Film.mkv',library_kind:'tv',library_name:'Odd',movie:{title:'The Film',year:2023}})",context);
  assert(card.className.includes('movie-card'));
});
