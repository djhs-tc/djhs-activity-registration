import { HttpError } from './http.js';

// 個別允許登入的非學校信箱（例如導師慣用的 Gmail）。只有管理員能維護，每次異動寫入稽核紀錄。
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

export async function isAllowedEmail(db, email) {
  if (!db) return false;
  return Boolean(await db.prepare('SELECT 1 AS ok FROM allowed_emails WHERE email = ?1').bind(normalizeEmail(email)).first());
}

export async function listAllowedEmails(db) {
  const { results } = await db.prepare('SELECT email, note, added_by, added_at FROM allowed_emails ORDER BY added_at DESC').all();
  return results || [];
}

export async function addAllowedEmail(db, admin, rawEmail, rawNote, schoolDomains) {
  const email = normalizeEmail(rawEmail);
  const note = String(rawNote || '').trim();
  if (!EMAIL.test(email) || email.length > 100) throw new HttpError(400, '信箱格式錯誤');
  if (schoolDomains.includes(email.slice(email.lastIndexOf('@') + 1))) throw new HttpError(400, '學校帳號不需要加入名單，可直接登入');
  if (!note || note.length > 50) throw new HttpError(400, '請填寫備註（例如老師姓名，50 字以內）');
  const [res] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO allowed_emails (email, note, added_by) VALUES (?1, ?2, ?3)').bind(email, note, admin.email),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, details_json) SELECT ?1, 'allowlist_add', json_object('email', ?2, 'note', ?3) WHERE changes() = 1`
    ).bind(admin.email, email, note)
  ]);
  if (!res.meta.changes) throw new HttpError(409, '此信箱已在名單中');
}

export async function removeAllowedEmail(db, admin, rawEmail) {
  const email = normalizeEmail(rawEmail);
  const [res] = await db.batch([
    db.prepare('DELETE FROM allowed_emails WHERE email = ?1').bind(email),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, details_json) SELECT ?1, 'allowlist_remove', json_object('email', ?2) WHERE changes() = 1`
    ).bind(admin.email, email)
  ]);
  if (!res.meta.changes) throw new HttpError(404, '名單中沒有此信箱');
}
