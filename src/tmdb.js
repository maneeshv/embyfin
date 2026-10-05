import {fail,number} from '#src/core.js';

export const clean=(value,max=1000)=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,' ').slice(0,max):'';
export const imagePath=value=>typeof value==='string'&&/^\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/i.test(value)?value:null;
export const tmdbId=value=>{if(!Number.isInteger(value))fail(400,'invalid_number');return number(value,1,2147483647);};

async function bounded(response,max) {
  const reader=response.body?.getReader();if(!reader)fail(502,'metadata_unavailable');
  const parts=[];let size=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)fail(502,'metadata_too_large');parts.push(value);}
  } finally {await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}

export async function tmdb(env,endpoint,params={}) {
  if(!env.TMDB_READ_TOKEN)fail(503,'movie_metadata_not_configured');
  const url=new URL('https://api.themoviedb.org/3'+endpoint);
  for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  let response;
  try {response=await fetch(url,{headers:{Authorization:`Bearer ${env.TMDB_READ_TOKEN}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000)});}
  catch {fail(502,'metadata_unavailable');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail(response.status===404?404:502,response.status===404?'movie_not_found':'metadata_unavailable');}
  try {
    const data=JSON.parse(new TextDecoder().decode(await bounded(response,1024*1024)));
    if(!data||typeof data!=='object'||Array.isArray(data))fail(502,'metadata_invalid');
    return data;
  } catch(error){if(error.status)throw error;fail(502,'metadata_invalid');}
}

export async function fetchArtwork(value,kind) {
  if(!imagePath(value))fail(404,'not_found');
  const size=kind==='backdrop'?'w780':kind==='poster'||kind==='still'?'w500':'w185';
  let response;
  try {response=await fetch(`https://image.tmdb.org/t/p/${size}${value}`,{redirect:'manual',signal:AbortSignal.timeout(8000)});}
  catch {fail(502,'image_unavailable');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail(502,'image_unavailable');}
  const contentType=response.headers.get('Content-Type')||'';
  if(!/^image\/(jpeg|png|webp)(?:;|$)/i.test(contentType))fail(502,'image_invalid');
  return new Response(await bounded(response,5*1024*1024),{headers:{'Content-Type':contentType,'Cache-Control':'private, max-age=86400'}});
}
