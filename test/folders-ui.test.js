import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.childNodes=[];this.listeners={};}
  append(...children){this.childNodes.push(...children);}
  setAttribute(key,value){this[key]=value;}
  addEventListener(name,fn){this.listeners[name]=fn;}
}
function page(){
  const context=vm.createContext({Node:Element,URLSearchParams,Intl,location:{hash:'#view=folders'},document:{
    querySelector:()=>new Element('div'),createElement:tag=>new Element(tag),createTextNode:text=>({text}),
  }});
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(0,source.indexOf('async function videoPage(')),context);
  vm.runInContext(`libraryList=[{id:'a',name:'Categories'},{id:'b',name:'Studios'}];
    calls=[];api=async path=>{calls.push(path);return path.startsWith('/api/folders')?{items:[{name:'child/',path:'child/'}],more:false}:{items:[],total:0,offset:0,limit:100};};`,context);
  return context;
}
function descendants(node){return [node,...(node.childNodes||[]).flatMap(descendants)];}

test('Folders starts at all permitted libraries, navigates children, and searches across libraries',async()=>{
  const context=page();context.main=new Element('main');
  await vm.runInContext("folderPage(main,new URLSearchParams('view=folders'))",context);
  assert.deepEqual(descendants(context.main).filter(n=>n.tag==='a').map(n=>n.href),['#view=folders&sort=name&direction=asc&library=a','#view=folders&sort=name&direction=asc&library=b']);
  assert.equal(context.calls.length,0);
  context.main=new Element('main');
  await vm.runInContext("folderPage(main,new URLSearchParams('view=folders&library=b'))",context);
  assert(context.calls[0].includes('library=b'));
  assert(descendants(context.main).some(n=>n.href==='#view=folders'));
  context.calls.length=0;context.main=new Element('main');
  await vm.runInContext("folderPage(main,new URLSearchParams('view=folders&q=clip'))",context);
  const query=new URL(context.calls[0],'https://media.test').searchParams;
  assert.equal(query.get('q'),'clip');assert.equal(query.has('library'),false);assert.equal(query.has('folder'),false);
});

test('Switching libraries resets the previous folder',()=>{
  const context=page();context.FormData=class {*[Symbol.iterator](){yield ['library','b'];yield ['scope','folder'];}};
  const form=vm.runInContext("filters(new URLSearchParams('view=folders&library=a&folder=nested/'),true)",context);
  form.listeners.submit({preventDefault(){}});
  const query=new URLSearchParams(context.location.hash.slice(1));
  assert.equal(query.get('library'),'b');assert.equal(query.has('folder'),false);
});
