import {AwsClient} from 'aws4fetch';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {fail, Problem, revision} from './core.js';
const parser = new XMLParser({parseTagValue:false, ignoreAttributes:true, processEntities:true});
const decode = value => decodeURIComponent(value || '');
const timestamp = value => new Date(Math.floor(new Date(value).getTime()/1000)*1000).toISOString();
// The source contract deliberately exposes no write, delete, rename, or copy operation.
export class R2Source {
  constructor(env) {
    this.env = env;
    if (!env.SOURCE_ACCESS_KEY_ID || !env.SOURCE_SECRET_ACCESS_KEY) fail(503,'source_not_configured');
    const endpoint = new URL(env.SOURCE_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') || endpoint.pathname !== '/') fail(503,'invalid_source_endpoint');
    this.base = `${endpoint.origin}/${encodeURIComponent(env.SOURCE_BUCKET)}`;
    this.client = new AwsClient({accessKeyId:env.SOURCE_ACCESS_KEY_ID,secretAccessKey:env.SOURCE_SECRET_ACCESS_KEY,service:'s3',region:'auto',retries:0});
  }
  url(key) {
    if (!key.startsWith(this.env.SOURCE_SCOPE || '')) fail(403,'source_scope');
    // WHATWG URLs normalize dot segments: refuse such requests instead of reading another key.
    if (key.split('/').some(p => p === '.' || p === '..')) fail(422,'unsupported_key_path');
    return `${this.base}/${key.split('/').map(p=>encodeURIComponent(p).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
  }
  async request(url, options = {}) {
    try { return await this.client.fetch(url,{...options,redirect:'manual',signal:options.signal || AbortSignal.timeout(15000)}); }
    catch { throw new Problem(502,'source_network','Storage did not respond.'); }
  }
  async list(prefix, cursor = null, limit = 50) {
    if (!prefix.startsWith(this.env.SOURCE_SCOPE || '')) fail(403,'source_scope');
    const url = new URL(this.base); url.search = new URLSearchParams({'list-type':'2','encoding-type':'url',prefix,'max-keys':String(limit),...(cursor ? {'continuation-token':cursor} : {})}).toString();
    const response = await this.request(url);
    const text = await response.text();
    if (response.status===429 || response.status>=500) fail(502,'source_network');
    if (response.status === 400 && cursor && /Invalid(Token|Argument)|InvalidContinuationToken/.test(text)) fail(409,'invalid_cursor');
    if (!response.ok) fail(502,'source_permission_or_service','Storage listing failed. Check the read-only source connection.');
    if (XMLValidator.validate(text) !== true) fail(502,'invalid_listing');
    const page = parser.parse(text).ListBucketResult;
    if (!page || !['true','false'].includes(page.IsTruncated)) fail(502,'invalid_listing');
    const contents = page.Contents ? (Array.isArray(page.Contents) ? page.Contents : [page.Contents]) : [];
    const objects = contents.map(o=>({key:decode(o.Key),bytes:Number(o.Size),modified:timestamp(o.LastModified),etag:o.ETag}));
    if (objects.some(o=>!o.key.startsWith(prefix) || !Number.isSafeInteger(o.bytes) || o.bytes<0 || !o.etag)) fail(502,'invalid_listing');
    if (page.IsTruncated === 'true' && !page.NextContinuationToken) fail(502,'missing_cursor');
    return {objects,cursor:page.IsTruncated === 'true' ? page.NextContinuationToken : null};
  }
  async head(key) {
    const r = await this.request(this.url(key),{method:'HEAD'});
    if (r.status === 404) return null;
    if (r.status===429 || r.status>=500) fail(502,'source_network');
    if (!r.ok) fail(502,'source_metadata_failed');
    const result = {key,bytes:Number(r.headers.get('Content-Length')),etag:r.headers.get('ETag'),modified:timestamp(r.headers.get('Last-Modified')),type:r.headers.get('Content-Type')};
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || !result.etag) fail(502,'invalid_source_metadata');
    return result;
  }
  async open(key, range, etag, signal) {
    return this.request(this.url(key),{headers:{'If-Match':etag,...(range?{'Range':`bytes=${range.start}-${range.end}`}:{})},signal});
  }
  async access(key, etag, range, seconds = 60) {
    const url = new URL(this.url(key)); url.searchParams.set('X-Amz-Expires',String(seconds));
    const headers = {'If-Match':etag,Range:`bytes=${range.start}-${range.end}`};
    const signed = await this.client.sign(url,{method:'GET',headers,aws:{signQuery:true,allHeaders:true}});
    return {url:signed.url,headers,expires:Date.now()+seconds*1000};
  }
}
export async function current(source, video) {
  const object = await source.head(video.object_key);
  if (!object) fail(410,'unavailable','The original is no longer available.');
  if (await revision(object) !== video.revision) fail(409,'source_changed','The original changed. Refresh its catalog before playing.');
  return object;
}
