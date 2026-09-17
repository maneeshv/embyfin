const root=document.querySelector('#app'),notice=document.querySelector('#notice');
let account=null,epoch=0,pending=new Set(),player=null,cleanup=()=>{},flush=()=>{},local=false,libraryList=[],scrolls=new Map(),routeKey='';
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('embyfin-account'):null;
function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(key==='class')node.className=value;
    else if(value!==undefined&&value!==null&&value!==false){if(key in node && !key.startsWith('aria-'))node[key]=value;else node.setAttribute(key,value===true?'':String(value));}
  }
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
function toast(text){notice.textContent=text;setTimeout(()=>{if(notice.textContent===text)notice.textContent='';},5000);}
const route=()=>new URLSearchParams(location.hash.slice(1));
function href(changes,base=route()){const next=new URLSearchParams(base);for(const[k,v]of Object.entries(changes)){if(v===null||v===undefined||v==='')next.delete(k);else next.set(k,v);}return '#'+next;}
const size=n=>new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n/1024**(n>=1024**3?3:2))+(n>=1024**3?' GiB':' MiB');
function duration(seconds){if(seconds==null)return 'Unknown';const n=Math.floor(seconds);return n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`:`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
const date=value=>value?new Date(typeof value==='number'?value*1000:value).toLocaleString(): 'Not yet';
function clearPrivate(saveProgress=false){
  cleanup(saveProgress);cleanup=flush=()=>{};epoch++;for(const c of pending)c.abort();pending.clear();
  if(player){player.pause();player.removeAttribute('src');player.load();player=null;}
  root.replaceChildren();root.className='';notice.textContent='';account=null;libraryList=[];scrolls.clear();
}
class APIError extends Error{constructor(status,code,message){super(message||code);this.status=status;this.code=code;}}
async function api(path,data,uid=account?.id){
  const controller=new AbortController(),generation=epoch;pending.add(controller);
  try{
    const response=await fetch(path,{method:data===undefined?'GET':'POST',credentials:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal,
      headers:data===undefined?{}:{'Content-Type':'application/json','X-Embyfin-User':uid},body:data===undefined?undefined:JSON.stringify(data)});
    if(uid&&response.headers.get('X-Embyfin-User')&&response.headers.get('X-Embyfin-User')!==uid){clearPrivate();queueMicrotask(()=>void boot());throw new DOMException('Account changed','AbortError');}
    if(response.type==='opaqueredirect'||!response.headers.get('Content-Type')?.includes('application/json'))throw new APIError(401,'sign_in_required','Sign in again to continue.');
    const result=await response.json();if(generation!==epoch)throw new DOMException('Discarded old account response','AbortError');
    if(!response.ok)throw new APIError(response.status,result.error,result.message);
    return result;
  }catch(error){if(generation!==epoch||controller.signal.aborted)throw new DOMException('Cancelled','AbortError');throw error;}
  finally{pending.delete(controller);}
}
function errorBox(error){
  const box=el('div',{class:'error',role:'alert'},error.message||'Could not load the library. Check your connection and try again.');
  if(error.status===401)box.append(el('a',{href:location.href.split('#')[0]+location.hash},'Sign in again'));
  else box.append(el('button',{onClick:()=>boot()},'Try again'));
  return box;
}
async function action(button,fn){button.disabled=true;try{await fn();}catch(error){if(error.name!=='AbortError')toast(error.message||'Could not save. Check your connection.');}finally{button.disabled=false;}}
function button(text,fn,primary=false){const b=el('button',{type:'button',class:primary?'primary':''},text);b.addEventListener('click',()=>action(b,fn));return b;}
function logout(){clearPrivate();channel?.postMessage('logout');try{localStorage.setItem('embyfin-logout',String(Date.now()));}catch{}location.assign('/cdn-cgi/access/logout');}
function shell(view){
  const main=el('main',{id:'main',class:'workspace',tabIndex:-1,'data-view':view}),existing=root.querySelector('.nav');
  // The sidebar survives navigation; only the workspace is replaced, so nothing outside it flashes.
  if(existing){for(const a of existing.children)if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');root.querySelector('main').replaceWith(main);}
  else{
    const nav=el('nav',{class:'nav','aria-label':'Main navigation'},[
      ['Library','library'],['Folders','folders'],['Favorites','favorites'],...(account.role==='owner'?[['Settings','settings']]:[]),
    ].map(([title,key])=>el('a',{href:'#view='+key,'data-view':key,'aria-current':view===key?'page':null},title)));
    root.replaceChildren(el('div',{class:'shell'},el('aside',{class:'sidebar'},
      el('a',{href:'#view=library',class:'brand'},el('span',{class:'brand-mark','aria-hidden':true},'▷'),'embyfin'),
      el('div',{},el('p',{class:'eyebrow'},'Your collection'),nav),
      el('div',{class:'account'},el('strong',{},account.email),el('span',{class:'muted'},local?'Local development':account.role==='owner'?'Library owner':'Private library'),button('Sign out',logout))),main));
  }
  main.append(el('div',{class:'topline'},el('span',{class:'eyebrow'},'Private video library'),el('span',{class:'muted'},`${libraryList.length} ${libraryList.length===1?'library':'libraries'}`)));
  return main;
}
function poster(v){const label=el('span',{class:'poster-label'},v.poster?'':v.enrichment==='failed'?'Poster unavailable':'Poster pending'),p=el('div',{class:v.poster?'poster loading':'poster'},el('span',{class:'poster-symbol','aria-hidden':true},'▷'),label);
  if(v.poster){const img=el('img',{src:v.poster,alt:'',loading:'lazy',decoding:'async'}),shown=()=>{p.className='poster';};
    img.addEventListener('load',shown);img.addEventListener('error',()=>{img.remove();label.textContent='Poster unavailable';shown();});p.append(img);if(img.complete&&img.naturalWidth)shown();}
  if(v.duration!=null)p.append(el('span',{class:'duration'},duration(v.duration)));
  if(v.watched)p.append(el('span',{class:'watched','aria-label':'Watched'},'✓'));return p;}
function card(v){return el('a',{class:'video-card',href:href({view:'video',id:v.id,from:route().get('view')||'library'})},poster(v),
  v.position>0&&!v.watched&&v.duration?el('progress',{value:v.position,max:v.duration,'aria-label':'Watch progress'}):null,
  el('h3',{},v.filename),el('p',{title:v.parent||v.library_name},v.parent||v.library_name));}
function section(title,items,target){return el('section',{class:'section'},el('div',{class:'section-heading'},el('h2',{},title),el('a',{href:target},'View all →')),
  items.length?el('div',{class:'rail'},items.slice(0,4).map(card)):el('div',{class:'empty'},'Nothing here yet.'));}
function select(label,name,options,value){const node=el('select',{name,'aria-label':label},options.map(([v,text])=>el('option',{value:v,selected:v===value},text)));return el('label',{},label,node);}
function filters(params,folderView=false){
  const form=el('form',{class:'filters'},el('label',{class:'search'},'Search filenames and paths',el('input',{name:'q',type:'search',value:params.get('q')||'',placeholder:'Search your videos…',maxLength:256})),
    select('Library','library',[['','All libraries'],...libraryList.map(l=>[l.id,l.name])],params.get('library')||''),
    select('Sort by','sort',[['added','First discovered'],['name','Filename'],['modified','Source modified'],['size','File size'],['duration','Duration']],params.get('sort')||'added'),
    select('Order','direction',[['desc','Descending'],['asc','Ascending']],params.get('direction')||'desc'),
    select('Watch state','watched',[['','Any'],['0','Unwatched'],['1','Watched']],params.get('watched')||''),
    folderView?select('Search scope','scope',[['folder','This folder and descendants'],['global','All my libraries']],params.get('scope')||'folder'):null,
    el('button',{type:'submit'},'Search'));
  form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));location.hash=href({...data,offset:null,section:null,folder:folderView&&data.scope!=='global'&&data.library===params.get('library')?params.get('folder'):null,id:null});});
  return form;
}
function paginate(data,params){return el('nav',{class:'pagination','aria-label':'Pages'},data.offset>0?el('a',{href:href({offset:Math.max(0,data.offset-data.limit)},params)},'← Previous'):null,
  el('span',{class:'muted'},data.total?`${data.offset+1}–${Math.min(data.total,data.offset+data.limit)} of ${data.total}`:'0 videos'),
  data.offset+data.limit<data.total?el('a',{href:href({offset:data.offset+data.limit},params)},'Next →'):null);}
async function library(main,params){
  const favorites=params.get('view')==='favorites',sectionName=params.get('section');
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},favorites?'Favorites':({continue:'Continue Watching',recent:'Recently Watched',added:'Recently Added'})[sectionName]||'Library'),el('p',{class:'muted'},'Your videos. Right where you left them.'))),filters(params));
  if(!libraryList.length){main.append(el('div',{class:'setup'},el('h2',{},'Your library starts here'),el('p',{},account.role==='owner'?'Connect your source and choose the folders you want to share.':'The owner needs to grant this account access to a library.'),account.role==='owner'?el('a',{href:'#view=settings'},'Open settings →'):null));return;}
  const query=new URLSearchParams(params);query.delete('view');if(favorites)query.set('section','favorites');
  const home=!favorites&&!sectionName&&!params.get('q')&&!params.get('watched')&&!params.get('offset');
  const sections=home?[['Continue Watching','continue'],['Recently Watched','recent'],['Recently Added','added'],['Favorites','favorites']]:[];
  const [data,...rails]=await Promise.all([api('/api/videos?'+query),...sections.map(([,s])=>api('/api/videos?'+new URLSearchParams({...Object.fromEntries(query),section:s,limit:4})))]);
  sections.forEach(([title,s],i)=>{if(rails[i].items.length)main.append(section(title,rails[i].items,href({section:s,offset:null})));});
  if(home)main.append(el('div',{class:'section-heading'},el('h2',{},'All Videos'),el('span',{class:'muted'},`${data.total} videos`)));
  main.append(data.items.length?el('div',{class:'grid'},data.items.map(card)):el('div',{class:'empty'},'No matching videos. Try another search or check the scan status.'),paginate(data,params));
}
async function folderPage(main,params){
  const scoped=new URLSearchParams(params);
  if(!scoped.get('sort'))scoped.set('sort','name');if(!scoped.get('direction'))scoped.set('direction','asc');
  const libraryId=scoped.get('library'),folder=scoped.get('folder')||'';
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},'Folders'),el('p',{class:'muted'},'Browse the structure you already know.'))),filters(scoped,true));
  if(!libraryList.length){main.append(el('div',{class:'empty'},'No shared libraries yet.'));return;}
  if(!libraryId&&!scoped.get('q')){
    main.append(el('div',{class:'folder-grid'},libraryList.map(l=>el('a',{class:'folder',href:href({library:l.id,folder:null,offset:null},scoped)},el('span',{'aria-hidden':true},'▱'),el('span',{},l.name)))));
    return;
  }
  const crumbs=el('nav',{class:'breadcrumbs','aria-label':'Folder breadcrumbs'},el('a',{href:'#view=folders'},'All libraries'));
  if(libraryId)crumbs.append(' / ',el('a',{href:href({folder:null,library:libraryId,offset:null},scoped)},libraryList.find(l=>l.id===libraryId)?.name||'Library'));
  let path='';for(const name of folder.split('/').filter(Boolean)){path+=name+'/';crumbs.append(' / ',el('a',{href:href({folder:path,offset:null},scoped)},name));}main.append(crumbs);
  const query=new URLSearchParams(scoped);query.set('folder',folder);query.set('sort',scoped.get('sort')||'name');query.set('direction',scoped.get('direction')||'asc');
  if(scoped.get('q')){if(scoped.get('scope')==='global'||!libraryId){query.delete('folder');query.delete('library');}else query.set('recursive','1');}
  const container=el('div',{class:'folder-grid'});let offset=0;
  const listFolders=()=>api('/api/folders?'+new URLSearchParams({library:libraryId,folder,offset})),more=button('More folders',async()=>add(await listFolders()));
  const add=result=>{for(const f of result.items)container.append(el('a',{class:'folder',href:href({folder:f.path,library:libraryId,offset:null},scoped)},el('span',{'aria-hidden':true},'▱'),el('span',{},f.name.slice(0,-1))));offset+=100;more.hidden=!result.more;};
  const [first,data]=await Promise.all([scoped.get('q')?null:listFolders(),api('/api/videos?'+query)]);
  if(first){add(first);if(container.childNodes.length)main.append(container,more);}
  main.append(data.items.length?el('div',{class:'grid'},data.items.map(card)):el('div',{class:'empty'},scoped.get('q')?'No matching videos.':'No videos directly in this folder.'),paginate(data,scoped));
}
async function videoPage(main,params){
  const content=el('div',{class:'details'},el('a',{class:'muted',href:href({view:params.get('from')||'library',id:null,from:null})},'← Back to videos'),el('div',{class:'detail-media'},el('div',{class:'poster loading'})));
  main.append(content);
  const v=await api('/api/videos/'+encodeURIComponent(params.get('id'))),currentEpoch=epoch,uid=account.id;
  const media=el('div',{class:'detail-media'},poster(v)),diagnostic=el('div',{'aria-live':'polite'});
  content.replaceChildren();content.append(el('a',{class:'muted',href:href({view:params.get('from')||'library',id:null,from:null})},'← Back to videos'),el('h1',{},v.filename),el('p',{class:'muted'},v.library_name+' / '+v.path),media);
  let session=null,seq=0,lastSave=0,retries=0,saveEnabled=true,flushed=null;
  async function save(ended=false,source=player,leaving=false){
    if(!session||!player||source!==player||currentEpoch!==epoch||!saveEnabled)return;
    if(leaving){const mark=player.currentTime+(ended?'e':'');if(mark===flushed)return;flushed=mark;}
    lastSave=Date.now();
    const path=`/api/videos/${v.id}/progress`,data={revision:v.revision,generation:session.generation,sequence:++seq,position:Math.min(player.currentTime,v.duration||31536000),ended};
    if(leaving){
      // Keep the final write alive after teardown; the server still checks user and session identity.
      try{await fetch(path,{method:'POST',credentials:'same-origin',redirect:'manual',keepalive:true,
        headers:{'Content-Type':'application/json','X-Embyfin-User':uid},body:JSON.stringify(data)});}catch{}
      return;
    }
    try{await api(path,data,uid);}
    catch(error){if(error.code==='stale_playback'||error.code==='source_changed'){saveEnabled=false;toast('Playback state changed in another session. Open this video again to save progress.');}else if(error.status===401){player?.pause();diagnostic.replaceChildren(errorBox(error));}}
  }
  async function diagnose(){
    if(currentEpoch!==epoch)return;
    const mediaError=player?.error;let message='Playback failed on this device. The original remains in your library.';
    try{
      const who=await api('/api/session');if(who.user.id!==uid){clearPrivate();await boot();return;}
      await api(`/api/videos/${v.id}/availability`);
      if(mediaError?.code===2)message='Playback was interrupted by a network failure. Check your connection and retry.';
      else if(mediaError?.code===4)message='This device could not play the original. Its format or codecs may be unsupported here.';
    }catch(error){
      if(error.name==='AbortError')return;
      if(error.status===401){diagnostic.replaceChildren(errorBox(error));return;}
      if([403,404].includes(error.status))message='Access to this video is no longer available.';
      else if(error.status===409)message='The original changed. Its catalog needs to refresh before you can play it.';
      else if(error.status===410)message='The original is no longer in storage.';
      else message='Could not check playback. Check your connection and try again.';
      if([403,404,409,410].includes(error.status))retries=2;
    }
    diagnostic.replaceChildren(el('div',{class:'error'},message,retries<2?button('Retry playback',async()=>{retries++;await start(false);}):null));
  }
  async function start(startOver){
    saveEnabled=false;if(player){player.pause();player.removeAttribute('src');player.load();}
    session=await api(`/api/videos/${v.id}/session`,{revision:v.revision,startOver},uid);seq=0;lastSave=Date.now();saveEnabled=true;
    const video=el('video',{controls:true,playsInline:true,preload:'metadata',poster:v.poster||'',src:`/api/videos/${v.id}/media`});player=video;
    video.addEventListener('loadedmetadata',()=>{if(currentEpoch!==epoch||player!==video)return;if(session.position>0)video.currentTime=Math.min(session.position,Number.isFinite(video.duration)?video.duration:session.position);video.play().catch(()=>{});},{once:true});
    video.addEventListener('timeupdate',()=>{if(!video.paused&&Date.now()-lastSave>=15000)void save(false,video);});
    video.addEventListener('pause',()=>void save(false,video));video.addEventListener('ended',()=>void save(true,video));video.addEventListener('error',()=>{if(player===video)void diagnose();});
    const speed=select('Playback speed','speed',[['0.5','0.5×'],['0.75','0.75×'],['1','1×'],['1.25','1.25×'],['1.5','1.5×'],['2','2×']],'1');speed.querySelector('select').addEventListener('change',e=>{video.playbackRate=Number(e.target.value);});
    media.replaceChildren(video,el('div',{class:'actions'},speed));diagnostic.replaceChildren();
  }
  const favorite=button(v.favorite?'★ Favorited':'☆ Favorite',async()=>{await api(`/api/videos/${v.id}/favorite`,{favorite:!v.favorite},uid);v.favorite=!v.favorite;favorite.textContent=v.favorite?'★ Favorited':'☆ Favorite';});
  const watched=button(v.watched?'Mark unwatched':'Mark watched',async()=>{await api(`/api/videos/${v.id}/watched`,{watched:!v.watched,revision:v.revision},uid);v.watched=!v.watched;session=null;watched.textContent=v.watched?'Mark unwatched':'Mark watched';});
  content.append(el('div',{class:'actions'},v.available?button(v.position>0&&!v.watched?`Resume ${duration(v.position)}`:'Play original',()=>start(false),true):el('span',{class:'error'},'Original unavailable'),
    v.available?button('Start over',()=>start(true)):null,favorite,watched),diagnostic,
    el('p',{class:'muted'},'Original playback depends on this browser and device. No automatic transcoding.'),
    el('dl',{class:'facts'},[['Duration',duration(v.duration)],['File size',size(v.bytes)],['Source modified',date(v.modified)],['First discovered',date(v.first_seen)],['Dimensions',v.width&&v.height?`${v.width} × ${v.height}`:'Unknown'],['Container',v.container||'Unknown'],['Video codec',v.video_codec||'Unknown'],['Audio codec',v.audio_codec||'Unknown'],['Processing',v.enrichment+(v.processing_error?' · '+v.processing_error.replaceAll('_',' '):'')]].map(([k,val])=>el('div',{},el('dt',{},k),el('dd',{},val)))));
  flush=()=>void save(player?.ended||false,player,true);
  cleanup=(saveProgress=false)=>{if(saveProgress)flush();saveEnabled=false;session=null;};
}
function table(headers,rows){return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},headers.map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows.map(row=>el('tr',{},row.map(cell=>el('td',{},cell)))))));}
async function settings(main){
  const data=await api('/api/admin');main.classList.add('settings');
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},'Settings'),el('p',{class:'muted'},'Connect, share, and keep your catalog up to date.'))));
  async function change(path,payload){await api('/api/admin/'+path,payload);libraryList=(await api('/api/libraries')).items;await render();}
  const source=el('section',{},el('h2',{},'Source connection'),el('p',{class:'muted'},'Existing bucket: ',el('code',{},data.source.bucket)),
    el('p',{class:'muted'},data.source.configured?'Source credentials configured. Validate list, read, and poster storage access.':'Add read-only R2 source credentials through deployment configuration.'),
    el('div',{class:'actions'},button('Validate connection',async()=>{const result=await api('/api/admin/validate',{});toast('Connection verified. Original read: '+result.read);})));
  const libs=el('section',{},el('h2',{},'Libraries & sharing boundaries'),el('p',{class:'muted'},'Use an exact folder prefix ending in /. Leave it empty for the whole bucket. Overlapping libraries are not allowed.'),
    table(['Library / prefix','Catalog','Schedule','Actions'],data.libraries.map(l=>[
      el('div',{},el('strong',{},l.name),el('p',{},el('code',{},l.prefix||'(whole bucket)')),el('span',{class:'status'},l.frozen?'Scope frozen':'Not scanned')),
      `${l.discovered} discovered · ${l.enriched} enriched · ${l.pending} pending · ${l.failed} failed · ${l.missing} missing`,
      el('div',{},l.paused?'Paused':l.frozen?'Daily scan enabled':'Start the first scan to enable daily refresh',el('p',{class:'muted'},'Last success: '+date(l.last_success))),
      el('div',{class:'actions'},button('Start scan',()=>change('scan',{libraryId:l.id,action:'start'})),button(l.paused?'Resume':'Pause',()=>change('scan',{libraryId:l.id,action:l.paused?'resume':'pause'})),button('Retry failed',()=>change('retry',{libraryId:l.id})),button(l.enabled?'Disable':'Enable',()=>change('libraries',{id:l.id,name:l.name,prefix:l.prefix,enabled:!l.enabled})),button('Edit',()=>{name.value=l.name;path.value=l.prefix;editing=l.id;path.disabled=!!l.frozen;submit.textContent='Save library';form.scrollIntoView({behavior:'smooth',block:'center'});name.focus();})),
    ])));
  let editing=null;
  const name=el('input',{name:'name',required:true,maxLength:100,placeholder:'Family videos'}),path=el('input',{name:'prefix',maxLength:1024,placeholder:'family/'}),preview=el('p',{},'Boundary preview: the whole bucket; this prevents any nested library.'),submit=el('button',{type:'submit',class:'primary'},'Add library');
  path.addEventListener('input',()=>{preview.textContent=path.value?`Boundary preview: only objects inside ${path.value}; sibling prefixes stay outside this library.`:'Boundary preview: the whole bucket; this prevents any nested library.';});
  const form=el('form',{class:'inline-form'},el('label',{},'Library name',name),el('label',{},'Exact bucket prefix',path),submit,preview);
  form.addEventListener('submit',event=>{event.preventDefault();void action(submit,()=>change('libraries',{id:editing,name:name.value,prefix:path.value}));});libs.append(form);
  const users=el('section',{},el('h2',{},'People & access'),el('p',{class:'muted'},'First admit the email in Cloudflare Access. Then enable the application account and grant libraries below. Adding an account here does not change Access admission.'),
    table(['Person','Application account','Library grants'],data.users.map(u=>[
      el('div',{},u.email,el('p',{class:'muted'},u.role)),
      el('div',{},u.linked?'Identity linked':'Awaiting first admitted sign-in',u.role!=='owner'?button(u.enabled?'Disable account':'Enable account',()=>change('users',{email:u.email,enabled:!u.enabled})):null),
      u.role==='owner'?'All enabled libraries':el('div',{},data.libraries.map(l=>{const input=el('input',{type:'checkbox',checked:data.grants.some(g=>g.user_id===u.id&&g.library_id===l.id)});input.addEventListener('change',()=>void action(input,async()=>{try{await api('/api/admin/grants',{userId:u.id,libraryId:l.id,granted:input.checked});toast('Library access updated.');}catch(error){input.checked=!input.checked;throw error;}}));return el('label',{class:'checklabel'},input,l.name);})),
    ])));
  const email=el('input',{name:'email',type:'email',required:true,placeholder:'viewer@example.com'}),add=el('button',{type:'submit'},'Add account'),userForm=el('form',{class:'inline-form'},el('label',{},'Admitted email',email),add);
  userForm.addEventListener('submit',event=>{event.preventDefault();void action(add,()=>change('users',{email:email.value,enabled:true}));});users.append(userForm);
  const scans=el('section',{},el('h2',{},'Inventory & processing'),el('p',{class:'muted'},'Inventory and enrichment finish independently. Cron advances scans without an open browser. Processing '+(data.processingEnabled?'is enabled.':'is disabled until resource limits and sample results are accepted.')),
    table(['Library','Scan state','Discovered / ignored','Last activity','Error'],data.scans.map(s=>[data.libraries.find(l=>l.id===s.library_id)?.name||'Library',s.status,s.discovered+' / '+s.ignored,date(s.updated_at),s.error||((['listing','reconciling'].includes(s.status)&&Date.now()/1000-s.updated_at>180)?'Overdue; check scheduled ticks':'—')])),
    data.failures.length?table(['Processing failure','Library','Reason','Attempts / reserved reads'],data.failures.map(f=>[el('a',{href:'#view=video&id='+f.id},f.filename),f.library_name,(f.processing_error||'Unknown').replaceAll('_',' '),`${f.attempts||0} / ${size(f.read_bytes||0)}`])):el('p',{class:'muted'},'No processing failures.'));
  const backup=data.backup?.lastComplete;
  const operations=el('section',{},el('h2',{},'Backups & recovery'),el('p',{class:'muted'},'Daily consistent exports, 30-day retention. Exporting briefly pauses the application.'),
    el('p',{},backup?`Last successful copy: ${date(backup.completed)}${Date.now()/1000-backup.completed>86400?' — OVERDUE':''}`:'No successful backup recorded.'),
    el('p',{class:'muted'},data.backupConfigured?'Backup export credentials configured.':'Configure backup export credentials and an independent Cloudflare alert before release.'),
    el('div',{class:'actions'},button('Back up now',()=>change('backup',{})),el('a',{href:'/recovery.html',target:'_blank',rel:'noopener'},'Open recovery runbook ↗')));
  main.append(source,libs,users,scans,operations);
}
async function render(){
  if(!account)return;
  if(routeKey)scrolls.set(routeKey,window.scrollY);const saved=scrolls.get(location.hash)||0;routeKey=location.hash;
  cleanup(true);cleanup=flush=()=>{};epoch++;for(const c of pending)c.abort();pending.clear();if(player){player.pause();player.removeAttribute('src');player.load();player=null;}
  const generation=epoch,params=route(),view=params.get('view')||'library',main=shell(view);
  main.setAttribute('aria-busy','true');if(!saved)window.scrollTo(0,0);
  try{if(view==='video')await videoPage(main,params);else if(view==='folders')await folderPage(main,params);else if(view==='settings')await settings(main);else await library(main,params);if(epoch===generation&&saved)window.scrollTo(0,saved);}
  catch(error){if(error.name!=='AbortError'&&epoch===generation)main.append(errorBox(error));}
  finally{main.removeAttribute('aria-busy');}
}
async function boot(){
  clearPrivate();const generation=epoch;
  root.append(el('main',{id:'main'},el('p',{class:'empty',role:'status'},'Signing in to your library…')));
  try{const [session,libs]=await Promise.all([api('/api/session'),api('/api/libraries')]);if(generation!==epoch)return;account=session.user;local=session.local;channel?.postMessage({type:'identity',id:account.id});libraryList=libs.items;await render();}
  catch(error){if(error.name!=='AbortError'&&generation===epoch)root.replaceChildren(el('main',{id:'main',class:'workspace'},el('h1',{},'Embyfin'),errorBox(error)));}
}
function remoteLogout(){clearPrivate();root.append(el('main',{class:'workspace'},el('h1',{},'Signed out'),el('p',{},'This device changed accounts. Sign in again to continue.'),el('a',{href:'/'},'Sign in')));}
channel?.addEventListener('message',event=>{if(event.data==='logout')remoteLogout();else if(event.data?.type==='identity'&&account&&event.data.id!==account.id)void boot();});
window.addEventListener('storage',event=>{if(event.key==='embyfin-logout')remoteLogout();});
window.addEventListener('hashchange',()=>void render());
document.querySelector('.skip').addEventListener('click',event=>{event.preventDefault();document.querySelector('#main')?.focus();});
window.addEventListener('pagehide',()=>clearPrivate(true));
window.addEventListener('pageshow',event=>{if(event.persisted)void boot();});
// Hiding the tab flushes progress but keeps the page. Returning hides it until identity is revalidated; api() reboots on a changed or rejected account.
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)flush();
  else if(account){root.className='revalidating';api('/api/session').then(()=>{root.className='';},error=>{if(error.name!=='AbortError'){clearPrivate();void boot();}});}
  else void boot();
});
void boot();
