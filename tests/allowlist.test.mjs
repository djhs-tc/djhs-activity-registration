// 個別允許名單：Gmail 等非學校信箱需管理員加入後才能登入；移除後立即失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { signSession, b64urlEncode, resetJwksCache } from '../src/auth.js';
import worker from '../src/index.js';

const CLIENT_ID = '123456789-abcdef.apps.googleusercontent.com';
const SECRET = 's'.repeat(40);
const ADMIN = 'tjjh111@tjjh.tc.edu.tw';
const ORIGIN = 'https://djhs.test';
const enc = new TextEncoder();

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256' };
const now = () => Math.floor(Date.now() / 1000);
async function idToken(email, hd) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: email, email, email_verified: true, name: '老師', nonce: 'n1', iat: now(), exp: now() + 600 };
  if (hd) payload.hd = hd;
  const data = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' }))) + '.' + b64urlEncode(enc.encode(JSON.stringify(payload)));
  return data + '.' + b64urlEncode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(data)));
}

function setup() {
  const DB = createD1();
  const env = { DB, ASSETS: { fetch: async () => new Response('') }, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET, ADMIN_EMAILS: ADMIN, ALLOWED_EMAIL_DOMAINS: 'st.tc.edu.tw,tjjh.tc.edu.tw' };
  async function call(path, { body, as, cookie } = {}) {
    const headers = {};
    if (as) headers.cookie = '__Host-djhs_session=' + await signSession({ email: as, name: 'n' }, SECRET);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = ORIGIN; }
    const res = await worker.fetch(new Request(ORIGIN + path, { method: body !== undefined ? 'POST' : 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  const login = async email => call('/api/auth/google', { body: { credential: await idToken(email, email.endsWith('tc.edu.tw') ? email.split('@')[1] : undefined) }, cookie: '__Host-djhs_nonce=n1' });
  return { DB, call, login };
}

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] })); resetJwksCache(); });
test.after(() => { globalThis.fetch = realFetch; });

test('gmail rejected until an admin adds it; then it can log in and register', async () => {
  const { call, login } = setup();
  const r1 = await login('teacher.wang@gmail.com');
  assert.equal(r1.status, 401);
  assert.match(r1.data.error, /尚未登記/);

  assert.equal((await call('/api/admin/allowed-emails', { body: { email: 'Teacher.Wang@Gmail.com', note: '王老師 701' }, as: 'x@st.tc.edu.tw' })).status, 403, 'teacher cannot edit allowlist');
  assert.equal((await call('/api/admin/allowed-emails', { body: { email: ' Teacher.Wang@Gmail.com ', note: '王老師 701' }, as: ADMIN })).status, 201);
  const r2 = await login('teacher.wang@gmail.com');
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.data.user, { email: 'teacher.wang@gmail.com', name: '老師', isAdmin: false });
  assert.equal((await call('/api/me', { as: 'teacher.wang@gmail.com' })).data.user.email, 'teacher.wang@gmail.com');
  assert.equal((await call('/api/my/registrations', { as: 'teacher.wang@gmail.com' })).status, 200);
});

test('removing an email revokes access immediately, even with a valid session cookie', async () => {
  const { call, DB } = setup();
  await call('/api/admin/allowed-emails', { body: { email: 'a@hotmail.com', note: '李老師' }, as: ADMIN });
  assert.equal((await call('/api/me', { as: 'a@hotmail.com' })).data.user.email, 'a@hotmail.com');
  assert.equal((await call('/api/admin/allowed-emails/remove', { body: { email: 'A@hotmail.com' }, as: ADMIN })).status, 200);
  assert.equal((await call('/api/me', { as: 'a@hotmail.com' })).data.user, null);
  assert.equal((await call('/api/my/registrations', { as: 'a@hotmail.com' })).status, 401);
  assert.equal((await call('/api/admin/allowed-emails/remove', { body: { email: 'a@hotmail.com' }, as: ADMIN })).status, 404);
  const actions = DB.raw.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'allowlist_%' ORDER BY id`).all().map(r => r.action);
  assert.deepEqual(actions, ['allowlist_add', 'allowlist_remove']);
});

test('a forged session for an unlisted gmail is not accepted', async () => {
  const { call } = setup();
  assert.equal((await call('/api/me', { as: 'evil@gmail.com' })).data.user, null);
});

test('allowlist validation and listing', async () => {
  const { call } = setup();
  const add = body => call('/api/admin/allowed-emails', { body, as: ADMIN });
  assert.match((await add({ email: 'not-an-email', note: 'x' })).data.error, /格式/);
  assert.match((await add({ email: 'x@st.tc.edu.tw', note: 'x' })).data.error, /學校帳號不需要/);
  assert.match((await add({ email: 'b@gmail.com', note: '' })).data.error, /備註/);
  assert.equal((await add({ email: 'b@gmail.com', note: '陳老師' })).status, 201);
  assert.equal((await add({ email: 'B@gmail.com', note: '陳老師' })).status, 409);
  const list = await call('/api/admin/allowed-emails', { as: ADMIN });
  assert.deepEqual(list.data.emails.map(e => [e.email, e.note, e.added_by]), [['b@gmail.com', '陳老師', ADMIN]]);
  assert.equal((await call('/api/admin/allowed-emails')).status, 401);
});

test('school accounts still log in without being listed', async () => {
  const { login } = setup();
  assert.equal((await login('t1@st.tc.edu.tw')).status, 200);
  assert.equal((await login(ADMIN)).data.user.isAdmin, true);
});

test('batch add: all-or-nothing validation, skips existing and duplicates, audits each new email', async () => {
  const { call, DB } = setup();
  const batch = entries => call('/api/admin/allowed-emails/batch', { body: { entries }, as: ADMIN });
  await call('/api/admin/allowed-emails', { body: { email: 'old@gmail.com', note: '舊' }, as: ADMIN });

  const bad = await batch([{ email: 'a@gmail.com', note: '甲' }, { email: 'oops', note: '乙' }, { email: 'x@st.tc.edu.tw', note: '丙' }]);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /整批未加入/);
  assert.match(bad.data.error, /第 2 筆（oops）/);
  assert.match(bad.data.error, /第 3 筆.*學校帳號/);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM allowed_emails').get().n, 1, 'nothing added on error');

  const ok = await batch([{ email: 'A@gmail.com', note: '甲' }, { email: 'b@hotmail.com', note: '乙' }, { email: 'a@gmail.com', note: '甲重複' }, { email: 'OLD@gmail.com', note: '舊' }]);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.result, { added: ['a@gmail.com', 'b@hotmail.com'], skipped_existing: ['old@gmail.com'], skipped_duplicates: 1 });
  assert.equal(DB.raw.prepare(`SELECT note FROM allowed_emails WHERE email='a@gmail.com'`).get().note, '甲');
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='allowlist_add'`).get().n, 3);

  assert.equal((await batch([])).status, 400);
  assert.match((await batch(Array.from({ length: 301 }, (_, i) => ({ email: `t${i}@gmail.com`, note: 'n' })))).data.error, /最多 300/);
  assert.equal((await call('/api/admin/allowed-emails/batch', { body: { entries: [{ email: 'c@gmail.com', note: 'n' }] }, as: 't@st.tc.edu.tw' })).status, 403);
  const big = await batch(Array.from({ length: 300 }, (_, i) => ({ email: `teacher.number.${i}@gmail.com`, note: `第${i}位老師 七年級導師` })));
  assert.equal(big.status, 200);
  assert.equal(big.data.result.added.length, 300);
});

test('login policy any_google: any verified Google account may log in; switching back revokes immediately', async () => {
  const { call, login, DB } = setup();
  assert.equal((await call('/api/admin/settings', { as: ADMIN })).data.settings.login_policy, 'school_only');
  assert.equal((await login('parent@gmail.com')).status, 401);
  assert.equal((await call('/api/config')).data.openLogin, false);

  assert.equal((await call('/api/admin/settings', { body: { login_policy: 'any_google' }, as: 't@st.tc.edu.tw' })).status, 403);
  assert.equal((await call('/api/admin/settings', { body: { login_policy: 'nope' }, as: ADMIN })).status, 400);
  const set = await call('/api/admin/settings', { body: { login_policy: 'any_google' }, as: ADMIN });
  assert.equal(set.data.settings.login_policy, 'any_google');
  assert.equal(set.data.settings.updated_by, ADMIN);
  assert.equal((await call('/api/config')).data.openLogin, true);

  const r = await login('parent@gmail.com');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isAdmin, false);
  assert.equal((await call('/api/me', { as: 'parent@gmail.com' })).data.user.email, 'parent@gmail.com');
  assert.equal((await call('/api/admin/activities', { as: 'parent@gmail.com' })).status, 403, 'still not admin');

  await call('/api/admin/settings', { body: { login_policy: 'school_only' }, as: ADMIN });
  assert.equal((await call('/api/me', { as: 'parent@gmail.com' })).data.user, null, 'revoked immediately');
  assert.equal((await call('/api/me', { as: 't1@st.tc.edu.tw' })).data.user.email, 't1@st.tc.edu.tw', 'school accounts unaffected');
  const logs = DB.raw.prepare(`SELECT details_json FROM audit_logs WHERE action='login_policy' ORDER BY id`).all().map(x => JSON.parse(x.details_json));
  assert.deepEqual(logs, [{ from: 'school_only', to: 'any_google' }, { from: 'any_google', to: 'school_only' }]);
});

