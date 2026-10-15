// Google Identity Services (OIDC) ID token 驗證與 session cookie。
// 機密：SESSION_SECRET、ADMIN_EMAILS 以 `wrangler secret put` 設定，不寫入儲存庫。

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CLOCK_SKEW_S = 60;
export const SESSION_COOKIE = '__Host-djhs_session';
export const NONCE_COOKIE = '__Host-djhs_nonce';
export const SESSION_TTL_S = 8 * 60 * 60;
export const NONCE_TTL_S = 10 * 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new AuthError('malformed base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export class AuthError extends Error {}

const CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function authConfig(env) {
  const rawClientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  // Client ID 會公開給前端；格式不符（例如誤貼成其他機密）時一律不公開並停用登入。
  const clientId = CLIENT_ID_PATTERN.test(rawClientId) ? rawClientId : '';
  const secret = String(env.SESSION_SECRET || '');
  const domains = splitList(env.ALLOWED_EMAIL_DOMAINS);
  return {
    clientId,
    secret,
    domains,
    admins: splitList(env.ADMIN_EMAILS),
    enabled: Boolean(clientId && secret.length >= 32 && secret !== rawClientId && domains.length)
  };
}
function splitList(v) {
  // 容許全形逗號、頓號、分號與空白，避免在控制台輸入時分隔符號打錯導致設定失效。
  return String(v || '').split(/[\s,，、;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

// --- Google ID token ---
let jwksCache = { keys: null, expires: 0 };
export function resetJwksCache() { jwksCache = { keys: null, expires: 0 }; }

async function getGoogleKeys(fetchImpl, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && jwksCache.keys && jwksCache.expires > now) return jwksCache.keys;
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Unable to fetch Google signing keys');
  const body = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwksCache = { keys: body.keys || [], expires: now + Math.min(Number(maxAge?.[1] || 3600), 86400) * 1000 };
  return jwksCache.keys;
}

// 回傳驗證通過的使用者 { email, name, hd, sub }；任何不符即丟出 AuthError。
export async function verifyGoogleIdToken(token, { clientId, domains, nonce, fetchImpl = fetch, nowS = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string' || token.length > 4096) throw new AuthError('invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('invalid token');
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch (_) { throw new AuthError('invalid token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('unsupported token algorithm');

  let jwk = (await getGoogleKeys(fetchImpl, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getGoogleKeys(fetchImpl, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new AuthError('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new AuthError('bad signature');

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new AuthError('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!clientId || !aud.includes(clientId)) throw new AuthError('wrong audience');
  if (payload.azp && payload.azp !== clientId) throw new AuthError('wrong authorized party');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) throw new AuthError('token expired');
  if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_S > nowS) throw new AuthError('token issued in the future');
  if (!nonce || payload.nonce !== nonce) throw new AuthError('nonce mismatch');
  if (payload.email_verified !== true) throw new AuthError('email not verified');

  const email = String(payload.email || '').toLowerCase();
  const hd = String(payload.hd || '').toLowerCase();
  // 只接受學校 Google Workspace 管理的帳號：hd 必須在允許清單，且 email 屬於該網域。
  if (!hd || !domains.includes(hd) || !email.endsWith('@' + hd)) throw new AuthError('account domain not allowed');
  return { email, name: String(payload.name || ''), hd, sub: String(payload.sub || '') };
}

// --- session cookie（HMAC-SHA256 簽章，無狀態）---
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signSession(user, secret, nowS = Math.floor(Date.now() / 1000)) {
  const body = b64urlEncode(enc.encode(JSON.stringify({ email: user.email, name: user.name, iat: nowS, exp: nowS + SESSION_TTL_S })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64urlEncode(sig);
}
export async function readSession(value, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (!value || !secret) return null;
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
    if (!ok) return null;
    const s = JSON.parse(dec.decode(b64urlDecode(body)));
    if (typeof s.exp !== 'number' || s.exp < nowS || typeof s.email !== 'string') return null;
    return { email: s.email, name: String(s.name || '') };
  } catch (_) { return null; }
}

export function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
export function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
