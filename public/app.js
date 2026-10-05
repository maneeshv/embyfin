const root=document.querySelector('#app'),notice=document.querySelector('#notice');
let account=null,features={},epoch=0,pending=new Set(),player=null,cleanup=()=>{},flush=()=>{},local=false,libraryList=[],scrolls=new Map(),routeKey='';
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
  root.replaceChildren();root.className='';notice.textContent='';account=null;features={};libraryList=[];scrolls.clear();
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
      ['Library','library'],['Movies','movies'],['TV Shows','tv'],['Folders','folders'],['Favorites','favorites'],...(account.role==='owner'?[['Settings','settings']]:[]),
    ].map(([title,key])=>el('a',{href:'#view='+key,'data-view':key,'aria-current':view===key?'page':null},title)));
    root.replaceChildren(el('div',{class:'shell'},el('aside',{class:'sidebar'},
      el('a',{href:'#view=library',class:'brand'},el('span',{class:'brand-mark','aria-hidden':true},'▷'),'embyfin'),
      el('div',{},el('p',{class:'eyebrow'},'Your collection'),nav),
      el('div',{class:'account'},el('strong',{},account.email),el('span',{class:'muted'},local?'Local development':account.role==='owner'?'Library owner':'Private library'),button('Sign out',logout))),main));
  }
  main.append(el('div',{class:'topline'},el('span',{class:'eyebrow'},'Private video library'),el('span',{class:'muted'},`${libraryList.length} ${libraryList.length===1?'library':'libraries'}`)));
  return main;
}
function poster(v){const src=v.movie?.poster||v.episode?.still||v.episode?.poster||v.poster;const isMovie=!!v.movie||!v.episode&&v.library_kind==='movies';const label=el('span',{class:'poster-label'},src?'':isMovie?'Artwork unavailable':v.enrichment==='failed'?'Poster unavailable':'Poster pending'),p=el('div',{class:`${src?'poster loading':'poster'}${isMovie?' movie-poster':''}`},el('span',{class:'poster-symbol','aria-hidden':true},'▷'),label);
  if(src){const img=el('img',{src,alt:'',loading:'lazy',decoding:'async'}),shown=()=>{p.className='poster';};
    img.addEventListener('load',()=>{shown();if(isMovie)p.classList.add('movie-poster');});img.addEventListener('error',()=>{img.remove();label.textContent='Poster unavailable';shown();if(isMovie)p.classList.add('movie-poster');});p.append(img);if(img.complete&&img.naturalWidth){shown();if(isMovie)p.classList.add('movie-poster');}}
  if(v.duration!=null)p.append(el('span',{class:'duration'},duration(v.duration)));
  if(v.watched)p.append(el('span',{class:'watched','aria-label':'Watched'},'✓'));return p;}
function episodeLabel(episode){return `S${String(episode.seasonNumber).padStart(2,'0')}E${String(episode.episodeNumber).padStart(2,'0')}`;}
function card(v){const isMovie=!!v.movie||!v.episode&&v.library_kind==='movies';const from=route().get('view')||'library';return el('a',{class:`video-card${isMovie?' movie-card':''}${v.episode?' episode-card':''}`,href:href({view:'video',id:v.id,from,fromId:from==='person'||from==='show'?route().get('id'):null})},poster(v),
  v.position>0&&!v.watched&&v.duration?el('progress',{value:v.position,max:v.duration,'aria-label':'Watch progress'}):null,
  el('h3',{},v.movie?.title||v.episode?.title||v.filename),el('p',{title:isMovie?`${v.movie?.year||'Unmatched movie'} · ${v.library_name}`:v.episode?`${v.episode.showName} · ${episodeLabel(v.episode)}`:v.parent||v.library_name},isMovie?`${v.movie?.year||'Unmatched movie'} · ${v.library_name}`:v.episode?`${v.episode.showName} · ${episodeLabel(v.episode)}`:v.parent||v.library_name));}
function section(title,items,target){return el('section',{class:'section'},el('div',{class:'section-heading'},el('h2',{},title),el('a',{href:target},'View all →')),
  items.length?el('div',{class:'rail'},items.slice(0,4).map(card)):el('div',{class:'empty'},'Nothing here yet.'));}
function select(label,name,options,value){const node=el('select',{name,'aria-label':label},options.map(([v,text])=>el('option',{value:v,selected:v===value},text)));return el('label',{},label,node);}
function filters(params,folderView=false){
  const movies=params.get('view')==='movies',form=el('form',{class:'filters'},el('label',{class:'search'},movies?'Search movies':'Search filenames and paths',el('input',{name:'q',type:'search',value:params.get('q')||'',placeholder:movies?'Search your movies…':'Search your videos…',maxLength:256})),
    select('Library','library',[['','All libraries'],...libraryList.map(l=>[l.id,l.name])],params.get('library')||''),
    select('Sort by','sort',[['added','First discovered'],['name','Filename'],['modified','Source modified'],['size','File size'],['duration','Duration']],params.get('sort')||'added'),
    select('Order','direction',[['desc','Descending'],['asc','Ascending']],params.get('direction')||'desc'),
    select('Watch state','watched',[['','Any'],['0','Unwatched'],['1','Watched']],params.get('watched')||''),
    folderView?select('Search scope','scope',[['folder','This folder and descendants'],['global','All my libraries']],params.get('scope')||'folder'):null,
    el('button',{type:'submit'},'Search'));
  form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));location.hash=href({...data,offset:null,section:params.get('view')==='tv'&&params.get('section')==='unmatched'?'unmatched':null,folder:folderView&&data.scope!=='global'&&data.library===params.get('library')?params.get('folder'):null,id:null});});
  return form;
}
function paginate(data,params,noun='videos'){return el('nav',{class:'pagination','aria-label':'Pages'},data.offset>0?el('a',{href:href({offset:Math.max(0,data.offset-data.limit)},params)},'← Previous'):null,
  el('span',{class:'muted'},data.total?`${data.offset+1}–${Math.min(data.total,data.offset+data.limit)} of ${data.total} ${noun}`:`0 ${noun}`),
  data.offset+data.limit<data.total?el('a',{href:href({offset:data.offset+data.limit},params)},'Next →'):null);}
async function library(main,params){
  const favorites=params.get('view')==='favorites',movies=params.get('view')==='movies',unmatched=params.get('view')==='tv'&&params.get('section')==='unmatched',sectionName=params.get('section');
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},unmatched?'Unmatched TV files':movies?'Movies':favorites?'Favorites':({continue:'Continue Watching',recent:'Recently Watched',added:'Recently Added'})[sectionName]||'Library'),el('p',{class:'muted'},unmatched?'TV files that still need a show and episode match.':movies?'Movies from your shared libraries.':'Your videos. Right where you left them.'))),filters(params));
  if(!libraryList.length){main.append(el('div',{class:'setup'},el('h2',{},'Your library starts here'),el('p',{},account.role==='owner'?'Connect your source and choose the folders you want to share.':'The owner needs to grant this account access to a library.'),account.role==='owner'?el('a',{href:'#view=settings'},'Open settings →'):null));return;}
  const query=new URLSearchParams(params);query.delete('view');if(favorites)query.set('section','favorites');if(movies)query.set('type','movies');if(unmatched){query.delete('section');query.set('type','tv');query.set('unmatched','1');}
  const home=!movies&&!favorites&&!unmatched&&!sectionName&&!params.get('q')&&!params.get('watched')&&!params.get('offset');
  const sections=home?[['Continue Watching','continue'],['Recently Watched','recent'],['Recently Added','added'],['Favorites','favorites']]:[];
  const [data,...rails]=await Promise.all([api('/api/videos?'+query),...sections.map(([,s])=>api('/api/videos?'+new URLSearchParams({...Object.fromEntries(query),section:s,limit:4})))]);
  sections.forEach(([title,s],i)=>{if(rails[i].items.length)main.append(section(title,rails[i].items,href({section:s,offset:null})));});
  if(home)main.append(el('div',{class:'section-heading'},el('h2',{},'All Videos'),el('span',{class:'muted'},`${data.total} videos`)));
  main.append(data.items.length?el('div',{class:`grid${movies?' movie-grid':''}`},data.items.map(card)):el('div',{class:'empty'},movies?'No movies found in your shared libraries.':'No matching videos. Try another search or check the scan status.'),paginate(data,params));
}
async function tvPage(main,params){
  if(params.get('section')==='unmatched'){main.append(el('a',{class:'muted',href:'#view=tv'},'← TV Shows'));return library(main,params);}
  const q=params.get('q')||'',libraryId=params.get('library')||'';
  const form=el('form',{class:'filters'},el('label',{class:'search'},'Search TV shows',el('input',{name:'q',type:'search',value:q,placeholder:'Search your shows…',maxLength:256})),
    select('Library','library',[['','All libraries'],...libraryList.map(l=>[l.id,l.name])],libraryId),el('button',{type:'submit'},'Search'));
  form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));location.hash=href({view:'tv',q:data.q,library:data.library,offset:null,section:null,id:null,season:null});});
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},'TV Shows'),el('p',{class:'muted'},'Browse your shows by season and episode.')),el('a',{class:'muted',href:href({view:'tv',section:'unmatched',q:null,offset:null,id:null,season:null})},'Unmatched TV files →')),form);
  const query=new URLSearchParams({offset:params.get('offset')||'0',limit:'24'});if(q)query.set('q',q);if(libraryId)query.set('library',libraryId);
  const data=await api('/api/shows?'+query);
  const cards=data.items.map(show=>el('a',{class:'video-card movie-card',href:href({view:'show',id:show.id,q:null,offset:null,section:null,season:null})},
    poster({movie:{poster:show.poster}}),el('h3',{},show.name),el('p',{},[show.year,`${show.episodeCount} ${show.episodeCount===1?'episode':'episodes'}`].filter(Boolean).join(' · '))));
  main.append(cards.length?el('div',{class:'grid movie-grid'},cards):el('div',{class:'empty'},'No matched shows found. Check unmatched TV files or try another search.'),paginate(data,params,'shows'));
}
async function showPage(main,params){
  const id=params.get('id'),season=params.get('season'),offset=params.get('offset')||'0',query=new URLSearchParams({offset,limit:'24'});if(season!==null)query.set('season',season);
  const data=await api(`/api/shows/${encodeURIComponent(id)}?${query}`),show=data.show;
  const backdrop=el('div',{class:'movie-backdrop'});if(show.backdrop)backdrop.append(el('img',{src:show.backdrop,alt:''}));
  main.append(el('a',{class:'muted',href:href({view:'tv',id:null,season:null,offset:null},params)},'← TV Shows'),el('div',{class:'movie-panel'},el('div',{class:'movie-hero show-hero'},backdrop,el('div',{class:'movie-hero-content'},poster({movie:{poster:show.poster}}),el('div',{},el('p',{class:'eyebrow'},'TV show'),el('h1',{},show.name),el('p',{class:'movie-meta'},[show.year,`${data.seasons.length} ${data.seasons.length===1?'season':'seasons'}`].filter(Boolean).join(' · ')),show.overview?el('p',{class:'movie-overview'},show.overview):null)))));
  const seasons=el('nav',{class:'season-nav','aria-label':'Seasons'},el('a',{href:href({season:null,offset:null},params),'aria-current':season===null?'page':null},'All episodes'),
    ...data.seasons.map(item=>el('a',{href:href({season:item.number,offset:null},params),'aria-current':String(item.number)===season?'page':null},item.number===0?'Specials':`Season ${item.number}`)));
  main.append(seasons,el('div',{class:'section-heading'},el('h2',{},season===null?'Episodes':season==='0'?'Specials':`Season ${season}`),el('span',{class:'muted'},`${data.total} ${data.total===1?'episode':'episodes'}`)),
    data.items.length?el('div',{class:'grid episode-grid'},[...data.items].sort((a,b)=>(a.episode?.seasonNumber||0)-(b.episode?.seasonNumber||0)||(a.episode?.episodeNumber||0)-(b.episode?.episodeNumber||0)).map(card)):el('div',{class:'empty'},'No episodes in this season.'),paginate(data,params,'episodes'));
  if(data.cast?.length)main.append(castPanel(data,'tv'));
  main.append(movieAttribution());
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
function movieAttribution(){return el('p',{class:'provider-credit'},el('img',{src:'/tmdb-logo.svg',alt:'TMDB',loading:'lazy'}),'This product uses the TMDB API but is not endorsed or certified by TMDB. ',el('a',{href:'https://www.themoviedb.org',target:'_blank',rel:'noopener noreferrer'},'The Movie Database ↗'));}
async function personPage(main,params){
  const id=params.get('id'),offset=Math.max(0,Number(params.get('offset'))||0),data=await api(`/api/people/${encodeURIComponent(id)}?${new URLSearchParams({offset,limit:24})}`);
  main.append(el('a',{class:'muted',href:params.get('from')==='tv'?'#view=tv':'#view=movies'},params.get('from')==='tv'?'← Back to TV shows':'← Back to movies'),el('div',{class:'person-heading'},data.person.profile?el('img',{src:data.person.profile,alt:''}):el('div',{class:'person-placeholder','aria-hidden':true},'◯'),el('div',{},el('p',{class:'eyebrow'},'Cast'),el('h1',{},data.person.name),el('p',{class:'muted'},`${data.total} ${data.total===1?'title':'titles'} in your libraries`))),
    data.items.length?el('div',{class:'grid movie-grid'},data.items.map(card)):el('div',{class:'empty'},'No shared titles for this person.'),paginate(data,params));
}
function moviePanel(v,details,actions){
  const movie=details?.movie||v.movie,panel=el('div',{class:'movie-panel'});
  if(movie){
    const backdrop=el('div',{class:'movie-backdrop'});if(movie.backdrop)backdrop.append(el('img',{src:movie.backdrop,alt:''}));
    panel.append(el('div',{class:'movie-hero'},backdrop,el('div',{class:'movie-hero-content'},poster({...v,movie}),el('div',{},el('p',{class:'eyebrow'},'Movie'),el('h1',{},movie.title),el('p',{class:'movie-meta'},[movie.year,movie.runtime?`${movie.runtime} min`:null,...(movie.genres||[])].filter(Boolean).join(' · ')),movie.tagline?el('p',{class:'movie-tagline'},movie.tagline):null,actions,movie.overview?el('p',{class:'movie-overview'},movie.overview):el('p',{class:'muted'},'No description available.')))));
  }else if(v.library_kind==='movies')panel.append(el('div',{class:'movie-unmatched'},el('h1',{},v.filename),el('p',{class:'muted'},`Movie details ${details?.match?.state==='pending'?'are pending':details?.match?.state==='dismissed'?'were cleared':details?.match?.state==='failed'?'could not be loaded':'were not found'}. You can still play the original.`),actions));
  return panel;
}
function episodePanel(v,details,actions){
  const episode={...v.episode,...(details?.episode||{})},show=details?.show,matched=!!(v.episode||details?.episode),panel=el('div',{class:'movie-panel'}),backdrop=el('div',{class:'movie-backdrop'});
  if(episode.backdrop||show?.backdrop)backdrop.append(el('img',{src:episode.backdrop||show.backdrop,alt:''}));
  const showId=episode.showId||show?.id,showName=episode.showName||show?.name;
  panel.append(el('div',{class:'movie-hero episode-hero'},backdrop,el('div',{class:'movie-hero-content'},
    poster({...v,episode:{...episode,still:null,poster:episode.poster||show?.poster||episode.still}}),el('div',{},el('p',{class:'eyebrow'},matched?'TV episode':'TV file'),
      showName?el('a',{class:'show-link',href:href({view:'show',id:showId,season:null,from:null,fromId:null},new URLSearchParams())},showName):null,
      el('h1',{},episode.title||v.filename),matched?el('p',{class:'movie-meta'},[episode.seasonNumber!=null&&episode.episodeNumber!=null?episodeLabel(episode):null,episode.airDate,episode.runtime?`${episode.runtime} min`:null].filter(Boolean).join(' · ')):null,
      actions,episode.overview?el('p',{class:'movie-overview'},episode.overview):el('p',{class:'muted'},matched?'No episode description available.':'Episode details are unavailable. You can still play the original.')))));
  if(details?.previous||details?.next)panel.append(el('nav',{class:'episode-navigation','aria-label':'Episode navigation'},
    details.previous?el('a',{href:href({view:'video',id:details.previous.id,from:'show',fromId:showId,season:details.previous.seasonNumber},new URLSearchParams())},`← Previous · ${episodeLabel(details.previous)} ${details.previous.title||''}`):null,
    details.next?el('a',{href:href({view:'video',id:details.next.id,from:'show',fromId:showId,season:details.next.seasonNumber},new URLSearchParams())},`Next · ${episodeLabel(details.next)} ${details.next.title||''} →`):null));
  return panel;
}
function castPanel(details,from='movies'){const cast=details?.cast||[];return cast.length?el('section',{class:'cast-section'},el('h2',{},'Cast'),el('div',{class:'cast-grid'},cast.map(person=>el('a',{class:'cast-card',href:href({view:'person',id:person.id,from:from==='tv'?'tv':null},new URLSearchParams())},person.profile?el('img',{src:person.profile,alt:''}):el('span',{class:'cast-placeholder','aria-hidden':true},'◯'),el('strong',{},person.name),el('span',{class:'muted'},person.character||'Cast'))))):null;}
const providerNeeded=what=>account?.role==='owner'?el('span',{},what+' needs a TMDB token. ',el('a',{href:'#view=settings'},'Open Settings')):what+' is unavailable.';
function movieEditor(v,initial){
  const panel=el('section',{class:'movie-editor'},el('h2',{},'Movie match')),status=el('p',{class:'muted','aria-live':'polite'}),results=el('div',{class:'match-results'});
  let details=initial;
  const update=next=>{details=next;status.textContent=`Match: ${next?.match?.state||'pending'}.`;};update(initial);
  const query=el('input',{type:'search',name:'q',maxLength:200,required:true,value:v.movie?.title||v.filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' '),'aria-label':'Movie title'}),year=el('input',{type:'number',name:'year',min:1878,max:new Date().getUTCFullYear()+2,placeholder:'Year',value:v.movie?.year||'','aria-label':'Release year'}),search=el('button',{type:'submit'},'Search matches');
  const form=el('form',{class:'inline-form'},query,year,search);
  const save=async data=>{const next=await api(`/api/videos/${v.id}/movie`,{...data,revision:v.revision});update(next);toast('Movie match updated.');await render();};
  if(!features.metadata){panel.append(el('p',{class:'muted'},providerNeeded('TMDB movie matching')),button('Clear movie match',()=>save({tmdbId:null})));return panel;}
  form.addEventListener('submit',event=>{event.preventDefault();void action(search,async()=>{
    const params=new URLSearchParams({q:query.value.trim()});if(year.value)params.set('year',year.value);
    const response=await api(`/api/videos/${v.id}/movie/search?${params}`);results.replaceChildren();
    const items=response.items||[];results.append(...(items.length?items.map(item=>el('div',{class:'match-result'},el('div',{},el('strong',{},item.title),el('p',{class:'muted'},[item.year,item.overview].filter(Boolean).join(' · '))),button('Select',()=>save({tmdbId:item.id})))):[el('p',{class:'muted'},'No matches found. Try a different title or year.')]));
  });});
  panel.append(status,form,results,el('div',{class:'actions'},button('Retry automatic match',()=>save({auto:true})),button('Clear movie match',()=>save({tmdbId:null}))));
  return panel;
}
function episodeEditor(v,initial){
  const panel=el('section',{class:'movie-editor'},el('h2',{},'Episode match')),status=el('p',{class:'muted','aria-live':'polite'}),results=el('div',{class:'match-results'});
  let details=initial;const update=next=>{details=next;status.textContent=`Match: ${next?.match?.state||'pending'}.`;};update(initial);
  const base=v.filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' '),guessed=/(?:^|[^A-Za-z0-9])(?:S(\d{1,2})E(\d{1,3})|(\d{1,2})x(\d{1,3}))(?![A-Za-z0-9])/i.exec(base);
  const query=el('input',{type:'search',name:'q',maxLength:200,required:true,value:v.episode?.showName||(guessed?base.slice(0,guessed.index).trim():base)||v.parent?.split('/').filter(Boolean).at(-1)||base,'aria-label':'Show title'}),
    year=el('input',{type:'number',name:'year',min:1878,max:new Date().getUTCFullYear()+2,placeholder:'Year',value:v.episode?.showYear||'','aria-label':'Show year'}),
    season=el('input',{type:'number',name:'season',min:0,max:999,required:true,value:v.episode?.seasonNumber??(guessed?String(Number(guessed[1]??guessed[3])):''),'aria-label':'Season number'}),
    episode=el('input',{type:'number',name:'episode',min:1,max:1000,required:true,value:v.episode?.episodeNumber??(guessed?String(Number(guessed[2]??guessed[4])):''),'aria-label':'Episode number'}),search=el('button',{type:'submit'},'Search shows');
  const save=async data=>{const next=await api(`/api/videos/${v.id}/episode`,{...data,revision:v.revision});update(next);toast('Episode match updated.');await render();};
  if(!features.metadata){panel.append(status,el('p',{class:'muted'},providerNeeded('TMDB episode matching')),button('Clear episode match',()=>save({tmdbId:null})));return panel;}
  const form=el('form',{class:'inline-form'},query,year,season,episode,search);
  form.addEventListener('submit',event=>{event.preventDefault();void action(search,async()=>{
    const params=new URLSearchParams({q:query.value.trim()});if(year.value)params.set('year',year.value);
    const response=await api(`/api/videos/${v.id}/episode/search?${params}`);results.replaceChildren();
    const items=response.items||[];results.append(...(items.length?items.map(item=>el('div',{class:'match-result'},el('div',{},el('strong',{},item.title),el('p',{class:'muted'},[item.year,item.overview].filter(Boolean).join(' · '))),button('Select',()=>{
      const s=season.value.trim(),e=episode.value.trim();
      if(!/^\d{1,3}$/.test(s)||!/^\d{1,4}$/.test(e)||Number(s)>999||Number(e)<1||Number(e)>1000)throw new Error('Enter a valid season and episode number.');
      return save({tmdbId:item.id,season:Number(s),episode:Number(e)});
    }))):[el('p',{class:'muted'},'No shows found. Try another title or year.')]));
  });});
  panel.append(status,form,results,el('div',{class:'actions'},button('Retry automatic match',()=>save({auto:true})),button('Clear episode match',()=>save({tmdbId:null}))));
  return panel;
}
async function videoPage(main,params){
  const back=href({view:params.get('from')||'library',id:['person','show'].includes(params.get('from'))?params.get('fromId'):null,from:null,fromId:null},params);
  const content=el('div',{class:'details'},el('a',{class:'muted',href:back},'← Back'),el('div',{class:'detail-media'},el('div',{class:'poster loading'})));
  main.append(content);
  const v=await api('/api/videos/'+encodeURIComponent(params.get('id'))),currentEpoch=epoch,uid=account.id;
  const needsMovie=!!v.movie||!v.episode&&(v.library_kind==='movies'||account.role==='owner'&&v.library_kind!=='tv'),needsEpisode=!!v.episode||!v.movie&&(v.library_kind==='tv'||account.role==='owner'&&v.library_kind!=='movies');
  const [movieResult,episodeResult,subtitleResult]=await Promise.allSettled([needsMovie?api(`/api/videos/${v.id}/movie`):Promise.resolve(null),needsEpisode?api(`/api/videos/${v.id}/episode`):Promise.resolve(null),v.available?api(`/api/videos/${v.id}/subtitles`):Promise.resolve({items:[],configured:false})]);
  if(currentEpoch!==epoch)return;
  const movieDetails=movieResult.status==='fulfilled'?movieResult.value:null,episodeDetails=episodeResult.status==='fulfilled'?episodeResult.value:null,subtitles=subtitleResult.status==='fulfilled'?subtitleResult.value:{items:[],configured:false};
  const media=el('div',{class:'detail-media'},poster(v)),diagnostic=el('div',{'aria-live':'polite'});
  const isMovie=!!(v.movie||movieDetails?.movie)||!v.episode&&!episodeDetails?.episode&&v.library_kind==='movies',isEpisode=!isMovie&&(!!v.episode||!!episodeDetails?.episode||v.library_kind==='tv');
  if(isMovie||isEpisode)media.hidden=true;
  let subtitleItems=subtitles.items||[],subtitleSelection=subtitleItems.find(item=>item.language?.toLowerCase().split('-')[0]===(typeof navigator==='undefined'?'':navigator.language.toLowerCase().split('-')[0]))?.id||'',subtitleSelect=null,subtitleTouched=false;
  function setTrackMode(video){for(const track of video.textTracks||[])track.mode=String(track.id)===String(subtitleSelection)?'showing':'disabled';}
  function syncTracks(video){
    for(const old of video.querySelectorAll?.('track')||[])old.remove();
    for(const item of subtitleItems){const track=el('track',{id:item.id,kind:'subtitles',src:item.url,srclang:item.language,label:item.label||item.release||item.language});track.default=String(item.id)===String(subtitleSelection);video.append(track);}
    if(subtitleSelect){subtitleSelect.replaceChildren(el('option',{value:''},'Off'),...subtitleItems.map(item=>el('option',{value:item.id},`${item.language.toUpperCase()} · ${item.label||item.release||'Subtitle'}`)));subtitleSelect.value=String(subtitleSelection);}
    setTrackMode(video);
  }
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
    const video=el('video',{controls:true,playsInline:true,preload:'metadata',poster:v.movie?.backdrop||v.episode?.still||v.episode?.backdrop||v.poster||'',src:`/api/videos/${v.id}/media?r=${v.revision.slice(0,16)}`});player=video;
    video.addEventListener('loadedmetadata',()=>{if(currentEpoch!==epoch||player!==video)return;if(session.position>0)video.currentTime=Math.min(session.position,Number.isFinite(video.duration)?video.duration:session.position);setTrackMode(video);video.play().catch(()=>{});},{once:true});
    video.addEventListener('timeupdate',()=>{if(!video.paused&&Date.now()-lastSave>=15000)void save(false,video);});
    video.addEventListener('pause',()=>void save(false,video));video.addEventListener('ended',()=>void save(true,video));video.addEventListener('error',()=>{if(player===video)void diagnose();});
    const speed=select('Playback speed','speed',[['0.5','0.5×'],['0.75','0.75×'],['1','1×'],['1.25','1.25×'],['1.5','1.5×'],['2','2×']],'1');speed.querySelector('select').addEventListener('change',e=>{video.playbackRate=Number(e.target.value);});
    const subtitleControl=select('Subtitles','subtitles',[['','Off']],'');subtitleSelect=subtitleControl.querySelector('select');subtitleSelect.addEventListener('change',e=>{subtitleSelection=e.target.value;subtitleTouched=true;setTrackMode(video);});syncTracks(video);
    media.replaceChildren(video,el('div',{class:'actions player-controls'},speed,subtitleControl));media.hidden=false;media.scrollIntoView?.({behavior:'smooth',block:'nearest'});diagnostic.replaceChildren();
  }
  const favorite=button(v.favorite?'★ Favorited':'☆ Favorite',async()=>{await api(`/api/videos/${v.id}/favorite`,{favorite:!v.favorite},uid);v.favorite=!v.favorite;favorite.textContent=v.favorite?'★ Favorited':'☆ Favorite';});
  const watched=button(v.watched?'Mark unwatched':'Mark watched',async()=>{await api(`/api/videos/${v.id}/watched`,{watched:!v.watched,revision:v.revision},uid);v.watched=!v.watched;session=null;watched.textContent=v.watched?'Mark unwatched':'Mark watched';});
  const playbackActions=el('div',{class:'actions'},v.available?button(v.position>0&&!v.watched?`Resume ${duration(v.position)}`:'Play original',()=>start(false),true):el('span',{class:'error'},'Original unavailable'),v.available?button('Start over',()=>start(true)):null,favorite,watched);
  const fileTitle=el('div',{class:'file-title'},el('p',{class:'eyebrow'},isMovie||isEpisode?'Original file':'Video'),el(isMovie||isEpisode?'h2':'h1',{},v.filename),el('p',{class:'muted'},v.library_name+' / '+v.path));
  content.replaceChildren();content.append(el('a',{class:'muted',href:back},'← Back'));
  if(isMovie)content.append(moviePanel(v,movieDetails,playbackActions),media);
  else if(isEpisode)content.append(episodePanel(v,episodeDetails,playbackActions),media);
  if(isMovie&&movieDetails?.cast?.length)content.append(castPanel(movieDetails));
  if(isEpisode&&episodeDetails?.cast?.length)content.append(castPanel(episodeDetails,'tv'));
  content.append(fileTitle);if(!isMovie&&!isEpisode)content.append(media,playbackActions);content.append(diagnostic);
  if(needsMovie&&movieResult.status==='rejected'&&movieResult.reason.name!=='AbortError')content.append(el('p',{class:'error'},'Movie details could not load. ',movieResult.reason.message||''));
  if(needsEpisode&&episodeResult.status==='rejected'&&episodeResult.reason.name!=='AbortError')content.append(el('p',{class:'error'},'Episode details could not load. ',episodeResult.reason.message||''));
  content.append(
    el('p',{class:'muted'},'Original playback depends on this browser and device. No automatic transcoding.'),
    el('dl',{class:'facts'},[['Duration',duration(v.duration)],['File size',size(v.bytes)],['Source modified',date(v.modified)],['First discovered',date(v.first_seen)],['Dimensions',v.width&&v.height?`${v.width} × ${v.height}`:'Unknown'],['Container',v.container||'Unknown'],['Video codec',v.video_codec||'Unknown'],['Audio codec',v.audio_codec||'Unknown'],['Processing',v.enrichment+(v.processing_error?' · '+v.processing_error.replaceAll('_',' '):'')]].map(([k,val])=>el('div',{},el('dt',{},k),el('dd',{},val)))));
  if(account.role==='owner'){if(!isEpisode)content.append(movieEditor(v,movieDetails));if(!isMovie)content.append(episodeEditor(v,episodeDetails));}
  if(isMovie||isEpisode)content.append(movieAttribution());
  const subtitlePanel=el('section',{class:'subtitle-panel'},el('h2',{},'Subtitles')),imported=el('div',{class:'subtitle-imported'}),subtitleStatus=el('p',{class:'muted','aria-live':'polite'});
  function showImported(){imported.replaceChildren(subtitleItems.length?el('ul',{},subtitleItems.map(item=>el('li',{},`${item.language.toUpperCase()} · ${item.label||item.release||'Subtitle'}`))):el('p',{class:'muted'},'No imported subtitles yet.'));}
  showImported();subtitlePanel.append(imported,subtitleStatus);
  if(subtitleResult.status==='rejected'&&subtitleResult.reason.name!=='AbortError')subtitleStatus.textContent='Could not load imported subtitles.';
  if(subtitles.configured){
    const subtitleTitle=episodeDetails?.show?.name||v.episode?.showName||movieDetails?.movie?.title||v.filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' ');
    const query=el('input',{type:'search',name:'q',value:subtitleTitle,maxLength:200,required:true,'aria-label':'Subtitle title'}),language=el('input',{name:'language',value:(typeof navigator==='undefined'?'en':navigator.language.split('-')[0]||'en').toLowerCase(),maxLength:20,required:true,'aria-label':'Subtitle language code'}),search=el('button',{type:'submit'},'Search subtitles'),results=el('div',{class:'subtitle-results'});
    const form=el('form',{class:'inline-form'},query,language,search);form.addEventListener('submit',event=>{event.preventDefault();void action(search,async()=>{
      subtitleStatus.textContent='Searching subtitles…';results.replaceChildren();
      const searchParams=new URLSearchParams({language:language.value.trim()});
      if(!((movieDetails?.movie||episodeDetails?.episode||v.episode)&&query.value.trim()===subtitleTitle))searchParams.set('q',query.value.trim());
      let found;try{found=await api(`/api/videos/${v.id}/subtitles/search?${searchParams}`);}catch(error){subtitleStatus.textContent=error.message||'Subtitle search failed.';throw error;}
      subtitleStatus.textContent=found.items?.length?`${found.items.length} subtitle results.`:'No subtitles found.';
      results.replaceChildren(...(found.items||[]).map(item=>el('div',{class:'subtitle-result'},el('div',{},el('strong',{},item.release||item.label),el('p',{class:'muted'},`${item.language.toUpperCase()}${item.hearingImpaired?' · Hearing impaired':''}${item.downloads?' · '+item.downloads+' downloads':''}`)),button('Import',async()=>{
        try{const track=await api(`/api/videos/${v.id}/subtitles`,{revision:v.revision,fileId:item.fileId,language:item.language,label:item.release||item.label});
          if(!subtitleItems.some(existing=>existing.id===track.id))subtitleItems.push(track);
          if(!subtitleTouched&&!subtitleSelection&&track.language.toLowerCase().split('-')[0]===(typeof navigator==='undefined'?'':navigator.language.toLowerCase().split('-')[0]))subtitleSelection=track.id;
          showImported();if(player)syncTracks(player);subtitleStatus.textContent='Subtitle imported and ready.';
        }catch(error){subtitleStatus.textContent=error.message||'Subtitle import failed.';throw error;}
      }))));
    });});subtitlePanel.append(form,results);
  }else subtitlePanel.append(el('p',{class:'muted'},'Subtitle search and downloads need OpenSubtitles configuration. Imported tracks remain available. ',el('a',{href:'https://www.opensubtitles.com',target:'_blank',rel:'noopener noreferrer'},'OpenSubtitles ↗')));
  content.append(subtitlePanel);
  flush=()=>void save(player?.ended||false,player,true);
  cleanup=(saveProgress=false)=>{if(saveProgress)flush();saveEnabled=false;session=null;};
}
function table(headers,rows){return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},headers.map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows.map(row=>el('tr',{},row.map(cell=>el('td',{},cell)))))));}
const providerLabels={tmdb:'TMDB',opensubtitles:'OpenSubtitles'},providerFields={tmdb:[['token','Read access token',true,4096]],opensubtitles:[['apiKey','API key',true,1024],['username','Username',false,254],['password','Password',true,1024]]};
// Disconnect stays available without editable storage so an unreadable saved record can still be removed.
const canDisconnect=p=>p.configured||p.source==='settings'||p.source==='deployment';
function providerStatus(p){
  const words=code=>String(code||'error').replaceAll('_',' '),origin={settings:'saved credentials',deployment:'deployment configuration',disabled:'deployment configuration turned off',none:'not set up'}[p.source]||'not set up';
  // Error comes first: an unreadable saved record is configured:false but must show its failure, not a plain Disconnected.
  const status=p.status==='error'?'Connection problem ('+words(p.error)+')':!p.configured?'Disconnected':p.status==='connected'?'Connected':p.status==='configured'?'Configured, not yet tested':'Disconnected';
  return `${status} · ${origin}${p.lastChecked?' · checked '+date(p.lastChecked):''}`;
}
// Credentials flow one way: inputs -> POST. Nothing from the API is ever written back into a field.
function providerCard(name,p,editable,run,lock,note=''){
  const message=el('p',{class:'provider-message','aria-live':'polite'},note),inputs={};
  // Editing saved credentials may leave fields empty to keep stored values; any other state needs every field.
  const keepable=p.configured&&p.source==='settings',form=el('form',{class:'inline-form provider-form',autocomplete:'off'});
  for(const [key,label,secret,max] of providerFields[name]){
    inputs[key]=el('input',{type:secret?'password':'text',autocomplete:secret?'new-password':'off',autocapitalize:'off',spellcheck:false,maxLength:max,disabled:!editable,required:!keepable});
    form.append(el('label',{},label,inputs[key]));
  }
  const save=el('button',{type:'submit',class:'primary',disabled:!editable},'Save and test connection');
  const test=el('button',{type:'button',disabled:!editable||!p.configured},'Test connection'),off=el('button',{type:'button',disabled:!canDisconnect(p)},p.source==='deployment'?'Turn off deployment configuration':'Disconnect');
  for(const b of [save,test,off,...Object.values(inputs)])lock.add(b);
  const say=(text,bad)=>{message.textContent=text;message.className='provider-message'+(bad?' provider-error':'');};
  const send=(act,credentials,done)=>run(name,act,credentials,done,say);
  form.addEventListener('submit',event=>{
    event.preventDefault();const credentials={};for(const key of Object.keys(inputs))if(inputs[key].value!=='')credentials[key]=inputs[key].value;
    if(!Object.keys(credentials).length)return say('Enter credentials to save.',true);
    if(!keepable&&Object.keys(credentials).length<providerFields[name].length)return say('Enter every field to connect '+providerLabels[name]+'.',true);
    void send('save',credentials,'Saved and connected.');
  });
  test.addEventListener('click',()=>void send('test',undefined,'Connection verified.'));
  off.addEventListener('click',()=>void send('disconnect',undefined,'Disconnected. Enter new credentials to reconnect.'));
  form.append(save);
  const node=el('div',{class:'provider-card'},el('h3',{},providerLabels[name]),el('p',{class:'status'},providerStatus(p)),
    el('p',{class:'muted'},keepable?'Leave a field empty to keep its stored value. Stored values are never shown.':'Enter every field to connect. Saved values are never shown.'),form,el('div',{class:'actions'},test,off),message);
  node.inputs=inputs;node.controls=[save,test,off,...Object.values(inputs)];return node;
}
function providerSettings(data){
  const section=el('section',{class:'providers'},el('h2',{},'Metadata and subtitle providers')),cards=el('div',{class:'provider-grid'}),names=['tmdb','opensubtitles'],nodes={};
  let state=data.providers,busy=false;const lock=new Set();
  // Whole-section lock: one provider mutation at a time, so a double click cannot repeat a save or race a disconnect.
  const setBusy=value=>{busy=value;for(const b of lock)b.disabled=value||b.keepDisabled;};
  // Only the affected card is rebuilt, so the other provider's unsaved draft stays in the DOM.
  const draw=(name,note,keepDraft)=>{
    const old=nodes[name],fresh=providerCard(name,state[name],state.editable===true,run,lock,note);
    if(old){for(const b of old.controls)lock.delete(b);if(keepDraft)for(const k of Object.keys(old.inputs))fresh.inputs[k].value=old.inputs[k].value;old.replaceWith(fresh);}
    nodes[name]=fresh;for(const b of fresh.controls)b.keepDisabled=b.disabled;return fresh;
  };
  async function run(name,act,credentials,done,say){
    // Re-check here because handlers can fire even when the buttons are disabled; the backend stays authoritative.
    const p=state[name];if(busy||(act==='disconnect'?!canDisconnect(p):state.editable!==true||act==='test'&&!p.configured))return;
    setBusy(true);say('Working…');
    try{
      const result=await api('/api/admin/providers',credentials?{provider:name,action:act,credentials}:{provider:name,action:act});
      state=result.providers;features.metadata=!!state.tmdb?.configured;features.subtitles=!!state.opensubtitles?.configured;draw(name,done,act==='test');
    }catch(error){if(error.name==='AbortError')return;say((error.message||'Could not update provider.').replaceAll('_',' '),true);}
    finally{setBusy(false);}
  }
  for(const name of names){draw(name,'');cards.append(nodes[name]);}
  section.append(...[el('p',{class:'muted'},'TMDB provides movie and TV metadata. OpenSubtitles provides subtitle search and downloads. Only the owner can change these.'),
    state.editable===true?null:el('p',{class:'muted provider-message'},'Saving and testing are unavailable until secure storage is ready. An existing provider can still be disconnected.'),
    cards,movieAttribution(),el('p',{class:'muted'},'Subtitle data provided by ',el('a',{href:'https://www.opensubtitles.com',target:'_blank',rel:'noopener noreferrer'},'OpenSubtitles ↗'))].filter(Boolean));
  return section;
}
async function settings(main){
  const data=await api('/api/admin');main.classList.add('settings');
  main.append(el('div',{class:'page-title'},el('div',{},el('h1',{},'Settings'),el('p',{class:'muted'},'Connect, share, and keep your catalog up to date.'))));
  async function change(path,payload){await api('/api/admin/'+path,payload);libraryList=(await api('/api/libraries')).items;await render();}
  const source=el('section',{},el('h2',{},'Source connection'),el('p',{class:'muted'},'Existing bucket: ',el('code',{},data.source.bucket)),
    el('p',{class:'muted'},data.source.configured?'Source credentials configured. Validate list, read, and poster storage access.':'Add read-only R2 source credentials through deployment configuration.'),
    el('div',{class:'actions'},button('Validate connection',async()=>{const result=await api('/api/admin/validate',{});toast('Connection verified. Original read: '+result.read);})));
  const libs=el('section',{},el('h2',{},'Libraries & sharing boundaries'),el('p',{class:'muted'},'Use an exact folder prefix ending in /. Leave it empty for the whole bucket. Overlapping libraries are not allowed.'),
    table(['Library / prefix','Catalog','Schedule','Actions'],data.libraries.map(l=>[
      el('div',{},el('strong',{},l.name),el('p',{},el('code',{},l.prefix||'(whole bucket)')),el('span',{class:'status'},`${l.kind==='movies'?'Movies':l.kind==='tv'?'TV shows':'Videos'} · ${l.frozen?'Scope frozen':'Not scanned'}`)),
      `${l.discovered} discovered · ${l.enriched} enriched · ${l.pending} pending · ${l.failed} failed · ${l.missing} missing`,
      el('div',{},l.paused?'Paused':l.frozen?'Daily scan enabled':'Start the first scan to enable daily refresh',el('p',{class:'muted'},'Last success: '+date(l.last_success))),
      el('div',{class:'actions'},button('Start scan',()=>change('scan',{libraryId:l.id,action:'start'})),button(l.paused?'Resume':'Pause',()=>change('scan',{libraryId:l.id,action:l.paused?'resume':'pause'})),button('Retry failed',()=>change('retry',{libraryId:l.id})),button(l.enabled?'Disable':'Enable',()=>change('libraries',{id:l.id,name:l.name,prefix:l.prefix,kind:l.kind||'videos',enabled:!l.enabled})),button('Edit',()=>{name.value=l.name;path.value=l.prefix;kind.value=l.kind||'videos';editing=l.id;editingEnabled=!!l.enabled;path.disabled=!!l.frozen;submit.textContent='Save library';form.scrollIntoView({behavior:'smooth',block:'center'});name.focus();})),
    ])));
  let editing=null,editingEnabled=true;
  const name=el('input',{name:'name',required:true,maxLength:100,placeholder:'Family videos'}),path=el('input',{name:'prefix',maxLength:1024,placeholder:'family/'}),kind=el('select',{name:'kind','aria-label':'Library type'},el('option',{value:'videos'},'Videos'),el('option',{value:'movies'},'Movies'),el('option',{value:'tv'},'TV shows')),preview=el('p',{},'Boundary preview: the whole bucket; this prevents any nested library.'),submit=el('button',{type:'submit',class:'primary'},'Add library');
  path.addEventListener('input',()=>{preview.textContent=path.value?`Boundary preview: only objects inside ${path.value}; sibling prefixes stay outside this library.`:'Boundary preview: the whole bucket; this prevents any nested library.';});
  const form=el('form',{class:'inline-form'},el('label',{},'Library name',name),el('label',{},'Exact bucket prefix',path),el('label',{},'Library type',kind),submit,preview);
  form.addEventListener('submit',event=>{event.preventDefault();void action(submit,()=>change('libraries',{id:editing,name:name.value,prefix:path.value,kind:kind.value,enabled:editing?editingEnabled:true}));});libs.append(form);
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
  const providers=el('section',{},el('h2',{},'Metadata and subtitle providers'),el('p',{class:'muted'},`TMDB movie and TV metadata ${data.features?.metadata?'is configured.':'needs setup.'} OpenSubtitles search and downloads ${data.features?.subtitles?'are configured.':'need deployment configuration.'}`),movieAttribution(),el('p',{class:'muted'},'Subtitle data provided by ',el('a',{href:'https://www.opensubtitles.com',target:'_blank',rel:'noopener noreferrer'},'OpenSubtitles ↗')));
  main.append(source,libs,account?.role==='owner'&&data.providers?providerSettings(data):providers,users,scans,operations);
}
async function render(){
  if(!account)return;
  if(routeKey)scrolls.set(routeKey,window.scrollY);const saved=scrolls.get(location.hash)||0;routeKey=location.hash;
  cleanup(true);cleanup=flush=()=>{};epoch++;for(const c of pending)c.abort();pending.clear();if(player){player.pause();player.removeAttribute('src');player.load();player=null;}
  const generation=epoch,params=route(),view=params.get('view')||'library',main=shell(view);
  main.setAttribute('aria-busy','true');if(!saved)window.scrollTo(0,0);
  try{if(view==='video')await videoPage(main,params);else if(view==='show')await showPage(main,params);else if(view==='tv')await tvPage(main,params);else if(view==='person')await personPage(main,params);else if(view==='folders')await folderPage(main,params);else if(view==='settings')await settings(main);else await library(main,params);if(epoch===generation&&saved)window.scrollTo(0,saved);}
  catch(error){if(error.name!=='AbortError'&&epoch===generation)main.append(errorBox(error));}
  finally{main.removeAttribute('aria-busy');}
}
async function boot(){
  clearPrivate();const generation=epoch;
  root.append(el('main',{id:'main'},el('p',{class:'empty',role:'status'},'Signing in to your library…')));
  try{const [session,libs]=await Promise.all([api('/api/session'),api('/api/libraries')]);if(generation!==epoch)return;account=session.user;features=session.features||{};local=session.local;channel?.postMessage({type:'identity',id:account.id});libraryList=libs.items;await render();}
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
