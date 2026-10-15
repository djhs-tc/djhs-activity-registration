import {
  AuthError, authConfig, verifyGoogleIdToken, signSession, readSession, randomToken,
  getCookie, setCookie, SESSION_COOKIE, NONCE_COOKIE, SESSION_TTL_S, NONCE_TTL_S
} from './auth.js';

// 現階段：只讀活動 API + Google 登入。報名、抽籤與管理寫入 API 尚未開放。
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const route = ROUTES[url.pathname];
    if (!route) return json({ error: 'Not found' }, 404);
    const handler = route[request.method];
    if (!handler) return json({ error: 'Method not allowed' }, 405, { allow: Object.keys(route).join(', ') });
    if (request.method === 'POST') {
      const blocked = checkSameOrigin(request, url);
      if (blocked) return blocked;
    }
    return handler(request, env, ctx);
  }
};

const ROUTES = {
  '/api/health': { GET: health },
  '/api/activities': { GET: activities },
  '/api/config': { GET: config },
  '/api/me': { GET: me },
  '/api/auth/nonce': { GET: nonce },
  '/api/auth/google': { POST: googleLogin },
  '/api/auth/logout': { POST: logout }
};

async function health(request, env) {
  if (!env.DB) return json({ error: 'D1 binding not configured' }, 503);
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: true, service: 'djhs-activities', authentication: authConfig(env).enabled ? 'google-oidc' : 'not-configured', registrationEnabled: false });
  } catch (_) { return json({ ok: false, error: 'Database unavailable' }, 503); }
}

async function activities(request, env) {
  if (!env.DB) return json({ error: 'D1 binding not configured' }, 503);
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status FROM activities WHERE status = 'open' ORDER BY starts_at ASC LIMIT 50"
    ).all();
    return json({ activities: results || [], registrationEnabled: false });
  } catch (_) { return json({ error: 'Unable to load activities' }, 503); }
}

async function config(request, env) {
  const cfg = authConfig(env);
  return json({ authEnabled: cfg.enabled, googleClientId: cfg.enabled ? cfg.clientId : '', registrationEnabled: false });
}

async function me(request, env) {
  const cfg = authConfig(env);
  const user = cfg.enabled ? await readSession(getCookie(request, SESSION_COOKIE), cfg.secret) : null;
  return json({ user: user && { email: user.email, name: user.name, isAdmin: cfg.admins.includes(user.email) } });
}

async function nonce(request, env) {
  if (!authConfig(env).enabled) return json({ error: 'Authentication not configured' }, 503);
  const value = randomToken();
  return json({ nonce: value }, 200, { 'set-cookie': setCookie(NONCE_COOKIE, value, NONCE_TTL_S) });
}

async function googleLogin(request, env, ctx) {
  const cfg = authConfig(env);
  if (!cfg.enabled) return json({ error: 'Authentication not configured' }, 503);
  const body = await readJson(request);
  if (!body || typeof body.credential !== 'string') return json({ error: 'Invalid request' }, 400);
  const expectedNonce = getCookie(request, NONCE_COOKIE);
  let user;
  try {
    user = await verifyGoogleIdToken(body.credential, { clientId: cfg.clientId, domains: cfg.domains, nonce: expectedNonce });
  } catch (e) {
    if (e instanceof AuthError) {
      const message = e.message === 'account domain not allowed'
        ? '僅限臺中市教育帳號（' + cfg.domains.map(d => '@' + d).join('、') + '）登入'
        : '登入驗證失敗，請重新登入';
      return json({ error: message }, 401, { 'set-cookie': setCookie(NONCE_COOKIE, '', 0) });
    }
    return json({ error: '暫時無法驗證 Google 登入，請稍後再試' }, 503);
  }
  const isAdmin = cfg.admins.includes(user.email);
  if (env.DB) {
    ctx.waitUntil(env.DB.prepare('INSERT INTO audit_logs (actor_email, action, details_json) VALUES (?, ?, ?)')
      .bind(user.email, 'login', JSON.stringify({ isAdmin })).run().catch(() => {}));
  }
  const headers = new Headers({ 'set-cookie': setCookie(SESSION_COOKIE, await signSession(user, cfg.secret), SESSION_TTL_S) });
  headers.append('set-cookie', setCookie(NONCE_COOKIE, '', 0));
  return json({ user: { email: user.email, name: user.name, isAdmin } }, 200, headers);
}

async function logout() {
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0) });
}

// 寫入類請求只接受同源 JSON，避免跨站請求偽造。
function checkSameOrigin(request, url) {
  if (request.headers.get('origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'Unsupported media type' }, 415);
  return null;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8192) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function json(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}
