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

// 回傳錯誤訊息；沒有錯誤則回傳 null
function entryError(email, note, schoolDomains) {
  if (!EMAIL.test(email) || email.length > 100) return '信箱格式錯誤';
  if (schoolDomains.includes(email.slice(email.lastIndexOf('@') + 1))) return '學校帳號不需要加入名單，可直接登入';
  if (!note || note.length > 50) return '請填寫備註（例如老師姓名，50 字以內）';
  return null;
}

export async function addAllowedEmail(db, admin, rawEmail, rawNote, schoolDomains) {
  const email = normalizeEmail(rawEmail);
  const note = String(rawNote || '').trim();
  const err = entryError(email, note, schoolDomains);
  if (err) throw new HttpError(400, err);
  const [res] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO allowed_emails (email, note, added_by) VALUES (?1, ?2, ?3)').bind(email, note, admin.email),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, details_json) SELECT ?1, 'allowlist_add', json_object('email', ?2, 'note', ?3) WHERE changes() = 1`
    ).bind(admin.email, email, note)
  ]);
  if (!res.meta.changes) throw new HttpError(409, '此信箱已在名單中');
}

export const BATCH_MAX = 300;

// 批次加入：先整批檢查，任何一筆有誤就整批不加入（回報第幾筆）；已在名單中或重複者略過。
export async function addAllowedEmailsBatch(db, admin, entries, schoolDomains) {
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, '請至少輸入一筆');
  if (entries.length > BATCH_MAX) throw new HttpError(400, `一次最多 ${BATCH_MAX} 筆`);
  const errors = [];
  const seen = new Map();
  entries.forEach((e, i) => {
    const email = normalizeEmail(e && e.email);
    const note = String((e && e.note) || '').trim();
    const err = entryError(email, note, schoolDomains);
    if (err) errors.push(`第 ${i + 1} 筆（${email || '空白'}）：${err}`);
    else if (!seen.has(email)) seen.set(email, note);
  });
  if (errors.length) throw new HttpError(400, '資料有誤，整批未加入：\n' + errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n…另有 ${errors.length - 20} 筆錯誤` : ''));

  const candidates = [...seen].map(([email, note]) => ({ email, note }));
  const { results: existing } = await db.prepare(
    `SELECT email FROM allowed_emails WHERE email IN (SELECT json_extract(value, '$.email') FROM json_each(?1))`
  ).bind(JSON.stringify(candidates)).all();
  const exists = new Set((existing || []).map(r => r.email));
  const fresh = candidates.filter(c => !exists.has(c.email));
  if (fresh.length) {
    const list = JSON.stringify(fresh);
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO allowed_emails (email, note, added_by)
         SELECT json_extract(value, '$.email'), json_extract(value, '$.note'), ?2 FROM json_each(?1)`
      ).bind(list, admin.email),
      db.prepare(
        `INSERT INTO audit_logs (actor_email, action, details_json)
         SELECT ?2, 'allowlist_add', json_object('email', json_extract(value, '$.email'), 'note', json_extract(value, '$.note'), 'batch', 1)
         FROM json_each(?1)`
      ).bind(list, admin.email)
    ]);
  }
  return {
    added: fresh.map(c => c.email),
    skipped_existing: [...exists],
    skipped_duplicates: entries.length - seen.size
  };
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
