import {createRemoteJWKSet, jwtVerify, SignJWT} from 'jose';
import {fail, id, now, one, run} from './core.js';
const keys = new Map();
export async function identity(request, env) {
  if (!env.ACCESS_ISSUER?.startsWith('https://') || !env.ACCESS_AUD) fail(503, 'identity_not_configured');
  let jwks = keys.get(env.ACCESS_ISSUER);
  if (!jwks) { jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', env.ACCESS_ISSUER)); keys.set(env.ACCESS_ISSUER, jwks); }
  try {
    const {payload} = await jwtVerify(request.headers.get('Cf-Access-Jwt-Assertion') || '', jwks, {
      issuer:env.ACCESS_ISSUER, audience:env.ACCESS_AUD, algorithms:['RS256'], requiredClaims:['exp','sub','email'],
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub || payload.email_verified === false) fail(401, 'sign_in_required');
    return {email:payload.email.toLowerCase(), sub:payload.sub};
  } catch { fail(401, 'sign_in_required', 'Sign in again to continue.'); }
}
export async function resolveUser(env, claim) {
  const linked = await one(env.DB, 'SELECT id,email,role FROM users WHERE subject=? AND enabled=1',claim.sub);
  if (linked) return linked;
  // First admitted sign-in only. Deployment configuration bootstraps the owner; never promote existing users.
  if (claim.email === env.OWNER_EMAIL?.toLowerCase()) await run(env.DB,
    "INSERT OR IGNORE INTO users(id,email,role,created_at) SELECT ?,?,'owner',? WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='owner')", id(),claim.email,now());
  await run(env.DB, 'UPDATE users SET subject=? WHERE email=? COLLATE NOCASE AND subject IS NULL AND enabled=1', claim.sub,claim.email);
  const user = await one(env.DB, 'SELECT id,email,role FROM users WHERE subject=? AND enabled=1',claim.sub);
  if (!user) fail(403, 'account_not_enabled', 'This account has not been enabled by the owner.');
  return user;
}
export function csrf(request, env, user) {
  if (request.headers.get('Origin') !== env.APP_ORIGIN || request.headers.get('X-Embyfin-User') !== user.id) fail(403, 'account_or_origin_changed');
}
export const owner = user => { if (user.role !== 'owner') fail(403, 'owner_required'); };
const secret = env => {
  if (!env.MACHINE_SECRET || env.MACHINE_SECRET.length < 32) fail(503, 'machine_not_configured');
  return new TextEncoder().encode(env.MACHINE_SECRET);
};
export const machineToken = (env, token, deadline) => new SignJWT({run:token}).setProtectedHeader({alg:'HS256'}).setIssuer('embyfin').setAudience('processor').setExpirationTime(deadline).sign(secret(env));
export async function machineIdentity(request, env) {
  try {
    const {payload} = await jwtVerify((request.headers.get('Authorization') || '').replace(/^Bearer /,''),secret(env),{issuer:'embyfin',audience:'processor',algorithms:['HS256']});
    if (typeof payload.run !== 'string') throw Error(); return payload.run;
  } catch { fail(401, 'machine_unauthorized'); }
}
