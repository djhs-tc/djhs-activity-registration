import {
  AuthError, authConfig, verifyGoogleIdToken, signSession, readSession, randomToken,
  getCookie, setCookie, SESSION_COOKIE, NONCE_COOKIE, SESSION_TTL_S, NONCE_TTL_S
} from './auth.js';
import { HttpError, json, readJson, nowIso } from './http.js';
import {
  listPublicActivities, validateRegistration, register, listMyRegistrations,
  validateActivity, createActivity, updateActivity, setActivityStatus, getActivity, listAdminActivities,
  listRegistrations, cancelRegistration, drawLottery, toCsv
} from './activities.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    let pathMatched = false;
    for (const [method, pattern, handler] of ROUTES) {
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (method !== request.method) continue;
      try {
        if (method === 'POST' || method === 'PUT') checkSameOrigin(request, url);
        return await handler({ request, env, ctx, params: m.slice(1).map(decodeURIComponent) });
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e);
        return json({ error: '系統暫時無法處理，請稍後再試' }, 500);
      }
    }
    return pathMatched ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
  }
};

const ID = '([0-9a-f-]{36})';
const ROUTES = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/activities$/, publicActivities],
  ['GET', /^\/api\/config$/, config],
  ['GET', /^\/api\/me$/, me],
  ['GET', /^\/api\/auth\/nonce$/, nonce],
  ['POST', /^\/api\/auth\/google$/, googleLogin],
  ['POST', /^\/api\/auth\/logout$/, logout],
  // 教師
  ['POST', /^\/api\/registrations$/, createRegistration],
  ['GET', /^\/api\/my\/registrations$/, myRegistrations],
  // 管理員
  ['GET', /^\/api\/admin\/activities$/, adminListActivities],
  ['POST', /^\/api\/admin\/activities$/, adminCreateActivity],
  ['PUT', new RegExp(`^/api/admin/activities/${ID}$`), adminUpdateActivity],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/status$`), adminSetStatus],
  ['GET', new RegExp(`^/api/admin/activities/${ID}/registrations$`), adminRegistrations],
  ['GET', new RegExp(`^/api/admin/activities/${ID}/registrations\\.csv$`), adminRegistrationsCsv],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/registrations/${ID}/cancel$`), adminCancelRegistration],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/draw$`), adminDraw]
];

// ---------- 身分 ----------
async function currentUser(request, env) {
  const cfg = authConfig(env);
  if (!cfg.enabled) return null;
  const s = await readSession(getCookie(request, SESSION_COOKIE), cfg.secret);
  return s && { email: s.email, name: s.name, isAdmin: cfg.admins.includes(s.email) };
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, '請先使用學校 Google 帳號登入');
  return user;
}
async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user.isAdmin) throw new HttpError(403, '需要管理員權限');
  return user;
}
function requireDb(env) {
  if (!env.DB) throw new HttpError(503, 'D1 binding not configured');
  return env.DB;
}

// ---------- 公開 ----------
async function health({ env }) {
  const db = requireDb(env);
  try {
    await db.prepare('SELECT 1 AS ok').first();
  } catch (_) { return json({ ok: false, error: 'Database unavailable' }, 503); }
  const enabled = authConfig(env).enabled;
  return json({ ok: true, service: 'djhs-activities', authentication: enabled ? 'google-oidc' : 'not-configured', registrationEnabled: enabled });
}

async function publicActivities({ env }) {
  const now = nowIso();
  return json({ activities: await listPublicActivities(requireDb(env), now), now, registrationEnabled: authConfig(env).enabled });
}

async function config({ env }) {
  const cfg = authConfig(env);
  return json({ authEnabled: cfg.enabled, googleClientId: cfg.enabled ? cfg.clientId : '', registrationEnabled: cfg.enabled });
}

async function me({ request, env }) {
  return json({ user: await currentUser(request, env) });
}

async function nonce({ env }) {
  if (!authConfig(env).enabled) throw new HttpError(503, 'Authentication not configured');
  const value = randomToken();
  return json({ nonce: value }, 200, { 'set-cookie': setCookie(NONCE_COOKIE, value, NONCE_TTL_S) });
}

async function googleLogin({ request, env, ctx }) {
  const cfg = authConfig(env);
  if (!cfg.enabled) throw new HttpError(503, 'Authentication not configured');
  const body = await readJson(request);
  if (typeof body.credential !== 'string') throw new HttpError(400, 'Invalid request');
  let user;
  try {
    user = await verifyGoogleIdToken(body.credential, { clientId: cfg.clientId, domains: cfg.domains, nonce: getCookie(request, NONCE_COOKIE) });
  } catch (e) {
    if (e instanceof AuthError) {
      const message = e.message === 'account domain not allowed'
        ? '僅限臺中市教育帳號（' + cfg.domains.map(d => '@' + d).join('、') + '）登入'
        : '登入驗證失敗，請重新登入';
      return json({ error: message }, 401, { 'set-cookie': setCookie(NONCE_COOKIE, '', 0) });
    }
    throw new HttpError(503, '暫時無法驗證 Google 登入，請稍後再試');
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

// ---------- 教師 ----------
async function createRegistration({ request, env }) {
  const user = await requireUser(request, env);
  const input = validateRegistration(await readJson(request));
  return json({ registration: await register(requireDb(env), user, input) }, 201);
}

async function myRegistrations({ request, env }) {
  const user = await requireUser(request, env);
  return json({ registrations: await listMyRegistrations(requireDb(env), user.email) });
}

// ---------- 管理員 ----------
async function adminListActivities({ request, env }) {
  await requireAdmin(request, env);
  return json({ activities: await listAdminActivities(requireDb(env)), now: nowIso() });
}

async function adminCreateActivity({ request, env }) {
  const admin = await requireAdmin(request, env);
  const a = validateActivity(await readJson(request));
  return json({ activity: await createActivity(requireDb(env), admin, a) }, 201);
}

async function adminUpdateActivity({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const a = validateActivity(await readJson(request));
  return json({ activity: await updateActivity(requireDb(env), admin, params[0], a) });
}

async function adminSetStatus({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { status } = await readJson(request);
  return json({ activity: await setActivityStatus(requireDb(env), admin, params[0], String(status || '')) });
}

async function adminRegistrations({ request, env, params }) {
  await requireAdmin(request, env);
  const db = requireDb(env);
  const activity = await getActivity(db, params[0]);
  if (!activity) throw new HttpError(404, '找不到此活動');
  const draw = await db.prepare(
    `SELECT actor_email, details_json, created_at FROM audit_logs WHERE activity_id = ?1 AND action = 'lottery_draw' ORDER BY id DESC LIMIT 1`
  ).bind(params[0]).first();
  const lottery = draw && { by: draw.actor_email, at: draw.created_at, ...JSON.parse(draw.details_json) };
  return json({ activity, registrations: await listRegistrations(db, params[0]), lottery });
}

async function adminRegistrationsCsv({ request, env, params }) {
  await requireAdmin(request, env);
  const db = requireDb(env);
  const activity = await getActivity(db, params[0]);
  if (!activity) throw new HttpError(404, '找不到此活動');
  const filename = encodeURIComponent(`${activity.title}-報名名單.csv`);
  return new Response(toCsv(await listRegistrations(db, params[0])), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="registrations.csv"; filename*=UTF-8''${filename}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

async function adminCancelRegistration({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { reason } = await readJson(request);
  await cancelRegistration(requireDb(env), admin, params[0], params[1], reason);
  return json({ ok: true });
}

async function adminDraw({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  await readJson(request);
  return json({ result: await drawLottery(requireDb(env), admin, params[0]) });
}

// 寫入類請求只接受同源 JSON，避免跨站請求偽造。
function checkSameOrigin(request, url) {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Forbidden');
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Unsupported media type');
}
