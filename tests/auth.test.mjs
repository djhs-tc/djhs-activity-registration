// 執行：npm test（Node 20+，不需安裝套件）
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken, signSession, readSession, b64urlEncode, resetJwksCache, AuthError, getCookie } from '../src/auth.js';
import worker from '../src/index.js';

const CLIENT_ID = '123456789-abcdef.apps.googleusercontent.com';
const DOMAINS = ['st.tc.edu.tw', 'tjjh.tc.edu.tw'];
const SECRET = 'x'.repeat(40);
const enc = new TextEncoder();

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', use: 'sig', alg: 'RS256' };
const fakeFetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });

const now = () => Math.floor(Date.now() / 1000);
function claims(over = {}) {
  return { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '123', email: 'teacher@st.tc.edu.tw',
    email_verified: true, hd: 'st.tc.edu.tw', name: '測試老師', nonce: 'n1', iat: now(), exp: now() + 3600, ...over };
}
async function makeToken(payload, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key = privateKey) {
  const data = b64urlEncode(enc.encode(JSON.stringify(header))) + '.' + b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return data + '.' + b64urlEncode(sig);
}
const opts = (over = {}) => ({ clientId: CLIENT_ID, domains: DOMAINS, nonce: 'n1', fetchImpl: fakeFetch, ...over });

test('accepts a valid school account token', async () => {
  resetJwksCache();
  const u = await verifyGoogleIdToken(await makeToken(claims()), opts());
  assert.equal(u.email, 'teacher@st.tc.edu.tw');
  assert.equal(u.hd, 'st.tc.edu.tw');
});

const rejects = [
  ['wrong audience', claims({ aud: 'other-client' })],
  ['wrong issuer', claims({ iss: 'https://evil.example' })],
  ['expired', claims({ exp: now() - 600, iat: now() - 4000 })],
  ['future iat', claims({ iat: now() + 600 })],
  ['nonce mismatch', claims({ nonce: 'other' })],
  ['unverified email', claims({ email_verified: false })],
  ['personal gmail (no hd)', claims({ email: 'someone@gmail.com', hd: undefined })],
  ['other workspace domain', claims({ email: 'a@other.edu.tw', hd: 'other.edu.tw' })],
  ['email outside hd', claims({ email: 'a@gmail.com', hd: 'st.tc.edu.tw' })]
];
for (const [name, payload] of rejects) {
  test('rejects ' + name, async () => {
    await assert.rejects(verifyGoogleIdToken(await makeToken(payload), opts()), AuthError);
  });
}

test('rejects forged signature and alg=none', async () => {
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  await assert.rejects(verifyGoogleIdToken(await makeToken(claims(), undefined, other.privateKey), opts()), AuthError);
  const none = b64urlEncode(enc.encode('{"alg":"none","kid":"k1"}')) + '.' + b64urlEncode(enc.encode(JSON.stringify(claims()))) + '.';
  await assert.rejects(verifyGoogleIdToken(none, opts()), AuthError);
});

test('rejects when no nonce cookie was issued', async () => {
  await assert.rejects(verifyGoogleIdToken(await makeToken(claims()), opts({ nonce: '' })), AuthError);
});

test('session cookie round-trip, tamper and expiry', async () => {
  const v = await signSession({ email: 'teacher@st.tc.edu.tw', name: 'T' }, SECRET);
  assert.equal((await readSession(v, SECRET)).email, 'teacher@st.tc.edu.tw');
  assert.equal(await readSession(v, 'y'.repeat(40)), null);
  const [body, sig] = v.split('.');
  const forged = b64urlEncode(enc.encode(JSON.stringify({ email: 'admin@tjjh.tc.edu.tw', exp: now() + 999 })));
  assert.equal(await readSession(forged + '.' + sig, SECRET), null);
  assert.equal(await readSession(body + '.' + sig, SECRET, now() + 9 * 3600), null);
});

// --- Worker 路由 ---
const db = { prepare: () => ({ first: async () => ({ ok: 1 }), all: async () => ({ results: [] }), bind() { return this; }, run: async () => ({}) }) };
const baseEnv = { DB: db, ASSETS: { fetch: async () => new Response('asset') }, GOOGLE_CLIENT_ID: '', ALLOWED_EMAIL_DOMAINS: DOMAINS.join(','), SESSION_SECRET: '', ADMIN_EMAILS: '' };
const ctx = { waitUntil() {} };
const call = (path, init, env = baseEnv) => worker.fetch(new Request('https://djhs.test' + path, init), env, ctx);

test('auth disabled until configured', async () => {
  assert.deepEqual(await (await call('/api/config')).json(), { authEnabled: false, googleClientId: '', registrationEnabled: false });
  assert.equal((await call('/api/auth/nonce')).status, 503);
  assert.deepEqual(await (await call('/api/me')).json(), { user: null });
  assert.equal((await (await call('/api/health')).json()).authentication, 'not-configured');
});

test('routing: 404, 405, static assets', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/activities', { method: 'POST' })).status, 405);
  assert.equal((await call('/api/auth/google')).status, 405);
  assert.equal(await (await call('/')).text(), 'asset');
});

test('POST requires same origin and JSON', async () => {
  const env = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET };
  const body = JSON.stringify({ credential: 'x' });
  assert.equal((await call('/api/auth/google', { method: 'POST', body, headers: { 'content-type': 'application/json' } }, env)).status, 403);
  assert.equal((await call('/api/auth/google', { method: 'POST', body, headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }, env)).status, 403);
  assert.equal((await call('/api/auth/google', { method: 'POST', body, headers: { origin: 'https://djhs.test', 'content-type': 'text/plain' } }, env)).status, 415);
  assert.equal((await call('/api/auth/google', { method: 'POST', body, headers: { origin: 'https://djhs.test', 'content-type': 'application/json' } }, env)).status, 401);
});

test('/api/me reflects session and admin list', async () => {
  const env = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET, ADMIN_EMAILS: 'tjjh111@tjjh.tc.edu.tw' };
  const nonceRes = await call('/api/auth/nonce', {}, env);
  assert.match(nonceRes.headers.get('set-cookie'), /^__Host-djhs_nonce=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  for (const [email, isAdmin] of [['tjjh111@tjjh.tc.edu.tw', true], ['teacher@st.tc.edu.tw', false]]) {
    const cookie = '__Host-djhs_session=' + await signSession({ email, name: 'n' }, SECRET);
    const { user } = await (await call('/api/me', { headers: { cookie } }, env)).json();
    assert.equal(user.isAdmin, isAdmin);
  }
  assert.equal(getCookie(new Request('https://x', { headers: { cookie: 'a=1; __Host-djhs_session=abc' } }), '__Host-djhs_session'), 'abc');
});

test('full login flow sets session cookie and clears nonce', async () => {
  const env = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET, ADMIN_EMAILS: 'tjjh111@tjjh.tc.edu.tw' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  resetJwksCache();
  try {
    const token = await makeToken(claims({ email: 'tjjh111@tjjh.tc.edu.tw', hd: 'tjjh.tc.edu.tw', nonce: 'abc' }));
    const res = await call('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: token }),
      headers: { origin: 'https://djhs.test', 'content-type': 'application/json', cookie: '__Host-djhs_nonce=abc' } }, env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.isAdmin, true);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some(c => c.startsWith('__Host-djhs_session=') && c.includes('Max-Age=28800')));
    assert.ok(cookies.some(c => c.startsWith('__Host-djhs_nonce=;') && c.includes('Max-Age=0')));
    // 同一 token 但 nonce cookie 不同 → 拒絕（防重放）
    const replay = await call('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: token }),
      headers: { origin: 'https://djhs.test', 'content-type': 'application/json', cookie: '__Host-djhs_nonce=zzz' } }, env);
    assert.equal(replay.status, 401);
  } finally { globalThis.fetch = realFetch; }
});

test('malformed client ID (e.g. a pasted secret) is never exposed and disables auth', async () => {
  const env = { ...baseEnv, GOOGLE_CLIENT_ID: 'eGc1oU/OL6WTGs6Xq7AzWeQhUkM+abc', SESSION_SECRET: SECRET };
  assert.deepEqual(await (await call('/api/config', {}, env)).json(), { authEnabled: false, googleClientId: '', registrationEnabled: false });
  const same = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: CLIENT_ID };
  assert.equal((await (await call('/api/config', {}, same)).json()).authEnabled, false);
});
