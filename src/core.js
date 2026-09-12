import fold from './casefold.js';

export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export class Problem extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new Problem(status, code, message); };
export const sql = (db, text, ...values) => db.prepare(text).bind(...values);
export const all = async (db, text, ...values) => (await sql(db, text, ...values).all()).results;
export const one = (db, text, ...values) => sql(db, text, ...values).first();
export const run = (db, text, ...values) => sql(db, text, ...values).run();
export function json(value, status = 200) { return Response.json(value, {status}); }
export function string(value, max = 1024, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u001f]/u.test(value)) fail(400, 'invalid_input');
  return value;
}
export function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400, 'invalid_number');
  return value;
}
export function boolean(value) { if (typeof value !== 'boolean') fail(400, 'invalid_boolean'); return +value; }
export async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'json_required');
  const reader = request.body?.getReader(); let bytes = 0, parts = [];
  if (!reader) fail(400, 'invalid_json');
  for (;;) {
    const {done, value} = await reader.read(); if (done) break;
    bytes += value.length; if (bytes > 8192) { await reader.cancel(); fail(413, 'input_too_large'); }
    parts.push(value);
  }
  try { const value = JSON.parse(await new Blob(parts).text()); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
  catch { fail(400, 'invalid_json'); }
}
export function prefix(value, scope = '') {
  string(value, 1024, true);
  if ((value && !value.endsWith('/')) || !value.startsWith(scope)) fail(400, 'invalid_prefix', 'Use the bucket root or an exact folder prefix ending in /.');
  return value;
}
export const normalize = value => [...value.normalize('NFC')].map(c => fold[c] ?? c.toLowerCase()).join('').normalize('NFC');
export const literal = value => normalize(value).replace(/[\\%_]/g, '\\$&');
export async function revision(object) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([object.key, object.bytes, object.modified, object.etag])));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
// Reject malformed/multiple ranges consistently; never silently read a full large object.
export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) fail(416, 'invalid_range');
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) fail(416, 'invalid_range'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) fail(416, 'invalid_range');
  return {start, end: Math.min(size - 1, end)};
}
export const mime = name => ({mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',webm:'video/webm',ogv:'video/ogg',mkv:'video/x-matroska'})[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
export function protect(response) {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries({
    'Cache-Control':'private, no-store', 'Vary':'Cookie, Cf-Access-Jwt-Assertion',
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  })) result.headers.set(key, value);
  return result;
}
