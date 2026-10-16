import {
  AuthError, authConfig, verifyGoogleIdToken, signSession, readSession, randomToken, isSchoolEmail,
  getCookie, setCookie, SESSION_COOKIE, NONCE_COOKIE, SESSION_TTL_S, NONCE_TTL_S
} from './auth.js';
import { getLoginPolicy, setLoginPolicy, getSettings } from './settings.js';
import { isAllowedEmail, listAllowedEmails, addAllowedEmail, addAllowedEmailsBatch, removeAllowedEmail } from './allowlist.js';
import { HttpError, json, readJson, nowIso } from './http.js';
import {
  listPublicActivities, validateRegistration, register, listMyRegistrations,
  validateActivity, createActivity, updateActivity, setActivityStatus, getActivity, listAdminActivities,
  listRegistrations, cancelRegistration, drawLottery, toCsv, toStudentsCsv, toIcs, cancelActivity, deleteActivity, backfillNext,
  withdrawStudent, restoreStudent, setStudentPaid, setStudentRefunded, selfCancelRegistration, openRegister, openCancel
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
const SID = '(\\d{1,10})';
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
  // 免登入（僅限設定為「學生填寫・免登入」的營隊）
  ['POST', /^\/api\/public\/registrations$/, publicRegistration],
  ['POST', /^\/api\/public\/registrations\/cancel$/, publicCancel],
  ['GET', /^\/api\/my\/registrations$/, myRegistrations],
  ['POST', new RegExp(`^/api/registrations/${ID}/students/${SID}/withdraw$`), studentWithdraw],
  ['POST', new RegExp(`^/api/registrations/${ID}/cancel$`), selfCancel],
  // 管理員
  ['GET', /^\/api\/admin\/activities$/, adminListActivities],
  ['POST', /^\/api\/admin\/activities$/, adminCreateActivity],
  ['PUT', new RegExp(`^/api/admin/activities/${ID}$`), adminUpdateActivity],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/status$`), adminSetStatus],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/cancel$`), adminCancelActivity],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/delete$`), adminDeleteActivity],
  ['GET', new RegExp(`^/api/admin/activities/${ID}/registrations$`), adminRegistrations],
  ['GET', new RegExp(`^/api/admin/activities/${ID}/registrations\\.csv$`), adminRegistrationsCsv],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/registrations/${ID}/cancel$`), adminCancelRegistration],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/draw$`), adminDraw],
  ['POST', new RegExp(`^/api/admin/activities/${ID}/backfill$`), adminBackfill],
  ['GET', new RegExp(`^/api/admin/activities/${ID}/calendar\\.ics$`), adminCalendar],
  ['POST', new RegExp(`^/api/admin/registrations/${ID}/students/${SID}/restore$`), adminStudentRestore],
  ['POST', new RegExp(`^/api/admin/registrations/${ID}/students/${SID}/paid$`), adminStudentPaid],
  ['POST', new RegExp(`^/api/admin/registrations/${ID}/students/${SID}/refund$`), adminStudentRefund],
  ['GET', /^\/api\/admin\/settings$/, adminGetSettings],
  ['POST', /^\/api\/admin\/settings$/, adminSetSettings],
  ['GET', /^\/api\/admin\/allowed-emails$/, adminListAllowed],
  ['POST', /^\/api\/admin\/allowed-emails$/, adminAddAllowed],
  ['POST', /^\/api\/admin\/allowed-emails\/batch$/, adminBatchAllowed],
  ['POST', /^\/api\/admin\/allowed-emails\/remove$/, adminRemoveAllowed]
];

// ---------- 身分 ----------
// 非學校帳號：登入政策為 any_google 時一律允許，否則需在帳號名單中
async function isPersonalAllowed(env, email) {
  return (await getLoginPolicy(env.DB)) === 'any_google' || isAllowedEmail(env.DB, email);
}
async function currentUser(request, env) {
  const cfg = authConfig(env);
  if (!cfg.enabled) return null;
  const s = await readSession(getCookie(request, SESSION_COOKIE), cfg.secret);
  if (!s) return null;
  // 非學校帳號每次都重新檢查名單：管理員移除後立即失效，不必等 session 過期。
  if (!isSchoolEmail(s.email, cfg.domains) && !(await isPersonalAllowed(env, s.email))) return null;
  return { email: s.email, name: s.name, isAdmin: cfg.admins.includes(s.email) };
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
  return json({ authEnabled: cfg.enabled, googleClientId: cfg.enabled ? cfg.clientId : '', registrationEnabled: cfg.enabled, openLogin: cfg.enabled && (await getLoginPolicy(env.DB)) === 'any_google', schoolDomains: cfg.enabled ? cfg.domains : [] });
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
    user = await verifyGoogleIdToken(body.credential, {
      clientId: cfg.clientId, domains: cfg.domains, nonce: getCookie(request, NONCE_COOKIE),
      isExtraAllowed: email => isPersonalAllowed(env, email)
    });
  } catch (e) {
    if (e instanceof AuthError) {
      const message = e.message === 'account not allowed'
        ? '此帳號尚未登記。請使用學校帳號（' + cfg.domains.map(d => '@' + d).join('、') + '），或請教學組將您的信箱加入名單'
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

async function publicRegistration({ request, env }) {
  return json(await openRegister(requireDb(env), await readJson(request)), 201);
}

async function publicCancel({ request, env }) {
  await openCancel(requireDb(env), await readJson(request));
  return json({ ok: true });
}

async function myRegistrations({ request, env }) {
  const user = await requireUser(request, env);
  return json({ registrations: await listMyRegistrations(requireDb(env), user.email) });
}

// 學生本人取消自己的報名（學生填寫模式、截止前）
async function selfCancel({ request, env, params }) {
  const user = await requireUser(request, env);
  await readJson(request);
  await selfCancelRegistration(requireDb(env), user, params[0]);
  return json({ ok: true });
}

// 導師（截止前、限自己送出的報名）或管理員：標記學生不參加
async function studentWithdraw({ request, env, params }) {
  const user = await requireUser(request, env);
  await readJson(request);
  await withdrawStudent(requireDb(env), user, params[0], params[1]);
  return json({ ok: true });
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
  const body = await readJson(request);
  const a = validateActivity(body);
  return json({ activity: await updateActivity(requireDb(env), admin, params[0], a, body.base ?? null) });
}

async function adminSetStatus({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { status } = await readJson(request);
  return json({ activity: await setActivityStatus(requireDb(env), admin, params[0], String(status || '')) });
}

async function adminBackfill({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  await readJson(request);
  return json({ result: await backfillNext(requireDb(env), admin, params[0]) });
}

async function adminCancelActivity({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { reason } = await readJson(request);
  return json({ activity: await cancelActivity(requireDb(env), admin, params[0], reason) });
}

async function adminDeleteActivity({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  await readJson(request);
  await deleteActivity(requireDb(env), admin, params[0]);
  return json({ ok: true });
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
  const survey = activity.kind === 'survey';
  const filename = encodeURIComponent(`${activity.title}-${survey ? '學生名單' : '報名名單'}.csv`);
  const rows = await listRegistrations(db, params[0]);
  return new Response(survey ? toStudentsCsv(rows, activity) : toCsv(rows), {
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

async function adminCalendar({ request, env, params }) {
  await requireAdmin(request, env);
  const activity = await getActivity(requireDb(env), params[0]);
  if (!activity) throw new HttpError(404, '找不到此活動');
  return new Response(toIcs(activity, new URL(request.url).host), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="activity.ics"; filename*=UTF-8''${encodeURIComponent(activity.title + '-行事曆.ics')}`,
      'cache-control': 'no-store'
    }
  });
}

async function adminStudentRestore({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  await readJson(request);
  await restoreStudent(requireDb(env), admin, params[0], params[1]);
  return json({ ok: true });
}

async function adminStudentPaid({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { paid } = await readJson(request);
  if (typeof paid !== 'boolean') throw new HttpError(400, 'paid 必須為 true 或 false');
  await setStudentPaid(requireDb(env), admin, params[0], params[1], paid);
  return json({ ok: true });
}

async function adminStudentRefund({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  const { refunded } = await readJson(request);
  if (typeof refunded !== 'boolean') throw new HttpError(400, 'refunded 必須為 true 或 false');
  await setStudentRefunded(requireDb(env), admin, params[0], params[1], refunded);
  return json({ ok: true });
}

async function adminGetSettings({ request, env }) {
  await requireAdmin(request, env);
  return json({ settings: await getSettings(requireDb(env)) });
}

async function adminSetSettings({ request, env }) {
  const admin = await requireAdmin(request, env);
  const { login_policy } = await readJson(request);
  await setLoginPolicy(requireDb(env), admin, login_policy);
  return json({ settings: await getSettings(requireDb(env)) });
}

async function adminListAllowed({ request, env }) {
  await requireAdmin(request, env);
  return json({ emails: await listAllowedEmails(requireDb(env)), schoolDomains: authConfig(env).domains });
}

async function adminAddAllowed({ request, env }) {
  const admin = await requireAdmin(request, env);
  const { email, note } = await readJson(request);
  await addAllowedEmail(requireDb(env), admin, email, note, authConfig(env).domains);
  return json({ ok: true }, 201);
}

async function adminBatchAllowed({ request, env }) {
  const admin = await requireAdmin(request, env);
  const { entries } = await readJson(request);
  return json({ result: await addAllowedEmailsBatch(requireDb(env), admin, entries, authConfig(env).domains) });
}

async function adminRemoveAllowed({ request, env }) {
  const admin = await requireAdmin(request, env);
  const { email } = await readJson(request);
  await removeAllowedEmail(requireDb(env), admin, email);
  return json({ ok: true });
}

// 寫入類請求只接受同源 JSON，避免跨站請求偽造。
function checkSameOrigin(request, url) {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Forbidden');
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Unsupported media type');
}
