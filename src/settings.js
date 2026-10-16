import { HttpError } from './http.js';

// 登入政策：school_only（預設）＝學校網域帳號＋帳號名單；any_google ＝所有已驗證信箱的 Google 帳號。
// 由管理員在後台切換，立即生效（非學校帳號每次請求都重新檢查）。
export const LOGIN_POLICIES = ['school_only', 'any_google'];

export async function getLoginPolicy(db) {
  if (!db) return 'school_only';
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = 'login_policy'`).first();
    return row && LOGIN_POLICIES.includes(row.value) ? row.value : 'school_only';
  } catch (_) {
    return 'school_only'; // 資料表不存在或查詢失敗時，採最嚴格的預設
  }
}

export async function setLoginPolicy(db, admin, value) {
  if (!LOGIN_POLICIES.includes(value)) throw new HttpError(400, '登入政策錯誤');
  const before = await getLoginPolicy(db);
  if (before === value) return value;
  await db.batch([
    db.prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('login_policy', ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(value, admin.email),
    db.prepare(`INSERT INTO audit_logs (actor_email, action, details_json) VALUES (?1, 'login_policy', ?2)`)
      .bind(admin.email, JSON.stringify({ from: before, to: value }))
  ]);
  return value;
}

export async function getSettings(db) {
  const row = db ? await db.prepare(`SELECT value, updated_by, updated_at FROM settings WHERE key = 'login_policy'`).first().catch(() => null) : null;
  return { login_policy: await getLoginPolicy(db), updated_by: row?.updated_by || '', updated_at: row?.updated_at || '' };
}
